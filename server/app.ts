import { db, stmt } from "./db.ts";
import type { ErrorCode } from "../shared/wire.ts";
import { decimals, isCurrency, CURRENCIES } from "./currencies.ts";
import { crossRate, latestProviderTimestamp } from "./fx.ts";
import { effectiveShares, expensePayload, tripBalances, journeyBalance, journeyTrips, journeyPeople, loadTripRows, loadJourneyRows, type JourneyMember } from "./ledger.ts";
import * as notify from "./notify.ts";
import { mutate, mutateTrip, mutateJourney, edited, lockRate, abort } from "./mutate.ts";
import { funBoard, journeyBoard } from "./wrapped.ts";
import { createAuth, type Mailer } from "./auth.ts";
import {
  ensureSession, linkedMember, myMember, hasAccess, accessibleTrips,
  journeyGrant, journeyAccess, grantConsent, revokeConsents, grantJourneyAccess,
  resolveTrip, resolveJourney, type TripAccess,
} from "./access.ts";
import type { Session, Member, Trip, Journey, ExpenseRow } from "./types.ts";

export type AppDeps = {
  mailer: Mailer;
  baseUrl: string;
  basePath?: string;
  dist: string;
};

export function createApp(deps: AppDeps) {
const auth = createAuth({ mailer: deps.mailer, baseUrl: deps.baseUrl });
const BASE_URL = deps.baseUrl.replace(/\/$/, "");
const BASE_PATH = (deps.basePath ?? "").replace(/\/$/, "");
const DIST = deps.dist;
const COOKIE = "wts_session";

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
const err = (status: number, error: ErrorCode, extra: object = {}) =>
  json({ error, ...extra }, { status });
const now = () => new Date().toISOString();

// Lazy prepared statements — getDb() isn't open until openDb() runs at boot.
const qMember = { get: (id: string) => stmt<Member, [string]>("SELECT * FROM members WHERE id = ?").get(id) };
const qTrip = { get: (t: string) => stmt<Trip, [string]>("SELECT * FROM trips WHERE token = ?").get(t) };
const qJourney = { get: (t: string) => stmt<Journey, [string]>("SELECT * FROM journeys WHERE token = ?").get(t) };
const qSession = { get: (t: string) => stmt<Session, [string]>("SELECT token, user_sub FROM sessions WHERE token = ?").get(t) };
const qExpense = { get: (id: string) => stmt<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(id) };
const qItem = { get: (id: string) => stmt<{ id: string; expense_id: string }, [string]>("SELECT id, expense_id FROM items WHERE id = ?").get(id) };
const qPhoto = { get: (id: string) => stmt<{ id: string; expense_id: string; mime: string; data: Uint8Array }, [string]>("SELECT id, expense_id, mime, data FROM expense_photos WHERE id = ?").get(id) };
const qSettlement = { get: (id: string) => stmt<{ id: string; trip_token: string }, [string]>("SELECT id, trip_token FROM settlements WHERE id = ?").get(id) };


const memberIsUsed = (tripToken: string, memberId: string): boolean => {
  const checks: [string, string[]][] = [
    ["SELECT COUNT(*) n FROM expenses WHERE trip_token = ? AND payer_member_id = ?", [tripToken, memberId]],
    [`SELECT COUNT(*) n FROM expense_participants p JOIN expenses e ON e.id = p.expense_id
      WHERE e.trip_token = ? AND p.member_id = ?`, [tripToken, memberId]],
    [`SELECT COUNT(*) n FROM item_sharers s JOIN items i ON i.id = s.item_id
      JOIN expenses e ON e.id = i.expense_id WHERE e.trip_token = ? AND s.member_id = ?`, [tripToken, memberId]],
    ["SELECT COUNT(*) n FROM settlements WHERE trip_token = ? AND (from_member = ? OR to_member = ?)", [tripToken, memberId, memberId]],
  ];
  return checks.some(([sql, args]) =>
    db.query<{ n: number }, string[]>(sql).get(...args)!.n > 0
  );
};


// Case-insensitive name check within a trip.
function nameTaken(tripToken: string, name: string, excludeId?: string): boolean {
  return !!db.query<{ id: string }, [string, string]>(
    "SELECT id FROM members WHERE trip_token = ? AND name = ? COLLATE NOCASE",
  ).all(tripToken, name).find((m) => m.id !== excludeId);
}
// ---------- routes ----------
type Body = Record<string, unknown>;
type Route = [RegExp, string, (req: Request, m: RegExpMatchArray, body: Body, s: Session) => Promise<Response> | Response];

const routes: Route[] = [
  [/^\/api\/config$/, "GET", async () =>
    json({ baseUrl: BASE_URL, currencies: CURRENCIES })],

  [/^\/api\/me$/, "GET", async (_req, _m, _body, s) => {
    const user = s.user_sub
      ? db.query("SELECT email, name FROM users WHERE email = ?").get(s.user_sub)
      : null;
    return json({ user });
  }],

  [/^\/api\/auth\/email$/, "POST", async (_req, _m, body) => {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "bad_email");
    const r = await auth.sendCode(email);
    if (r === "rate_limited") return err(429, "too_many_codes");
    if (r === "send_failed") return err(502, "send_failed");
    return json({ ok: true });
  }],

  [/^\/api\/auth\/email\/verify$/, "POST", async (_req, _m, body, s) => {
    const email = String(body.email ?? "").trim().toLowerCase();
    const r = await auth.checkCode(email, String(body.code ?? ""));
    if (r === "no_code") return err(400, "no_code");
    if (r === "code_expired") return err(400, "code_expired");
    if (r === "too_many_attempts") return err(429, "too_many_attempts");
    if (r === "wrong_code") return err(403, "wrong_code");
    const linked = mutate(() => {
      db.run("INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING", [email]);
      db.run("UPDATE sessions SET user_sub = ? WHERE token = ?", [email, s.token]);
      // Signing in locks the names this device already picked: each unlinked
      // claimed Member becomes a Linked Member, unless the account already has
      // a different Linked Member in that trip.
      db.run(
        `UPDATE members SET user_sub = ?
         WHERE user_sub IS NULL
           AND id IN (SELECT member_id FROM claims WHERE session_token = ?)
           AND trip_token NOT IN (SELECT trip_token FROM members WHERE user_sub = ?)`,
        [email, s.token, email],
      );
      return db.query<{ trip_token: string }, [string]>(
        "SELECT trip_token FROM claims WHERE session_token = ?",
      ).all(s.token);
    });
    if (linked instanceof Response) return linked;
    for (const { trip_token } of linked) notify.trip(trip_token);
    return json({ ok: true });
  }],

  [/^\/api\/auth\/signout$/, "POST", async (_req, _m, _body, s) => {
    db.run("UPDATE sessions SET user_sub = NULL WHERE token = ?", [s.token]);
    return json({ ok: true });
  }],

  [/^\/api\/my-trips$/, "GET", async (_req, _m, _body, s) => {
    if (!s.user_sub) return json({ trips: [] });
    return json({
      trips: db.query(
        `SELECT t.token, t.name, t.trip_currency, t.settle_currency FROM trips t
         JOIN members m ON m.trip_token = t.token WHERE m.user_sub = ?`,
      ).all(s.user_sub),
    });
  }],


  // ---- trips ----
  [/^\/api\/trips$/, "POST", async (_req, _m, body, s) => {
    const name = String(body.name ?? "").trim();
    if (!name) return err(400, "name_required");
    const tc = String(body.trip_currency ?? "").toUpperCase();
    const sc = String(body.settle_currency ?? "").toUpperCase();
    if (!isCurrency(tc) || !isCurrency(sc)) return err(400, "bad_currency");
    const pw = String(body.password ?? "").trim();
    if (!pw) return err(400, "password_required");
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    // optional pre-added members: comma/line-separated, deduped case-insensitively
    const raw = Array.isArray(body.members) ? body.members.join(",") : String(body.members ?? "");
    const seen = new Map<string, string>();
    for (const n of raw.split(/[,\n]/).map((n) => n.trim()).filter(Boolean)) {
      if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    }
    const names = [...seen.values()];
    const pwHash = await Bun.password.hash(pw);
    return mutate(() => {
      db.run(
        `INSERT INTO trips (token, name, start_date, end_date, trip_currency, settle_currency,
           password_hash, password_text, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [token, name, body.start_date ? String(body.start_date) : null, body.end_date ? String(body.end_date) : null,
         tc, sc, pwHash, pw, now()],
      );
      db.run("UPDATE trips SET created_by_token = ? WHERE token = ?", [s.token, token]);
      // creator's session counts as having entered the password
      grantConsent(s, qTrip.get(token)!);
      for (const n of names) {
        db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
          [crypto.randomUUID(), token, n, now()]);
      }
      return json({ token, url: `${BASE_URL}/#/t/${token}` });
    });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)$/, "GET", async (_req, m, _body, s) => {
    const o = resolveTrip(s, { trip: m[1] }, "view");
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = o.me;
    const rows = loadTripRows(t);
    const { members, pairs, log } = tripBalances(rows);
    return json({
      trip: {
        token: t.token, name: t.name, start_date: t.start_date, end_date: t.end_date,
        created_at: t.created_at,
        trip_currency: t.trip_currency, settle_currency: t.settle_currency,
        has_password: !!t.password_hash, password: o.edit ? t.password_text : null, fun_leaderboard: !!t.fun_leaderboard,
      },
      me: me ? { id: me.id, name: me.name, linked: !!me.user_sub, opted_out_fun: !!me.opted_out_fun } : null,
      access: o.edit ? "edit" : "view",
      signed_in: !!s.user_sub,
      is_creator: t.created_by_token !== null && t.created_by_token === s.token,
      members: members.map((mm) => ({
        id: mm.id, name: mm.name, linked: !!mm.user_sub,
        used: memberIsUsed(t.token, mm.id), opted_out_fun: !!mm.opted_out_fun,
        is_me: me?.id === mm.id,
      })),
      balances: pairs,
      journey: (() => {
        const r = db.query<{ journey_token: string; name: string }, [string]>(
          "SELECT jt.journey_token, j.name FROM journey_trips jt JOIN journeys j ON j.token = jt.journey_token WHERE jt.trip_token = ?",
        ).get(t.token);
        return r ? { token: r.journey_token, name: r.name } : null;
      })(),
      balance_log: log,
      no_rate_count: db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) n FROM expenses WHERE trip_token = ? AND rate IS NULL",
      ).get(t.token)!.n,
      unfinished_count: rows.expenses.filter((e) => {
        const assigned = effectiveShares(rows, e).reduce((a, s) => a + (s.minor ?? 0), 0);
        return e.total_minor - assigned > 0.5;
      }).length,
      expenses: rows.expenses.map((e) => expensePayload(rows, e, false)),
      settlements: db.query<{ id: string; from_member: string; to_member: string; amount_minor: number; created_at: string; created_by: string | null }, [string]>(
        "SELECT * FROM settlements WHERE trip_token = ? ORDER BY created_at DESC",
      ).all(t.token),
      fx_timestamp: latestProviderTimestamp(),
      // current FX snapshot for the trip pair (display only; expenses keep their locked rate)
      current_rate: t.trip_currency === t.settle_currency
        ? { rate: 1, providerTimestamp: null }
        : crossRate(t.trip_currency, t.settle_currency),
      fun: t.fun_leaderboard ? funBoard(rows) : null,
    });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/password$/, "POST", async (_req, m, body, s) => {
    const trip = qTrip.get(m[1]);
    if (!trip) return err(404, "trip_not_found");
    let ok = false;
    try { ok = await Bun.password.verify(String(body.password ?? ""), trip.password_hash ?? "$invalid$"); }
    catch { ok = false; }
    if (!ok) return err(403, "wrong_password");
    grantConsent(s, trip);
    return json({ ok: true });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/settings$/, "PATCH", async (_req, m, body, s) => {
    const g = resolveTrip(s, { trip: m[1] }, "edit");
    if (g instanceof Response) return g;
    const t = g.trip;
    // hash outside the transaction: db.transaction is synchronous
    const pw = body.password !== undefined ? String(body.password) : null;
    if (pw !== null && pw === "") return err(400, "password_empty");
    const pwHash = pw !== null ? await Bun.password.hash(pw) : null;
    return mutateTrip(t.token, () => {
      if (body.name !== undefined) db.run("UPDATE trips SET name = ? WHERE token = ?", [String(body.name), t.token]);
      if (body.start_date !== undefined) db.run("UPDATE trips SET start_date = ? WHERE token = ?", [body.start_date === null ? null : String(body.start_date), t.token]);
      if (body.end_date !== undefined) db.run("UPDATE trips SET end_date = ? WHERE token = ?", [body.end_date === null ? null : String(body.end_date), t.token]);
      if (body.trip_currency !== undefined || body.settle_currency !== undefined) {
        abort(err(400, "currencies_locked")); // set at creation only
      }
      if (body.fun_leaderboard !== undefined) {
        if (t.created_by_token === null || t.created_by_token !== s.token) {
          abort(err(403, "only_creator"));
        }
        db.run("UPDATE trips SET fun_leaderboard = ? WHERE token = ?", [body.fun_leaderboard ? 1 : 0, t.token]);
      }
      if (pwHash !== null) {
        db.run("UPDATE trips SET password_hash = ?, password_text = ?, password_ver = password_ver + 1 WHERE token = ?",
          [pwHash, pw, t.token]);
        // revoke all existing consents, then re-grant the acting session at the new version
        revokeConsents(t);
        grantConsent(s, qTrip.get(t.token)!);
      }
      return json({ ok: true });
    });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)$/, "DELETE", async (_req, m, body, s) => {
    const g = resolveTrip(s, { trip: m[1] }, "edit");
    if (g instanceof Response) return g;
    const t = g.trip;
    if (body.name !== t.name) return err(400, "name_mismatch");
    return mutateTrip(t.token, () => {
      db.run("DELETE FROM trips WHERE token = ?", [t.token]);
      return json({ ok: true });
    });
  }],

  // ---- members ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/claim$/, "POST", async (_req, m, body, s) => {
    const o = resolveTrip(s, { trip: m[1] }, "view");
    if (o instanceof Response) return o;
    const t = o.trip;
    const memberId = String(body.member_id ?? "");
    const newName = String(body.name ?? "").trim();
    return mutateTrip(t.token, () => {
      let member: Member | null = null;
      if (memberId) {
        member = qMember.get(memberId);
        if (!member || member.trip_token !== t.token) return err(404, "member_not_found");
        if (member.user_sub && member.user_sub !== s.user_sub)
          abort(err(403, "member_linked"));
      } else if (newName) {
        if (nameTaken(t.token, newName)) return err(409, "name_taken");
        member = {
          id: crypto.randomUUID(), trip_token: t.token, name: newName,
          user_sub: s.user_sub,
        } as Member;
        db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,?,?)",
          [member.id, t.token, newName, s.user_sub, now()]);
      } else return err(400, "member_or_name_required");
      if (s.user_sub && member.user_sub && member.user_sub !== s.user_sub)
        abort(err(403, "member_linked"));
      // signed-in user claiming/linking: enforce one linked member per trip
      if (s.user_sub) {
        const existing = linkedMember(s, t.token);
        if (existing && existing.id !== member.id) abort(err(409, "already_linked_other_member"));
        if (!member.user_sub) db.run("UPDATE members SET user_sub = ? WHERE id = ?", [s.user_sub, member.id]);
      }
      db.run("INSERT OR REPLACE INTO claims (session_token, trip_token, member_id) VALUES (?,?,?)",
        [s.token, t.token, member.id]);
      // claiming grants edit access even for journey viewers (they never typed the password)
      grantConsent(s, t);
      return json({ ok: true, member_id: member.id });
    });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/members$/, "POST", async (_req, m, body, s) => {
    const o = resolveTrip(s, { trip: m[1] }, "edit");
    if (o instanceof Response) return o;
    const name = String(body.name ?? "").trim();
    if (!name) return err(400, "name_required");
    if (nameTaken(o.trip.token, name)) return err(409, "name_taken");
    const id = crypto.randomUUID();
    return mutateTrip(o.trip.token, () => {
      db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
        [id, o.trip.token, name, now()]);
      return json({ id });
    });
  }],

  [/^\/api\/members\/([A-Za-z0-9-]+)$/, "PATCH", async (_req, m, body, s) => {
    const mem = qMember.get(m[1]);
    if (!mem) return err(404, "member_not_found");
    const o = resolveTrip(s, { trip: mem.trip_token }, "edit");
    if (o instanceof Response) return o;
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return err(400, "name_required");
      if (nameTaken(mem.trip_token, name, mem.id)) return err(409, "name_taken");
    }
    if (body.opted_out_fun !== undefined) {
      const me = o.me;
      if (!me || me.id !== mem.id) return err(403, "not_your_member");
    }
    return mutateTrip(mem.trip_token, () => {
      if (body.name !== undefined)
        db.run("UPDATE members SET name = ? WHERE id = ?", [String(body.name).trim(), mem.id]);
      if (body.opted_out_fun !== undefined)
        db.run("UPDATE members SET opted_out_fun = ? WHERE id = ?", [body.opted_out_fun ? 1 : 0, mem.id]);
      return json({ ok: true });
    });
  }],

  [/^\/api\/members\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
    const o = resolveTrip(s, { member: m[1] }, "edit");
    if (o instanceof Response) return o;
    const mem = qMember.get(m[1])!;
    if (memberIsUsed(mem.trip_token, mem.id)) return err(400, "member_in_use");
    if (mem.id === o.me?.id) return err(400, "cannot_remove_self");
    return mutateTrip(mem.trip_token, () => {
      db.run("DELETE FROM claims WHERE member_id = ?", [mem.id]);
      db.run("DELETE FROM members WHERE id = ?", [mem.id]);
      return json({ ok: true });
    });
  }],

  // counts how often the acting member opens an owe-card details modal
  [/^\/api\/trips\/([A-Za-z0-9]+)\/detail-view$/, "POST", async (_req, m, _body, s) => {
    const o = resolveTrip(s, { trip: m[1] }, "edit");
    if (o instanceof Response) return o;
    if (o.me) return mutateTrip(o.trip.token, () => {
      db.run("UPDATE members SET detail_views = detail_views + 1 WHERE id = ?", [o.me!.id]);
      return json({ ok: true });
    });
    return json({ ok: true });
  }],

  // ---- expenses ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/expenses$/, "POST", async (_req, m, body, s) => {
    const g = resolveTrip(s, { trip: m[1] }, "edit");
    if (g instanceof Response) return g;
    const { trip: t, me } = g;
    const name = String(body.name ?? "").trim();
    if (!name) return err(400, "name_required");
    const currency = String(body.currency ?? t.trip_currency).toUpperCase();
    if (!isCurrency(currency)) return err(400, "bad_currency");
    const totalMinor = Number(body.total_minor);
    if (!Number.isFinite(totalMinor) || totalMinor < 0) return err(400, "bad_total");
    const payer = body.payer_member_id ? qMember.get(String(body.payer_member_id)) : null;
    if (body.payer_member_id && (!payer || payer.trip_token !== t.token))
      return err(400, "bad_payer");
    const id = crypto.randomUUID();
    return mutateTrip(t.token, () => {
      db.run(
        `INSERT INTO expenses (id, trip_token, name, currency, total_minor, payer_member_id,
          rate, rate_provider, rate_timestamp, recorded_at, last_edited_by, last_edited_at, created_at,
          created_by_member_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, t.token, name, currency, totalMinor, payer?.id ?? null,
          null, null, null, now(), me?.name ?? null, now(), now(), me?.id ?? null],
      );
      // everyone is in by default with NULL share = equal split of the total
      for (const mm of db.query<{ id: string }, [string]>(
        "SELECT id FROM members WHERE trip_token = ?",
      ).all(t.token)) {
        db.run("INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)",
          [id, mm.id]);
      }
      lockRate(id, currency, t.settle_currency);
      return json({ id });
    });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "GET", async (_req, m, _body, s) => {
    const e = qExpense.get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = resolveTrip(s, { expense: e.id }, "view");
    if (o instanceof Response) return o;
    const t = o.trip;
    const members = db.query<Member, [string]>(
      "SELECT * FROM members WHERE trip_token = ? ORDER BY name",
    ).all(t.token);
    return json({
      expense: expensePayload(loadTripRows(t), e, true),
      trip: { token: t.token, name: t.name, settle_currency: t.settle_currency },
      access: o.edit ? "edit" : "view",
      members: members.map((mm) => ({ id: mm.id, name: mm.name })),
      me: o.me?.id ?? null,
    });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "PATCH", async (_req, m, body, s) => {
    const e = qExpense.get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const g = resolveTrip(s, { expense: e.id }, "edit");
    if (g instanceof Response) return g;
    const { trip: t, me } = g;
    return mutateTrip(t.token, () => {
      if (body.name !== undefined) db.run("UPDATE expenses SET name = ? WHERE id = ?", [String(body.name), e.id]);
      if (body.total_minor !== undefined) {
        const v = Number(body.total_minor);
        if (!Number.isFinite(v) || v < 0) abort(err(400, "bad_total"));
        db.run("UPDATE expenses SET total_minor = ? WHERE id = ?", [v, e.id]);
      }
      if (body.payer_member_id !== undefined) {
        const p = body.payer_member_id ? qMember.get(String(body.payer_member_id)) : null;
        if (body.payer_member_id && (!p || p.trip_token !== t.token)) abort(err(400, "bad_payer"));
        db.run("UPDATE expenses SET payer_member_id = ? WHERE id = ?", [p?.id ?? null, e.id]);
      }
      if (body.category !== undefined) {
        const c = body.category === null || body.category === "" ? null : String(body.category).trim();
        db.run("UPDATE expenses SET category = ? WHERE id = ?", [c, e.id]);
      }
      if (body.paid_out !== undefined) {
        // only the member acting as the payer can mark an expense all-paid;
        // implemented as marking every participant's share paid
        if (me?.id !== e.payer_member_id) abort(err(403, "payer_only"));
        db.run("UPDATE expense_participants SET paid = ? WHERE expense_id = ?", [body.paid_out ? 1 : 0, e.id]);
      }
      if (body.currency !== undefined) {
        const c = String(body.currency).toUpperCase();
        if (!isCurrency(c)) abort(err(400, "bad_currency"));
        if (c !== e.currency) {
          // the typed number stays the same, but minor units can differ:
          // re-scale total + typed shares + items when decimal places differ
          const factor = 10 ** (decimals(c) - decimals(e.currency));
          if (factor !== 1) {
            db.run("UPDATE expenses SET total_minor = ROUND(total_minor * ?) WHERE id = ?", [factor, e.id]);
            db.run("UPDATE expense_participants SET share_minor = ROUND(share_minor * ?) WHERE expense_id = ? AND share_minor IS NOT NULL", [factor, e.id]);
            db.run("UPDATE items SET price_minor = ROUND(price_minor * ?) WHERE expense_id = ?", [factor, e.id]);
          }
          lockRate(e.id, c, t.settle_currency); // re-lock rate for the new currency
        }
      }
      edited(e, me?.name ?? null);
      return json({ ok: true });
    });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
    const o = resolveTrip(s, { expense: m[1] }, "edit");
    if (o instanceof Response) return o;
    const e = qExpense.get(m[1])!;
    return mutateTrip(o.trip.token, () => {
      db.run("DELETE FROM expenses WHERE id = ?", [e.id]);
      return json({ ok: true });
    });
  }],

  // Per-person paid toggle: the payer or the person themself.
  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/paid$/, "PUT", async (_req, m, body, s) => {
    const e = qExpense.get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const g = resolveTrip(s, { expense: e.id }, "edit");
    if (g instanceof Response) return g;
    const { trip: t, me } = g;
    const mid = String(body.member_id ?? "");
    const mem = qMember.get(mid);
    if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found");
    if (me?.id !== e.payer_member_id && me?.id !== mid) return err(403, "payer_or_self_only");
    return mutateTrip(t.token, () => {
      db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor, paid) VALUES (?,?,NULL,0)", [e.id, mid]);
      db.run("UPDATE expense_participants SET paid = ? WHERE expense_id = ? AND member_id = ?", [body.paid ? 1 : 0, e.id, mid]);
      return json({ ok: true });
    });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/participants$/, "PUT", async (_req, m, body, s) => {
    const e = qExpense.get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const g = resolveTrip(s, { expense: e.id }, "edit");
    if (g instanceof Response) return g;
    const { trip: t, me } = g;
    const memberId = String(body.member_id ?? "");
    const on = !!body.on;
    const mem = qMember.get(memberId);
    if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found");
    return mutateTrip(t.token, () => {
      if (on) {
        db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, memberId]);
      } else {
        db.run("DELETE FROM expense_participants WHERE expense_id = ? AND member_id = ?", [e.id, memberId]);
        db.run(`DELETE FROM item_sharers WHERE member_id = ? AND item_id IN
          (SELECT id FROM items WHERE expense_id = ?)`, [memberId, e.id]);
      }
      edited(e, me?.name ?? null);
      return json({ ok: true });
    });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/shares$/, "PUT", async (_req, m, body, s) => {
    const e = qExpense.get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const g = resolveTrip(s, { expense: e.id }, "edit");
    if (g instanceof Response) return g;
    const { trip: t, me } = g;
    const memberId = String(body.member_id ?? "");
    const value = body.share_minor === null ? null : Number(body.share_minor);
    const mem = qMember.get(memberId);
    if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found");
    return mutateTrip(t.token, () => {
      db.run(
        `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,?)
         ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = excluded.share_minor`,
        [e.id, memberId, value],
      );
      edited(e, me?.name ?? null);
      return json({ ok: true });
    });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/split$/, "POST", async (_req, m, body, s) => {
    const e = qExpense.get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const g = resolveTrip(s, { expense: e.id }, "edit");
    if (g instanceof Response) return g;
    const { trip: t, me } = g;
    const type = String(body.type);
    const eff = effectiveShares(loadTripRows(t), e);
    const assignedEff = eff.reduce((a, s) => a + (s.minor ?? 0), 0);
    const rest = e.total_minor - assignedEff;
    return mutateTrip(t.token, () => {
      if (type === "equal_rest") {
        // distribute the unassigned remainder equally across all participants,
        // freezing typed/item shares (so remainder participants no longer absorb it)
        const memberIds = Array.isArray(body.member_ids) ? body.member_ids.map(String) : null;
        const target = memberIds?.length
          ? eff.filter((p) => memberIds.includes(p.member_id) && (p.minor ?? 0) > 0)
          : eff.filter((p) => (p.minor ?? 0) > 0);
        const n = target.length;
        if (!n || rest <= 0) return json({ ok: true });
        const each = Math.floor(rest / n);
        let leftover = rest - each * n;
        const stmt = db.prepare(
          `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,0)
           ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = expense_participants.share_minor + ?`,
        );
        for (const p of target) {
          const add = leftover > 0 ? 1 : 0;
          stmt.run(e.id, p.member_id, (p.minor ?? 0) + each + add);
          leftover -= add;
        }
      } else if (type === "proportional") {
        // spread unassigned proportionally to current effective shares (typed + items)
        const total = eff.reduce((a, s) => a + (s.minor ?? 0), 0);
        if (rest <= 0 || total <= 0) return json({ ok: true });
        let allocated = 0;
        const withShare = eff.filter((p) => (p.minor ?? 0) > 0);
        const upd = db.prepare(
          `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,0)
           ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = expense_participants.share_minor + ?`,
        );
        for (let i = 0; i < withShare.length; i++) {
          const p = withShare[i];
          const add = i === withShare.length - 1
            ? rest - allocated
            : Math.floor((p.minor! / total) * rest);
          allocated += add;
          upd.run(e.id, p.member_id, add);
        }
      } else return err(400, "bad_split_type");
      edited(e, me?.name ?? null);
      return json({ ok: true });
    });
  }],

  // ---- items ----
  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/items$/, "POST", async (_req, m, body, s) => {
    const e = qExpense.get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const g = resolveTrip(s, { expense: e.id }, "edit");
    if (g instanceof Response) return g;
    const { trip: t, me } = g;
    const name = String(body.name ?? "").trim() || "Item";
    const price = Number(body.price_minor ?? 0);
    const sharers: string[] = Array.isArray(body.sharers) ? body.sharers.map(String) : [];
    for (const mid of sharers) {
      const mm = qMember.get(mid);
      if (!mm || mm.trip_token !== t.token) return err(404, "member_not_found");
    }
    const itemId = crypto.randomUUID();
    return mutateTrip(t.token, () => {
      db.run("INSERT INTO items (id, expense_id, name, price_minor) VALUES (?,?,?,?)",
        [itemId, e.id, name, price]);
      for (const mid of sharers) {
        db.run("INSERT OR IGNORE INTO item_sharers (item_id, member_id) VALUES (?,?)", [itemId, mid]);
        db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, mid]);
      }
      edited(e, me?.name ?? null);
      return json({ id: itemId });
    });
  }],

  [/^\/api\/items\/([A-Za-z0-9-]+)$/, "PATCH", async (_req, m, body, s) => {
    const o = resolveTrip(s, { item: m[1] }, "edit");
    if (o instanceof Response) return o;
    const item = qItem.get(m[1])!;
    const e = qExpense.get(item.expense_id)!;
    if (Array.isArray(body.sharers)) {
      for (const mid of body.sharers.map(String)) {
        const mm = qMember.get(mid);
        if (!mm || mm.trip_token !== o.trip.token) return err(404, "member_not_found");
      }
    }
    return mutateTrip(o.trip.token, () => {
      if (body.name !== undefined) db.run("UPDATE items SET name = ? WHERE id = ?", [String(body.name), item.id]);
      if (body.price_minor !== undefined) db.run("UPDATE items SET price_minor = ? WHERE id = ?", [Number(body.price_minor), item.id]);
      if (Array.isArray(body.sharers)) {
        db.run("DELETE FROM item_sharers WHERE item_id = ?", [item.id]);
        for (const mid of body.sharers.map(String)) {
          db.run("INSERT OR IGNORE INTO item_sharers (item_id, member_id) VALUES (?,?)", [item.id, mid]);
          db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, mid]);
        }
      }
      edited(e, o.me?.name ?? null);
      return json({ ok: true });
    });
  }],

  [/^\/api\/items\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
    const o = resolveTrip(s, { item: m[1] }, "edit");
    if (o instanceof Response) return o;
    return mutateTrip(o.trip.token, () => {
      db.run("DELETE FROM items WHERE id = ?", [m[1]]);
      return json({ ok: true });
    });
  }],

  // ---- photos ----
  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/photos$/, "POST", async (req, m, body, s) => {
    const e = qExpense.get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = resolveTrip(s, { expense: e.id }, "edit");
    if (o instanceof Response) return o;
    const me = o.me;
    const mime = req.headers.get("content-type") ?? "application/octet-stream";
    if (!mime.startsWith("image/")) return err(400, "not_image");
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength === 0) return err(400, "empty");
    if (buf.byteLength > 10 * 1024 * 1024) return err(413, "too_large");
    const id = crypto.randomUUID();
    return mutateTrip(o.trip.token, () => {
      db.run("INSERT INTO expense_photos (id, expense_id, mime, data, created_at) VALUES (?,?,?,?,?)",
        [id, e.id, mime, buf, now()]);
      edited(e, me?.name ?? null);
      return json({ id });
    });
  }],

  // Viewers can read photos: they already see the expense payload that lists them.
  [/^\/api\/photos\/([A-Za-z0-9-]+)$/, "GET", async (_req, m, _body, s) => {
    const p = qPhoto.get(m[1]);
    if (!p) return err(404, "photo_not_found");
    const o = resolveTrip(s, { expense: p.expense_id }, "view");
    if (o instanceof Response) return o;
    return new Response(Buffer.from(p.data), { headers: { "content-type": p.mime, "cache-control": "private, max-age=3600" } });
  }],

  [/^\/api\/photos\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
    const o = resolveTrip(s, { photo: m[1] }, "edit");
    if (o instanceof Response) return o;
    const p = qPhoto.get(m[1])!;
    const e = qExpense.get(p.expense_id)!;
    return mutateTrip(o.trip.token, () => {
      db.run("DELETE FROM expense_photos WHERE id = ?", [p.id]);
      edited(e, o.me?.name ?? null);
      return json({ ok: true });
    });
  }],


  // ---- settlements ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/settlements$/, "POST", async (_req, m, body, s) => {
    const g = resolveTrip(s, { trip: m[1] }, "edit");
    if (g instanceof Response) return g;
    const { trip: t, me } = g;
    const from = qMember.get(String(body.from_member ?? ""));
    const to = qMember.get(String(body.to_member ?? ""));
    if (!from || !to || from.trip_token !== t.token || to.trip_token !== t.token || from.id === to.id)
      return err(400, "bad_members");
    const amount = Number(body.amount_minor);
    if (!Number.isFinite(amount) || amount <= 0) return err(400, "bad_amount");
    const id = crypto.randomUUID();
    return mutateTrip(t.token, () => {
      db.run("INSERT INTO settlements (id, trip_token, from_member, to_member, amount_minor, created_at, created_by) VALUES (?,?,?,?,?,?,?)",
        [id, t.token, from.id, to.id, amount, now(), me?.name ?? null]);
      return json({ id });
    });
  }],

  [/^\/api\/settlements\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
    const o = resolveTrip(s, { settlement: m[1] }, "edit");
    if (o instanceof Response) return o;
    return mutateTrip(o.trip.token, () => {
      db.run("DELETE FROM settlements WHERE id = ?", [m[1]]);
      return json({ ok: true });
    });
  }],

  // ---- journeys ----
  [/^\/api\/accessible-trips$/, "GET", async (_req, _m, _body, s) => {
    const jOf = stmt<{ journey_token: string; name: string }, [string]>(
      "SELECT jt.journey_token, j.name FROM journey_trips jt JOIN journeys j ON j.token = jt.journey_token WHERE jt.trip_token = ?");
    return json({
      trips: accessibleTrips(s).map((t) => {
        const j = jOf.get(t.token);
        return { token: t.token, name: t.name, settle_currency: t.settle_currency, journey: j ? { token: j.journey_token, name: j.name } : null };
      }),
    });
  }],

  // distinct member names across this session's accessible trips, most-used first
  [/^\/api\/member-suggestions$/, "GET", async (_req, _m, _body, s) => {
    const trips = accessibleTrips(s);
    if (!trips.length) return json({ suggestions: [] });
    const q = stmt<{ name: string; n: number }, [string]>(
      "SELECT name, COUNT(*) n FROM members WHERE trip_token = ? GROUP BY name COLLATE NOCASE");
    const counts = new Map<string, { name: string; n: number }>();
    for (const t of trips)
      for (const r of q.all(t.token)) {
        const k = r.name.toLowerCase();
        const cur = counts.get(k) ?? { name: r.name, n: 0 };
        cur.n += r.n;
        counts.set(k, cur);
      }
    return json({
      suggestions: [...counts.values()].sort((a, b) => b.n - a.n).map((x) => x.name),
    });
  }],

  [/^\/api\/journeys$/, "POST", async (_req, _m, body, s) => {
    const name = String(body.name ?? "").trim();
    const wanted = Array.isArray(body.trip_tokens) ? body.trip_tokens.map(String) : [];
    const allowed = new Map(accessibleTrips(s).map((t) => [t.token, t]));
    const picked = [...new Set(wanted)].map((t) => allowed.get(t)).filter((t): t is Trip => !!t);
    if (!picked.length) return err(400, "no_trips");
    // A Journey has no currency of its own: every trip must settle in the same one.
    const sc = picked[0].settle_currency;
    if (picked.some((t) => t.settle_currency !== sc)) return err(400, "settle_currency_mismatch");
    const tokens = picked.map((t) => t.token);
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return mutate(() => {
      db.run("INSERT INTO journeys (token, name, settle_currency, created_at) VALUES (?,?,?,?)",
        [token, name, sc, now()]);
      for (const tt of tokens)
        db.run("INSERT OR IGNORE INTO journey_trips (journey_token, trip_token) VALUES (?,?)", [token, tt]);
      return json({ token });
    });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)$/, "GET", async (_req, m, _body, s) => {
    const gj = resolveJourney(s, m[1]);
    if (gj instanceof Response) return gj;
    const j = gj.j;
    const jr = loadJourneyRows(j);
    const trips = jr.trips;
    // merge hints: same name across different trips, not already one person
    const { persons, keyOf } = journeyPeople(jr);
    const hints: { name: string; member_ids: string[]; trips: string[] }[] = [];
    const allM = trips.flatMap((tr) => tr.members.map((mm) => ({ ...mm, trip_name: tr.trip.name })));
    const byName = new Map<string, JourneyMember[]>();
    for (const mm of allM) {
      const k = mm.name.toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), mm]);
    }
    for (const [, ms] of byName) {
      const keys = new Set(ms.map((mm) => keyOf(mm)));
      if (keys.size > 1)
        hints.push({ name: ms[0].name, member_ids: ms.map((mm) => mm.id), trips: [...new Set(ms.map((mm) => mm.trip_name!))] });
    }
    const { transfers } = journeyBalance(jr);
    // Trip Wrapped waits for trip end (or 5 days after creation with no end
    // date); the journey unlocks at the latest of all its trips' dates.
    const wrappedAt = trips.length
      ? new Date(Math.max(...trips.map((tr) => Date.parse(
          tr.trip.end_date ? `${tr.trip.end_date}T23:59:59` : new Date(Date.parse(tr.trip.created_at) + 5 * 86400e3).toISOString())))).toISOString()
      : null;
    return json({
      journey: { token: j.token, name: j.name, settle_currency: j.settle_currency, fun_leaderboard: !!j.fun_leaderboard },
      signed_in: !!s.user_sub,
      wrapped_at: wrappedAt,
      fun: j.fun_leaderboard ? journeyBoard(jr) : null,
      trips: trips.map((tr) => ({
        token: tr.trip.token, name: tr.trip.name, settle_currency: tr.trip.settle_currency,
        access: hasAccess(s, tr.trip) ? "edit" : "view",
        members: tr.members.map((mm) => ({ id: mm.id, name: mm.name, linked: !!mm.user_sub, opted_out_fun: !!mm.opted_out_fun })),
        expenses: tr.expenses.map((e) => expensePayload(tr, e, false)),
      })),
      persons: [...persons.entries()].map(([k, p]) => ({ key: k, ...p })),
      members: allM.map((mm) => ({ id: mm.id, name: mm.name, trip_name: mm.trip_name, key: keyOf(mm), linked: !!mm.user_sub, opted_out_fun: !!mm.opted_out_fun })),
      mergeHints: hints,
      // member ids belonging to this session, so the client can tell
      // "who owes you" from "who you owe" inside shared transfers
      my_member_ids: allM.filter((mm) => (s.user_sub && mm.user_sub === s.user_sub) ||
        !!db.query("SELECT 1 FROM claims WHERE session_token = ? AND member_id = ?")
          .get(s.token, mm.id)).map((mm) => mm.id),
      transfers,
      // trips this session could add; mismatched currencies listed but blocked
      mergeableTrips: accessibleTrips(s)
        .filter((t) => !db.query("SELECT 1 FROM journey_trips WHERE trip_token = ?").get(t.token))
        .map((t) => ({ token: t.token, name: t.name, settle_currency: t.settle_currency })),
    });
  }],

  // journeys this session can open: via a journey-link grant or a member trip
  [/^\/api\/my-journeys$/, "GET", async (_req, _m, _body, s) => {
    const granted = db.query<{ journey_token: string }, [string]>(
      "SELECT journey_token FROM journey_access WHERE session_token = ?",
    ).all(s.token).map((r) => r.journey_token);
    const viaTrips = db.query<{ journey_token: string }, [string, string | null]>(
      `SELECT DISTINCT jt.journey_token FROM journey_trips jt
       WHERE jt.trip_token IN (
         SELECT trip_token FROM consents WHERE session_token = ?
         UNION SELECT trip_token FROM members WHERE user_sub = ?)`,
    ).all(s.token, s.user_sub).map((r) => r.journey_token);
    // filter through journeyAccess: a consent at a stale password_ver must not list
    const journeys = [...new Set([...granted, ...viaTrips])]
      .map((t) => qJourney.get(t))
      .filter((j): j is Journey => !!j && journeyAccess(s, j))
      .map((j) => ({ token: j.token, name: j.name, settle_currency: j.settle_currency }));
    return json({ journeys });
  }],
  // journey link: opening it (POST join) grants read access to every member trip
  [/^\/api\/journeys\/([A-Za-z0-9]+)\/join$/, "POST", async (_req, m, _body, s) => {
    const j = qJourney.get(m[1]);
    if (!j) return err(404, "journey_not_found");
    grantJourneyAccess(s, j);
    notify.journey(j.token);
    return json({ ok: true });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)\/trips$/, "POST", async (_req, m, body, s) => {
    const g = resolveJourney(s, m[1]);
    if (g instanceof Response) return g;
    const { j } = g;
    const tt = String(body.trip_token ?? "");
    const t = qTrip.get(tt);
    if (!t) return err(404, "trip_not_found");
    if (!hasAccess(s, t)) return err(403, "no_trip_access");
    if (db.query("SELECT 1 FROM journey_trips WHERE trip_token = ?").get(tt))
      return err(409, "already_in_journey");
    if (t.settle_currency !== j.settle_currency) return err(400, "settle_currency_mismatch");
    return mutateJourney(j.token, () => {
      db.run("INSERT INTO journey_trips (journey_token, trip_token) VALUES (?,?)", [j.token, tt]);
      return json({ ok: true });
    });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)\/trips\/([A-Za-z0-9]+)$/, "DELETE", async (_req, m, _body, s) => {
    const g = resolveJourney(s, m[1]);
    if (g instanceof Response) return g;
    const { j } = g;
    const r = mutateJourney(j.token, () => {
      db.run("DELETE FROM journey_trips WHERE journey_token = ? AND trip_token = ?", [j.token, m[2]]);
      db.run("DELETE FROM journey_merges WHERE journey_token = ? AND member_id IN (SELECT id FROM members WHERE trip_token = ?)", [j.token, m[2]]);
      return json({ ok: true });
    });
    if (!(r instanceof Response) || r.status < 400) notify.trip(m[2]);
    return r;
  }],
  [/^\/api\/journeys\/([A-Za-z0-9]+)\/merge$/, "POST", async (_req, m, body, s) => {
    const g = resolveJourney(s, m[1]);
    if (g instanceof Response) return g;
    const { j } = g;
    const ids = (Array.isArray(body.member_ids) ? body.member_ids : []).map(String);
    const inJourney = new Set(journeyTrips(j).flatMap((t) =>
      db.query<{ id: string }, [string]>("SELECT id FROM members WHERE trip_token = ?").all(t.token).map((r) => r.id)));
    const valid = ids.filter((id) => inJourney.has(id));
    if (valid.length < 2) return err(400, "need_two_members");
    // merge into the group of the first already-grouped member, else new group
    const existing = stmt<{ group_id: string }, [string, string]>(
      "SELECT group_id FROM journey_merges WHERE journey_token = ? AND member_id = ? LIMIT 1",
    );
    let gid: string | null = null;
    for (const id of valid) { const r = existing.get(j.token, id); if (r) { gid = r.group_id; break; } }
    gid ??= crypto.randomUUID();
    return mutateJourney(j.token, () => {
      for (const id of valid)
        db.run("INSERT OR REPLACE INTO journey_merges (journey_token, member_id, group_id) VALUES (?,?,?)", [j.token, id, gid]);
      return json({ ok: true, group_id: gid });
    });
  }],

  // journey settings: rename + Journey Wrapped toggle. Dissolving a journey
  // only removes the grouping — its trips are untouched.
  [/^\/api\/journeys\/([A-Za-z0-9]+)\/settings$/, "PATCH", async (_req, m, body, s) => {
    const g = resolveJourney(s, m[1]);
    if (g instanceof Response) return g;
    const { j } = g;
    const name = body.name !== undefined ? String(body.name ?? "").trim() : null;
    if (body.name !== undefined && !name) return err(400, "bad_name");
    return mutateJourney(j.token, () => {
      if (name !== null) db.run("UPDATE journeys SET name = ? WHERE token = ?", [name, j.token]);
      if (body.fun_leaderboard !== undefined)
        db.run("UPDATE journeys SET fun_leaderboard = ? WHERE token = ?", [body.fun_leaderboard ? 1 : 0, j.token]);
      return json({ ok: true });
    });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)$/, "DELETE", async (_req, m, body, s) => {
    const g = resolveJourney(s, m[1]);
    if (g instanceof Response) return g;
    const { j } = g;
    if (String(body.name ?? "") !== j.name) return err(400, "name_mismatch");
    const trips = journeyTrips(j);
    const r = mutateJourney(j.token, () => {
      db.run("DELETE FROM journey_merges WHERE journey_token = ?", [j.token]);
      db.run("DELETE FROM journey_access WHERE journey_token = ?", [j.token]);
      db.run("DELETE FROM journey_trips WHERE journey_token = ?", [j.token]);
      db.run("DELETE FROM journeys WHERE token = ?", [j.token]);
      return json({ ok: true });
    });
    // journey fan-out pings member trips already; the removed trips are gone
    // from journey_trips, so ping them explicitly too
    for (const t of trips) notify.trip(t.token);
    return r;
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)\/merge\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
    const g = resolveJourney(s, m[1]);
    if (g instanceof Response) return g;
    const { j } = g;
    return mutateJourney(j.token, () => {
      db.run("DELETE FROM journey_merges WHERE journey_token = ? AND member_id = ?", [j.token, m[2]]);
      return json({ ok: true });
    });
  }],

  // ---- SSE ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/events$/, "GET", async (_req, m, _body, s) => {
    // Viewers get live updates too — they can read the trip, so they can watch it.
    const o = resolveTrip(s, { trip: m[1] }, "view");
    if (o instanceof Response) return o;
    const token = o.trip.token;
    let ctrl!: ReadableStreamDefaultController;
    const stream = new ReadableStream({
      start(c) {
        ctrl = c;
        c.enqueue(": connected\n\n");
        notify.addListener(token, c);
      },
      cancel() {
        notify.removeListener(token, ctrl);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }],
];

// ---------- server ----------
async function handle(req: Request): Promise<Response> {
  if (req.method !== "GET" && !req.headers.get("x-wts")) {
    return err(403, "missing_header"); // cheap CSRF guard for cookie auth
  }

  let body: Body = {};
  if (req.method !== "GET" && req.headers.get("content-type")?.includes("json")) {
    try { body = await req.json(); } catch { return err(400, "bad_json"); }
  }

  const url = new URL(req.url);
  let path = url.pathname;
  if (BASE_PATH) {
    if (path === BASE_PATH) path = "/";
    else if (path.startsWith(BASE_PATH + "/")) path = path.slice(BASE_PATH.length);
    else return err(404, "not_found");
  }
  const isApi = path.startsWith("/api/");
  // Session resolved once: handlers receive `s`; the cookie rides out on any response.
  const { session, headers: sessionHeaders } = isApi
    ? ensureSession(req)
    : { session: null as Session | null, headers: {} };

  for (const [re, method, fn] of routes) {
    const m = re.exec(path);
    if (m && req.method === method) {
      const res = await fn(req, m, body, session!);
      const sc = (sessionHeaders as Record<string, string>)["set-cookie"];
      if (sc && !res.headers.has("set-cookie")) res.headers.set("set-cookie", sc);
      return res;
    }
  }
  if (isApi) return err(404, "not_found");

  // static
  const file = path === "/" ? "/index.html" : path;
  const f = Bun.file(DIST + file);
  if (await f.exists()) return new Response(f);
  return new Response(Bun.file(DIST + "/index.html")); // SPA fallback
}

return handle;
}
