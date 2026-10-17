import { db } from "./db.ts";

const OXR_APP_ID = process.env.OXR_APP_ID ?? "";
const FETCH_MS = 24 * 60 * 60 * 1000; // daily — Frankfurter rates are daily anyway;
// with OXR the locked-rate snapshot just gets up to a day stale.

// Fetch USD->all from Open Exchange Rates and store in fx_latest.
// Without an App ID (or when OXR fails) we fall back to Frankfurter
// (keyless, daily rates). Callers always fall back to whatever is stored.
export async function refreshRates(): Promise<boolean> {
  if (process.env.FX_OFFLINE) { backfillMissingRates(); return false; }
  const ok = OXR_APP_ID ? await refreshFromOxr() : false;
  if (!ok) await refreshFromFrankfurter();
  backfillMissingRates();
  return ok;
}

async function refreshFromOxr(): Promise<boolean> {
  try {
    const res = await fetch(
      `https://openexchangerates.org/api/latest.json?app_id=${OXR_APP_ID}`,
    );
    if (!res.ok) return false;
    const data = (await res.json()) as {
      timestamp: number;
      rates: Record<string, number>;
    };
    if (!data.rates || typeof data.timestamp !== "number") return false;
    storeRates(data.rates, new Date(data.timestamp * 1000).toISOString());
    return true;
  } catch {
    return false;
  }
}

async function refreshFromFrankfurter(): Promise<boolean> {
  try {
    const res = await fetch("https://api.frankfurter.dev/v2/rates?base=USD");
    if (!res.ok) return false;
    // v2 returns an array of { date, base, quote, rate }
    const data = (await res.json()) as { date: string; quote: string; rate: number }[];
    if (!Array.isArray(data) || data.length === 0) return false;
    const rates: Record<string, number> = { USD: 1 };
    for (const r of data) rates[r.quote] = r.rate;
    storeRates(rates, data[0].date);
    return true;
  } catch {
    return false;
  }
}

function storeRates(rates: Record<string, number>, providerTs: string) {
  const fetchedAt = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO fx_latest (code, usd_rate, provider_timestamp, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       usd_rate = excluded.usd_rate,
       provider_timestamp = excluded.provider_timestamp,
       fetched_at = excluded.fetched_at`,
  );
  // overwrite existing rows only when the incoming provider timestamp is
  // not older than the stored one, so a daily fallback never downgrades
  // an hourly OXR snapshot
  const tx = db.transaction(() => {
    for (const [code, rate] of Object.entries(rates)) {
      if (typeof rate !== "number" || !Number.isFinite(rate)) continue;
      const cur = db.query<{ provider_timestamp: string }, [string]>(
        "SELECT provider_timestamp FROM fx_latest WHERE code = ?",
      ).get(code);
      if (cur && cur.provider_timestamp > providerTs) continue;
      stmt.run(code, rate, providerTs, fetchedAt);
    }
  });
  tx();
}

// Expenses created while no rates were available get locked at the first
// snapshot we do have (best available after the fact).
function backfillMissingRates() {
  const rows = db.query<{ id: string; currency: string; settle: string }, []>(
    `SELECT e.id, e.currency, t.settle_currency AS settle
     FROM expenses e JOIN trips t ON t.token = e.trip_token
     WHERE e.rate IS NULL`,
  ).all();
  for (const r of rows) {
    const rate = r.currency === r.settle ? 1 : (crossRate(r.currency, r.settle)?.rate ?? null);
    if (rate !== null) {
      db.run(
        "UPDATE expenses SET rate = ?, rate_provider = 'backfilled', rate_timestamp = ? WHERE id = ?",
        [rate, new Date().toISOString(), r.id],
      );
    }
  }
}

export function startFxLoop() {
  refreshRates();
  setInterval(refreshRates, FETCH_MS).unref();
}

export type RateInfo = {
  rate: number;
  provider: string;
  providerTimestamp: string | null;
};

// rate = units of `to` per 1 unit of `from`, via the stored USD base.
export function crossRate(from: string, to: string): RateInfo | null {
  const row = (code: string) =>
    db
      .query<{ usd_rate: number; provider_timestamp: string }, [string]>(
        "SELECT usd_rate, provider_timestamp FROM fx_latest WHERE code = ?",
      )
      .get(code);
  const f = row(from);
  const t = row(to);
  if (!f || !t) return null;
  const [maxTs, minTs] = [f.provider_timestamp, t.provider_timestamp].sort();
  return {
    rate: t.usd_rate / f.usd_rate,
    provider: "openexchangerates",
    providerTimestamp: minTs,
  };
}

export function latestProviderTimestamp(): string | null {
  const row = db
    .query<{ p: string }, []>(
      "SELECT provider_timestamp AS p FROM fx_latest LIMIT 1",
    )
    .get();
  return row?.p ?? null;
}
