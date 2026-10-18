import { db } from "./db.ts";
import { decimals, isCurrency, CURRENCIES } from "./currencies.ts";
import { crossRate, startFxLoop, latestProviderTimestamp } from "./fx.ts";
import { seedDemo, DEMO_TOKEN } from "./demo.ts";
import { effectiveShares, expensePayload, tripBalances, journeyBalance, journeyTrips, journeyPeople, paidMembers, type JourneyMember } from "./ledger.ts";
import * as notify from "./notify.ts";
import { funBoard, journeyBoard } from "./wrapped.ts";
import type { Session, Member, Trip, Journey, ExpenseRow } from "./types.ts";

const PORT = Number(process.env.PORT ?? 8081);

const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
// Serve under a path prefix when set (e.g. BASE_PATH=/watsthesplit on jiathe.dev).
// The tunnel forwards unprefixed-path URLs, so we strip it before routing.
const BASE_PATH = (process.env.BASE_PATH ?? "").replace(/\/$/, "");
const COOKIE = "wts_session";
const DIST = new URL("../dist", import.meta.url).pathname;

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
const err = (status: number, error: string, extra: object = {}) =>
  json({ error, ...extra }, { status });
const now = () => new Date().toISOString();

const qMember = db.prepare<Member, [string]>("SELECT * FROM members WHERE id = ?");
const qTrip = db.prepare<Trip, [string]>("SELECT * FROM trips WHERE token = ?");
const qJourney = db.prepare<Journey, [string]>("SELECT * FROM journeys WHERE token = ?");
const qSession = db.prepare<Session, [string]>(
  "SELECT token, user_sub FROM sessions WHERE token = ?",
);
const reqSessions = new WeakMap<Request, Session>();

function sessionFrom(req: Request): Session | null {
  const cached = reqSessions.get(req);
  if (cached) return cached;
  const m = /(?:^|;\s*)wts_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  if (!m) return null;
  return qSession.get(decodeURIComponent(m[1])) ?? null;
}

function ensureSession(req: Request): { session: Session; headers: HeadersInit } {
  const s = sessionFrom(req);
  if (s) return { session: s, headers: {} };
  const token = crypto.randomUUID();
  db.run("INSERT INTO sessions (token, user_sub, created_at) VALUES (?, NULL, ?)", [
    token, now(),
  ]);
  const session = { token, user_sub: null };
  reqSessions.set(req, session);
  return {
    session,
    headers: { "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` },
  };
}

const linkedMember = (s: Session, tripToken: string) =>
  s.user_sub
    ? db.query<Member, [string, string]>(
        "SELECT * FROM members WHERE trip_token = ? AND user_sub = ?",
      ).get(tripToken, s.user_sub) ?? null
    : null;

function myMember(s: Session, trip: Trip): Member | null {
  const l = linkedMember(s, trip.token);
  if (l) return l;
  const claim = db.query<{ member_id: string }, [string, string]>(
    "SELECT member_id FROM claims WHERE session_token = ? AND trip_token = ?",
  ).get(s.token, trip.token);
  return claim ? qMember.get(claim.member_id) ?? null : null;
}

// Password access: Linked members are exempt; others need consent at the
// current password version.
function hasAccess(s: Session, trip: Trip): boolean {
  if (!trip.password_hash) return true;
  if (linkedMember(s, trip.token)) return true;
  const c = db.query<{ password_ver: number }, [string, string]>(
    "SELECT password_ver FROM consents WHERE session_token = ? AND trip_token = ?",
  ).get(s.token, trip.token);
  return c?.password_ver === trip.password_ver;
}


// Trips the session may open (used for the journey trip-picker and access).
function accessibleTrips(s: Session): Trip[] {
  const consented = db.query<{ trip_token: string }, [string]>(
    "SELECT trip_token FROM consents WHERE session_token = ?",
  ).all(s.token).map((r) => r.trip_token);
  const linked = s.user_sub
    ? db.query<{ trip_token: string }, [string]>(
        "SELECT trip_token FROM members WHERE user_sub = ?",
      ).all(s.user_sub).map((r) => r.trip_token)
    : [];
  const tokens = [...new Set([...consented, ...linked])];
  return tokens.map((t) => qTrip.get(t)).filter((t): t is Trip => !!t && hasAccess(s, t));
}

// Journey viewer: session opened a shared journey link (grant) or can already
// open a member trip. Trip access implies journey access, not vice versa.
function journeyGrant(s: Session, journeyToken: string): boolean {
  return !!db.query("SELECT 1 FROM journey_access WHERE session_token = ? AND journey_token = ?")
    .get(s.token, journeyToken);
}
function journeyAccess(s: Session, j: Journey): boolean {
  return journeyGrant(s, j.token) || journeyTrips(j).some((t) => hasAccess(s, t));
}

// A journey link grants read access to all member trips; edit still needs
// the trip's own password or a member claim (which grants edit access).
function canViewTrip(s: Session, trip: Trip): boolean {
  if (hasAccess(s, trip)) return true;
  const jt = db.query<{ journey_token: string }, [string]>(
    "SELECT journey_token FROM journey_trips WHERE trip_token = ?",
  ).get(trip.token);
  return !!jt && journeyGrant(s, jt.journey_token);
}

// Route guards: session -> entity -> access -> acting member.
// Each returns the context, or a Response the route returns as-is.
type TripCtx = { s: Session; t: Trip; me: Member | null };
function withTrip(req: Request, token: string): TripCtx | Response {
  const s = sessionFrom(req)!;
  const o = openTrip(token, s);
  if (o instanceof Response) return o;
  return { s, t: o.trip, me: myMember(s, o.trip) };
}
type ExpenseCtx = TripCtx & { e: ExpenseRow };
function withExpense(req: Request, id: string): ExpenseCtx | Response {
  const s = sessionFrom(req)!;
  const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(id);
  if (!e) return err(404, "expense_not_found");
  const o = openTrip(e.trip_token, s);
  if (o instanceof Response) return o;
  return { s, e, t: o.trip, me: myMember(s, o.trip) };
}
function withJourney(req: Request, token: string): { s: Session; j: Journey } | Response {
  const s = sessionFrom(req)!;
  const j = qJourney.get(token);
  if (!j) return err(404, "journey_not_found");
  if (!journeyAccess(s, j)) return err(403, "no_access");
  return { s, j };
}


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

// ---------- domain payload builders ----------

// ---------- SSE ----------
// ---------- helpers ----------
function edited(e: { id: string }, memberName: string | null) {
  db.run("UPDATE expenses SET last_edited_by = ?, last_edited_at = ? WHERE id = ?", [
    memberName, now(), e.id,
  ]);
}

function lockRate(eId: string, currency: string, settle: string): void {
  const r = currency === settle ? { rate: 1, provider: "same-currency", providerTimestamp: null } : crossRate(currency, settle);
  db.run(
    "UPDATE expenses SET currency = ?, rate = ?, rate_provider = ?, rate_timestamp = ? WHERE id = ?",
    [currency, r?.rate ?? null, r?.provider ?? null, r?.providerTimestamp ?? null, eId],
  );
}

// ---------- email-code sign-in ----------
// 4-char code from an unambiguous alphabet, emailed to the user. Codes are
// stored hashed, expire after 10 minutes, allow 5 verify attempts, and are
// single-use. Rate-limited to 3 sends per email per hour.
const CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const sendLog = new Map<string, number[]>(); // email -> send timestamps (in-memory)

function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return [...b].map((x) => CODE_ALPHA[x % CODE_ALPHA.length]).join("");
}

async function sendCodeEmail(email: string, code: string): Promise<void> {
  const subject = `Your WatsTheSplit code: ${code}`;
  const text = `Your sign-in code is ${code} (valid 10 minutes).\n\nOpen WatsTheSplit: ${BASE_URL}/\n`;
  const key = process.env.RESEND_API_KEY ?? "";
  if (!key) { console.log(`[email:dev] to ${email}: ${code}`); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? "WatsTheSplit <onboarding@resend.dev>",
      to: [email], subject, text,
    }),
  });
  if (!res.ok) throw new Error(`resend_${res.status}`);
}

type Ctx = { session: Session; trip: Trip; member: Member | null };

function openTrip(token: string, s: Session): { trip: Trip } | Response {
  const trip = qTrip.get(token);
  if (!trip) return err(404, "trip_not_found");
  if (!hasAccess(s, trip)) return err(401, "password_required", { protected: true });
  return { trip };
}

// Read-only variant of openTrip: trip link members plus journey viewers.
function openTripView(token: string, s: Session): { trip: Trip; edit: boolean } | Response {
  const trip = qTrip.get(token);
  if (!trip) return err(404, "trip_not_found");
  if (hasAccess(s, trip)) return { trip, edit: true };
  if (canViewTrip(s, trip)) return { trip, edit: false };
  return err(401, "password_required", { protected: true });
}

// Case-insensitive name check within a trip.
function nameTaken(tripToken: string, name: string, excludeId?: string): boolean {
  return !!db.query<{ id: string }, [string, string]>(
    "SELECT id FROM members WHERE trip_token = ? AND name = ? COLLATE NOCASE",
  ).all(tripToken, name).find((m) => m.id !== excludeId);
}
// ---------- routes ----------
type Body = Record<string, unknown>;
type Route = [RegExp, string, (req: Request, m: RegExpMatchArray, body: Body) => Promise<Response> | Response];

const routes: Route[] = [
  [/^\/api\/config$/, "GET", async () =>
    json({ baseUrl: BASE_URL, currencies: CURRENCIES })],

  [/^\/api\/me$/, "GET", async (req) => {
    const s = sessionFrom(req);
    if (!s) return json({ user: null });
    const user = s.user_sub
      ? db.query("SELECT email, name FROM users WHERE email = ?").get(s.user_sub)
      : null;
    return json({ user });
  }],

  [/^\/api\/auth\/email$/, "POST", async (_req, _m, body) => {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "bad_email");
    // 3 sends per email per hour
    const nowMs = Date.now();
    const sends = (sendLog.get(email) ?? []).filter((t) => nowMs - t < 3600e3);
    if (sends.length >= 3) return err(429, "too_many_codes");
    sends.push(nowMs); sendLog.set(email, sends);
    const code = newCode();
    try { await sendCodeEmail(email, code); }
    catch { return err(502, "send_failed"); }
    db.run(
      "INSERT OR REPLACE INTO email_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?,?,?,0,?)",
      [email, await Bun.password.hash(code), new Date(nowMs + CODE_TTL_MS).toISOString(), now()],
    );
    return json({ ok: true });
  }],

  [/^\/api\/auth\/email\/verify$/, "POST", async (req, _m, body) => {
    const email = String(body.email ?? "").trim().toLowerCase();
    const row = db.query<{ code_hash: string; expires_at: string; attempts: number }, [string]>(
      "SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?",
    ).get(email);
    if (!row) return err(400, "no_code");
    if (Date.parse(row.expires_at) < Date.now()) return err(400, "code_expired");
    if (row.attempts >= CODE_MAX_ATTEMPTS) return err(429, "too_many_attempts");
    const ok = await Bun.password.verify(String(body.code ?? "").trim().toUpperCase(), row.code_hash);
    if (!ok) {
      db.run("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?", [email]);
      return err(403, "wrong_code");
    }
    db.run("DELETE FROM email_codes WHERE email = ?", [email]);
    db.run("INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING", [email]);
    const { session, headers } = ensureSession(req);
    db.run("UPDATE sessions SET user_sub = ? WHERE token = ?", [email, session.token]);
    // Signing in locks the names this device already picked: each unlinked
    // claimed Member becomes a Linked Member, unless the account already has
    // a different Linked Member in that trip.
    db.run(
      `UPDATE members SET user_sub = ?
       WHERE user_sub IS NULL
         AND id IN (SELECT member_id FROM claims WHERE session_token = ?)
         AND trip_token NOT IN (SELECT trip_token FROM members WHERE user_sub = ?)`,
      [email, session.token, email],
    );
    for (const { trip_token } of db.query<{ trip_token: string }, [string]>(
      "SELECT trip_token FROM claims WHERE session_token = ?",
    ).all(session.token)) notify.trip(trip_token);
    return json({ ok: true }, { headers });
  }],

  [/^\/api\/auth\/signout$/, "POST", async (req) => {
    const s = sessionFrom(req);
    if (s) db.run("UPDATE sessions SET user_sub = NULL WHERE token = ?", [s.token]);
    return json({ ok: true });
  }],

  [/^\/api\/my-trips$/, "GET", async (req) => {
    const s = sessionFrom(req);
    if (!s?.user_sub) return json({ trips: [] });
    return json({
      trips: db.query(
        `SELECT t.token, t.name, t.trip_currency, t.settle_currency FROM trips t
         JOIN members m ON m.trip_token = t.token WHERE m.user_sub = ?`,
      ).all(s.user_sub),
    });
  }],

  // ---- trips ----
  [/^\/api\/trips$/, "POST", async (req, _m, body) => {
    const { session, headers } = ensureSession(req);
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
    db.run(
      `INSERT INTO trips (token, name, start_date, end_date, trip_currency, settle_currency,
         password_hash, password_text, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [token, name, body.start_date ? String(body.start_date) : null, body.end_date ? String(body.end_date) : null,
       tc, sc, await Bun.password.hash(pw), pw, now()],
    );
    db.run("UPDATE trips SET created_by_token = ? WHERE token = ?", [session.token, token]);
    // creator's session counts as having entered the password (ver starts at 0)
    db.run("INSERT OR REPLACE INTO consents (session_token, trip_token, password_ver) VALUES (?,?,0)",
      [session.token, token]);
    for (const n of names) {
      db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
        [crypto.randomUUID(), token, n, now()]);
    }
    return json({ token, url: `${BASE_URL}/#/t/${token}` }, { headers });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const o = openTripView(m[1], s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    const { members, pairs, log } = tripBalances(t);
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
      unfinished_count: db.query<ExpenseRow, [string]>(
        "SELECT * FROM expenses WHERE trip_token = ?",
      ).all(t.token).filter((e) => {
        const assigned = effectiveShares(e).reduce((a, s) => a + (s.minor ?? 0), 0);
        return e.total_minor - assigned > 0.5;
      }).length,
      expenses: db.query<ExpenseRow, [string]>(
        "SELECT * FROM expenses WHERE trip_token = ? ORDER BY recorded_at DESC",
      ).all(t.token).map((e) => expensePayload(e, false)),
      settlements: db.query<{ id: string; from_member: string; to_member: string; amount_minor: number; created_at: string; created_by: string | null }, [string]>(
        "SELECT * FROM settlements WHERE trip_token = ? ORDER BY created_at DESC",
      ).all(t.token),
      fx_timestamp: latestProviderTimestamp(),
      // current FX snapshot for the trip pair (display only; expenses keep their locked rate)
      current_rate: t.trip_currency === t.settle_currency
        ? { rate: 1, providerTimestamp: null }
        : crossRate(t.trip_currency, t.settle_currency),
      fun: t.fun_leaderboard ? funBoard(t) : null,
    });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/password$/, "POST", async (req, m, body) => {
    // ensureSession (not sessionFrom): this can be the client's very first call
    // when a ?pw= share link opens straight to a locked trip.
    const { session: s, headers } = ensureSession(req);
    const trip = qTrip.get(m[1]);
    if (!trip) return err(404, "trip_not_found");
    let ok = false;
    try { ok = await Bun.password.verify(String(body.password ?? ""), trip.password_hash ?? "$invalid$"); }
    catch { ok = false; }
    if (!ok) return err(403, "wrong_password");
    db.run("INSERT OR REPLACE INTO consents (session_token, trip_token, password_ver) VALUES (?,?,?)",
      [s.token, trip.token, trip.password_ver]);
    return json({ ok: true }, { headers });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/settings$/, "PATCH", async (req, m, body) => {
    const g = withTrip(req, m[1]);
    if (g instanceof Response) return g;
    const { s, t, me } = g;
    if (body.name !== undefined) db.run("UPDATE trips SET name = ? WHERE token = ?", [String(body.name), t.token]);
    if (body.start_date !== undefined) db.run("UPDATE trips SET start_date = ? WHERE token = ?", [body.start_date === null ? null : String(body.start_date), t.token]);
    if (body.end_date !== undefined) db.run("UPDATE trips SET end_date = ? WHERE token = ?", [body.end_date === null ? null : String(body.end_date), t.token]);
    if (body.trip_currency !== undefined || body.settle_currency !== undefined) {
      return err(400, "currencies_locked"); // set at creation only
    }
    if (body.fun_leaderboard !== undefined) {
      if (t.created_by_token === null || t.created_by_token !== s.token) {
        return err(403, "only_creator");
      }
      db.run("UPDATE trips SET fun_leaderboard = ? WHERE token = ?", [body.fun_leaderboard ? 1 : 0, t.token]);
    }
    if (body.password !== undefined) {
      const pw = String(body.password);
      if (pw === "") {
        return err(400, "password_required"); // trips must keep a password
      } else {
        db.run("UPDATE trips SET password_hash = ?, password_text = ?, password_ver = password_ver + 1 WHERE token = ?",
          [await Bun.password.hash(pw), pw, t.token]);
        // revoke all existing consents, then re-grant the acting session at the new version
        db.run("DELETE FROM consents WHERE trip_token = ?", [t.token]);
        const ver = db.query<{ password_ver: number }, [string]>(
          "SELECT password_ver FROM trips WHERE token = ?",
        ).get(t.token)!.password_ver;
        db.run("INSERT OR REPLACE INTO consents (session_token, trip_token, password_ver) VALUES (?,?,?)",
          [s.token, t.token, ver]);
      }
    }
    notify.trip(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)$/, "DELETE", async (req, m, body) => {
    const g = withTrip(req, m[1]);
    if (g instanceof Response) return g;
    const { s, t, me } = g;
    if (body.name !== t.name) return err(400, "name_mismatch");
    db.run("DELETE FROM trips WHERE token = ?", [t.token]);
    notify.trip(t.token);
    return json({ ok: true });
  }],

  // ---- members ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/claim$/, "POST", async (req, m, body) => {
    const { session: s, headers } = ensureSession(req);
    const o = openTripView(m[1], s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const memberId = String(body.member_id ?? "");
    const newName = String(body.name ?? "").trim();
    let member: Member | null = null;
    if (memberId) {
      member = qMember.get(memberId);
      if (!member || member.trip_token !== t.token) return err(404, "member_not_found");
      if (member.user_sub && member.user_sub !== s.user_sub)
        return err(403, "member_linked");
    } else if (newName) {
      if (nameTaken(t.token, newName)) return err(409, "name_taken");
      member = {
        id: crypto.randomUUID(), trip_token: t.token, name: newName,
        user_sub: s.user_sub,
      };
      db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,?,?)",
        [member.id, t.token, newName, s.user_sub, now()]);
    } else return err(400, "member_or_name_required");
    if (s.user_sub && member.user_sub && member.user_sub !== s.user_sub)
      return err(403, "member_linked");
    // signed-in user claiming/linking: enforce one linked member per trip
    if (s.user_sub) {
      const existing = linkedMember(s, t.token);
      if (existing && existing.id !== member.id) return err(409, "already_linked_other_member");
      if (!member.user_sub) db.run("UPDATE members SET user_sub = ? WHERE id = ?", [s.user_sub, member.id]);
    }
    db.run("INSERT OR REPLACE INTO claims (session_token, trip_token, member_id) VALUES (?,?,?)",
      [s.token, t.token, member.id]);
    // claiming grants edit access even for journey viewers (they never typed the password)
    db.run("INSERT OR REPLACE INTO consents (session_token, trip_token, password_ver) VALUES (?,?,?)",
      [s.token, t.token, t.password_ver]);
    notify.trip(t.token);
    return json({ ok: true, member_id: member.id }, { headers });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/members$/, "POST", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const name = String(body.name ?? "").trim();
    if (nameTaken(o.trip.token, name)) return err(409, "name_taken");
    if (!name) return err(400, "name_required");
    const id = crypto.randomUUID();
    db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
      [id, o.trip.token, name, now()]);
    notify.trip(o.trip.token);
    return json({ id });
  }],

  [/^\/api\/members\/([A-Za-z0-9-]+)$/, "PATCH", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const mem = qMember.get(m[1]);
    if (!mem) return err(404, "member_not_found");
    const o = openTrip(mem.trip_token, s);
    if (o instanceof Response) return o;
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return err(400, "name_required");
      if (nameTaken(mem.trip_token, name, mem.id)) return err(409, "name_taken");
      db.run("UPDATE members SET name = ? WHERE id = ?", [name, mem.id]);
    }
    if (body.opted_out_fun !== undefined) {
      const me = myMember(s, o.trip);
      if (!me || me.id !== mem.id) return err(403, "not_your_member");
      db.run("UPDATE members SET opted_out_fun = ? WHERE id = ?", [body.opted_out_fun ? 1 : 0, mem.id]);
    }
    notify.trip(mem.trip_token);
    return json({ ok: true });
  }],

  [/^\/api\/members\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const mem = qMember.get(m[1]);
    if (!mem) return err(404, "member_not_found");
    const o = openTrip(mem.trip_token, s);
    if (o instanceof Response) return o;
    if (memberIsUsed(mem.trip_token, mem.id)) return err(400, "member_in_use");
    if (mem.id === myMember(s, o.trip)?.id) return err(400, "cannot_remove_self");
    db.run("DELETE FROM claims WHERE member_id = ?", [mem.id]);
    db.run("DELETE FROM members WHERE id = ?", [mem.id]);
    notify.trip(mem.trip_token);
    return json({ ok: true });
  }],

  // counts how often the acting member opens an owe-card details modal
  [/^\/api\/trips\/([A-Za-z0-9]+)\/detail-view$/, "POST", async (req, m) => {
    const s = sessionFrom(req)!;
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const me = myMember(s, o.trip);
    if (me) db.run("UPDATE members SET detail_views = detail_views + 1 WHERE id = ?", [me.id]);
    return json({ ok: true });
  }],

  // ---- expenses ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/expenses$/, "POST", async (req, m, body) => {
    const g = withTrip(req, m[1]);
    if (g instanceof Response) return g;
    const { s, t, me } = g;
    const name = String(body.name ?? "").trim();
    if (!name) return err(400, "name_required");
    const currency = String(body.currency ?? t.trip_currency).toUpperCase();
    if (!isCurrency(currency)) return err(400, "bad_currency");
    const totalMinor = Number(body.total_minor);
    if (!Number.isFinite(totalMinor) || totalMinor < 0) return err(400, "bad_total");
    const payer = body.payer_member_id ? qMember.get(String(body.payer_member_id)) : null;
    const id = crypto.randomUUID();
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
    notify.trip(t.token);
    return json({ id });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTripView(e.trip_token, s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const members = db.query<Member, [string]>(
      "SELECT * FROM members WHERE trip_token = ? ORDER BY name",
    ).all(t.token);
    return json({
      expense: expensePayload(e, true),
      trip: { token: t.token, name: t.name, settle_currency: t.settle_currency },
      access: o.edit ? "edit" : "view",
      members: members.map((mm) => ({ id: mm.id, name: mm.name })),
      me: s.token ? (myMember(s, t)?.id ?? null) : null,
    });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "PATCH", async (req, m, body) => {
    const g = withExpense(req, m[1]);
    if (g instanceof Response) return g;
    const { s, e, t, me } = g;
    if (body.name !== undefined) db.run("UPDATE expenses SET name = ? WHERE id = ?", [String(body.name), e.id]);
    if (body.total_minor !== undefined) {
      const v = Number(body.total_minor);
      if (!Number.isFinite(v) || v < 0) return err(400, "bad_total");
      db.run("UPDATE expenses SET total_minor = ? WHERE id = ?", [v, e.id]);
    }
    if (body.payer_member_id !== undefined) {
      const p = body.payer_member_id ? qMember.get(String(body.payer_member_id)) : null;
      if (body.payer_member_id && (!p || p.trip_token !== t.token)) return err(400, "bad_payer");
      db.run("UPDATE expenses SET payer_member_id = ? WHERE id = ?", [p?.id ?? null, e.id]);
    }
    if (body.category !== undefined) {
      const c = body.category === null || body.category === "" ? null : String(body.category).trim();
      db.run("UPDATE expenses SET category = ? WHERE id = ?", [c, e.id]);
    }
    if (body.paid_out !== undefined) {
      // only the member acting as the payer can mark an expense all-paid;
      // implemented as marking every participant's share paid
      if (me?.id !== e.payer_member_id) return err(403, "payer_only");
      db.run("UPDATE expense_participants SET paid = ? WHERE expense_id = ?", [body.paid_out ? 1 : 0, e.id]);
    }
    if (body.currency !== undefined) {
      const c = String(body.currency).toUpperCase();
      if (!isCurrency(c)) return err(400, "bad_currency");
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
    notify.trip(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    db.run("DELETE FROM expenses WHERE id = ?", [e.id]);
    notify.trip(o.trip.token);
    return json({ ok: true });
  }],

  // Per-person paid toggle: the payer or the person themself.
  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/paid$/, "PUT", async (req, m, body) => {
    const g = withExpense(req, m[1]);
    if (g instanceof Response) return g;
    const { s, e, t, me } = g;
    const mid = String(body.member_id ?? "");
    if (me?.id !== e.payer_member_id && me?.id !== mid) return err(403, "payer_or_self_only");
    db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor, paid) VALUES (?,?,NULL,0)", [e.id, mid]);
    db.run("UPDATE expense_participants SET paid = ? WHERE expense_id = ? AND member_id = ?", [body.paid ? 1 : 0, e.id, mid]);
    notify.trip(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/participants$/, "PUT", async (req, m, body) => {
    const g = withExpense(req, m[1]);
    if (g instanceof Response) return g;
    const { s, e, t, me } = g;
    const memberId = String(body.member_id ?? "");
    const on = !!body.on;
    const mem = qMember.get(memberId);
    if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found");
    if (on) {
      db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, memberId]);
    } else {
      db.run("DELETE FROM expense_participants WHERE expense_id = ? AND member_id = ?", [e.id, memberId]);
      db.run(`DELETE FROM item_sharers WHERE member_id = ? AND item_id IN
        (SELECT id FROM items WHERE expense_id = ?)`, [memberId, e.id]);
    }
    edited(e, me?.name ?? null);
    notify.trip(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/shares$/, "PUT", async (req, m, body) => {
    const g = withExpense(req, m[1]);
    if (g instanceof Response) return g;
    const { s, e, t, me } = g;
    const memberId = String(body.member_id ?? "");
    const value = body.share_minor === null ? null : Number(body.share_minor);
    const mem = qMember.get(memberId);
    if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found");
    db.run(
      `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,?)
       ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = excluded.share_minor`,
      [e.id, memberId, value],
    );
    edited(e, me?.name ?? null);
    notify.trip(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/split$/, "POST", async (req, m, body) => {
    const g = withExpense(req, m[1]);
    if (g instanceof Response) return g;
    const { s, e, t, me } = g;
    const type = String(body.type);
    const parts = db.query<{ member_id: string; share_minor: number | null }, [string]>(
      "SELECT member_id, share_minor FROM expense_participants WHERE expense_id = ?",
    ).all(e.id);
    const eff = effectiveShares(e);
    const assignedEff = eff.reduce((a, s) => a + (s.minor ?? 0), 0);
    const rest = e.total_minor - assignedEff;
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
    notify.trip(t.token);
    return json({ ok: true });
  }],

  // ---- items ----
  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/items$/, "POST", async (req, m, body) => {
    const g = withExpense(req, m[1]);
    if (g instanceof Response) return g;
    const { s, e, t, me } = g;
    const name = String(body.name ?? "").trim() || "Item";
    const price = Number(body.price_minor ?? 0);
    const sharers: string[] = Array.isArray(body.sharers) ? body.sharers : [];
    const itemId = crypto.randomUUID();
    db.run("INSERT INTO items (id, expense_id, name, price_minor) VALUES (?,?,?,?)",
      [itemId, e.id, name, price]);
    for (const mid of sharers) {
      db.run("INSERT OR IGNORE INTO item_sharers (item_id, member_id) VALUES (?,?)", [itemId, mid]);
      db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, mid]);
    }
    edited(e, me?.name ?? null);
    notify.trip(t.token);
    return json({ id: itemId });
  }],

  [/^\/api\/items\/([A-Za-z0-9-]+)$/, "PATCH", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const item = db.query<{ id: string; expense_id: string }, [string]>(
      "SELECT id, expense_id FROM items WHERE id = ?",
    ).get(m[1]);
    if (!item) return err(404, "item_not_found");
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(item.expense_id)!;
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const me = myMember(s, o.trip);
    if (body.name !== undefined) db.run("UPDATE items SET name = ? WHERE id = ?", [String(body.name), item.id]);
    if (body.price_minor !== undefined) db.run("UPDATE items SET price_minor = ? WHERE id = ?", [Number(body.price_minor), item.id]);
    if (Array.isArray(body.sharers)) {
      db.run("DELETE FROM item_sharers WHERE item_id = ?", [item.id]);
      for (const mid of body.sharers) {
        db.run("INSERT OR IGNORE INTO item_sharers (item_id, member_id) VALUES (?,?)", [item.id, mid]);
        db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, mid]);
      }
    }
    edited(e, me?.name ?? null);
    notify.trip(o.trip.token);
    return json({ ok: true });
  }],

  [/^\/api\/items\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const item = db.query<{ id: string; expense_id: string }, [string]>(
      "SELECT id, expense_id FROM items WHERE id = ?",
    ).get(m[1]);
    if (!item) return err(404, "item_not_found");
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(item.expense_id)!;
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    db.run("DELETE FROM items WHERE id = ?", [item.id]);
    notify.trip(o.trip.token);
    return json({ ok: true });
  }],

  // ---- photos ----
  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/photos$/, "POST", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const me = myMember(s, o.trip);
    const mime = req.headers.get("content-type") ?? "application/octet-stream";
    if (!mime.startsWith("image/")) return err(400, "not_image");
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength === 0) return err(400, "empty");
    if (buf.byteLength > 10 * 1024 * 1024) return err(413, "too_large");
    const id = crypto.randomUUID();
    db.run("INSERT INTO expense_photos (id, expense_id, mime, data, created_at) VALUES (?,?,?,?,?)",
      [id, e.id, mime, buf, now()]);
    edited(e, me?.name ?? null);
    notify.trip(o.trip.token);
    return json({ id });
  }],

  [/^\/api\/photos\/([A-Za-z0-9-]+)$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const p = db.query<{ mime: string; data: Uint8Array; expense_id: string }, [string]>(
      "SELECT mime, data, expense_id FROM expense_photos WHERE id = ?",
    ).get(m[1]);
    if (!p) return err(404, "photo_not_found");
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(p.expense_id)!;
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    return new Response(Buffer.from(p.data), { headers: { "content-type": p.mime, "cache-control": "private, max-age=3600" } });
  }],

  [/^\/api\/photos\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const p = db.query<{ id: string; expense_id: string }, [string]>(
      "SELECT id, expense_id FROM expense_photos WHERE id = ?",
    ).get(m[1]);
    if (!p) return err(404, "photo_not_found");
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(p.expense_id)!;
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const me = myMember(s, o.trip);
    db.run("DELETE FROM expense_photos WHERE id = ?", [p.id]);
    edited(e, me?.name ?? null);
    notify.trip(o.trip.token);
    return json({ ok: true });
  }],

  // ---- settlements ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/settlements$/, "POST", async (req, m, body) => {
    const g = withTrip(req, m[1]);
    if (g instanceof Response) return g;
    const { s, t, me } = g;
    const from = qMember.get(String(body.from_member ?? ""));
    const to = qMember.get(String(body.to_member ?? ""));
    if (!from || !to || from.trip_token !== t.token || to.trip_token !== t.token || from.id === to.id)
      return err(400, "bad_members");
    const amount = Number(body.amount_minor);
    if (!Number.isFinite(amount) || amount <= 0) return err(400, "bad_amount");
    const id = crypto.randomUUID();
    db.run("INSERT INTO settlements (id, trip_token, from_member, to_member, amount_minor, created_at, created_by) VALUES (?,?,?,?,?,?,?)",
      [id, t.token, from.id, to.id, amount, now(), me?.name ?? null]);
    notify.trip(t.token);
    return json({ id });
  }],

  [/^\/api\/settlements\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const st = db.query<{ id: string; trip_token: string }, [string]>(
      "SELECT id, trip_token FROM settlements WHERE id = ?",
    ).get(m[1]);
    if (!st) return err(404, "settlement_not_found");
    const o = openTrip(st.trip_token, s);
    if (o instanceof Response) return o;
    db.run("DELETE FROM settlements WHERE id = ?", [st.id]);
    notify.trip(st.trip_token);
    return json({ ok: true });
  }],

  // ---- journeys ----
  [/^\/api\/accessible-trips$/, "GET", async (req) => {
    const s = sessionFrom(req);
    if (!s) return json({ trips: [] });
    const jOf = db.prepare<{ journey_token: string; name: string }, [string]>(
      "SELECT jt.journey_token, j.name FROM journey_trips jt JOIN journeys j ON j.token = jt.journey_token WHERE jt.trip_token = ?");
    return json({
      trips: accessibleTrips(s).map((t) => {
        const j = jOf.get(t.token);
        return { token: t.token, name: t.name, settle_currency: t.settle_currency, journey: j ? { token: j.journey_token, name: j.name } : null };
      }),
    });
  }],

  // distinct member names across this session's accessible trips, most-used first
  [/^\/api\/member-suggestions$/, "GET", async (req) => {
    const s = sessionFrom(req);
    if (!s) return json({ suggestions: [] });
    const trips = accessibleTrips(s);
    if (!trips.length) return json({ suggestions: [] });
    const q = db.prepare<{ name: string; n: number }, [string]>(
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

  [/^\/api\/journeys$/, "POST", async (req, _m, body) => {
    const { session: s, headers } = ensureSession(req);
    const name = String(body.name ?? "").trim();
    if (!name) return err(400, "name_required");
    const wanted = Array.isArray(body.trip_tokens) ? body.trip_tokens.map(String) : [];
    const allowed = new Map(accessibleTrips(s).map((t) => [t.token, t]));
    const picked = [...new Set(wanted)].map((t) => allowed.get(t)).filter((t): t is Trip => !!t);
    if (!picked.length) return err(400, "no_trips");
    // A Journey has no currency of its own: every trip must settle in the same one.
    const sc = picked[0].settle_currency;
    if (picked.some((t) => t.settle_currency !== sc)) return err(400, "settle_currency_mismatch");
    const tokens = picked.map((t) => t.token);
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    db.run("INSERT INTO journeys (token, name, settle_currency, created_at) VALUES (?,?,?,?)",
      [token, name, sc, now()]);
    for (const tt of tokens)
      db.run("INSERT OR IGNORE INTO journey_trips (journey_token, trip_token) VALUES (?,?)", [token, tt]);
    return json({ token }, { headers });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const j = qJourney.get(m[1]);
    if (!j) return err(404, "journey_not_found");
    if (!journeyAccess(s, j)) return err(403, "no_access");
    const trips = journeyTrips(j);
    // merge hints: same name across different trips, not already one person
    const { persons, keyOf } = journeyPeople(j);
    const hints: { name: string; member_ids: string[]; trips: string[] }[] = [];
    const allM = trips.flatMap((t) =>
      db.query<Member, [string]>("SELECT * FROM members WHERE trip_token = ? ORDER BY name")
        .all(t.token).map((mm) => ({ ...mm, trip_name: t.name })));
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
    const { transfers } = journeyBalance(j);
    // Trip Wrapped waits for trip end (or 5 days after creation with no end
    // date); the journey unlocks at the latest of all its trips' dates.
    const wrappedAt = trips.length
      ? new Date(Math.max(...trips.map((t) => Date.parse(
          t.end_date ? `${t.end_date}T23:59:59` : new Date(Date.parse(t.created_at) + 5 * 86400e3).toISOString())))).toISOString()
      : null;
    return json({
      journey: { token: j.token, name: j.name, settle_currency: j.settle_currency, fun_leaderboard: !!j.fun_leaderboard },
      signed_in: !!s.user_sub,
      wrapped_at: wrappedAt,
      fun: j.fun_leaderboard ? journeyBoard(j) : null,
      trips: trips.map((t) => ({
        token: t.token, name: t.name, settle_currency: t.settle_currency,
        access: hasAccess(s, t) ? "edit" : "view",
        members: db.query<Member, [string]>("SELECT * FROM members WHERE trip_token = ? ORDER BY name")
          .all(t.token).map((mm) => ({ id: mm.id, name: mm.name, linked: !!mm.user_sub, opted_out_fun: !!mm.opted_out_fun })),
        expenses: db.query<ExpenseRow, [string]>(
          "SELECT * FROM expenses WHERE trip_token = ? ORDER BY recorded_at DESC",
        ).all(t.token).map((e) => expensePayload(e, false)),
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
  [/^\/api\/my-journeys$/, "GET", async (req) => {
    const s = sessionFrom(req);
    if (!s) return json({ journeys: [] });
    const granted = db.query<{ journey_token: string }, [string]>(
      "SELECT journey_token FROM journey_access WHERE session_token = ?",
    ).all(s.token).map((r) => r.journey_token);
    const viaTrips = db.query<{ journey_token: string }, [string, string | null]>(
      `SELECT DISTINCT jt.journey_token FROM journey_trips jt
       WHERE jt.trip_token IN (
         SELECT trip_token FROM consents WHERE session_token = ?
         UNION SELECT trip_token FROM members WHERE user_sub = ?)`,
    ).all(s.token, s.user_sub).map((r) => r.journey_token);
    const journeys = [...new Set([...granted, ...viaTrips])]
      .map((t) => qJourney.get(t))
      .filter((j): j is Journey => !!j)
      .map((j) => ({ token: j.token, name: j.name, settle_currency: j.settle_currency }));
    return json({ journeys });
  }],

  // journey link: opening it (POST join) grants read access to every member trip
  [/^\/api\/journeys\/([A-Za-z0-9]+)\/join$/, "POST", async (req, m) => {
    const { session: s, headers } = ensureSession(req);
    const j = qJourney.get(m[1]);
    if (!j) return err(404, "journey_not_found");
    db.run("INSERT OR IGNORE INTO journey_access (session_token, journey_token, created_at) VALUES (?,?,?)",
      [s.token, j.token, now()]);
    for (const t of journeyTrips(j)) notify.trip(t.token);
    return json({ ok: true }, { headers });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)\/trips$/, "POST", async (req, m, body) => {
    const g = withJourney(req, m[1]);
    if (g instanceof Response) return g;
    const { s, j } = g;
    const tt = String(body.trip_token ?? "");
    const t = qTrip.get(tt);
    if (!t) return err(404, "trip_not_found");
    if (!hasAccess(s, t)) return err(403, "no_trip_access");
    if (db.query("SELECT 1 FROM journey_trips WHERE trip_token = ?").get(tt))
      return err(409, "already_in_journey");
    if (t.settle_currency !== j.settle_currency) return err(400, "settle_currency_mismatch");
    db.run("INSERT INTO journey_trips (journey_token, trip_token) VALUES (?,?)", [j.token, tt]);
    notify.journey(j.token);
    return json({ ok: true });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)\/trips\/([A-Za-z0-9]+)$/, "DELETE", async (req, m) => {
    const g = withJourney(req, m[1]);
    if (g instanceof Response) return g;
    const { s, j } = g;
    db.run("DELETE FROM journey_trips WHERE journey_token = ? AND trip_token = ?", [j.token, m[2]]);
    db.run("DELETE FROM journey_merges WHERE journey_token = ? AND member_id IN (SELECT id FROM members WHERE trip_token = ?)", [j.token, m[2]]);
    notify.journey(j.token);
    notify.trip(m[2]);
    return json({ ok: true });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)\/merge$/, "POST", async (req, m, body) => {
    const g = withJourney(req, m[1]);
    if (g instanceof Response) return g;
    const { s, j } = g;
    const ids = (Array.isArray(body.member_ids) ? body.member_ids : []).map(String);
    const inJourney = new Set(journeyTrips(j).flatMap((t) =>
      db.query<{ id: string }, [string]>("SELECT id FROM members WHERE trip_token = ?").all(t.token).map((r) => r.id)));
    const valid = ids.filter((id) => inJourney.has(id));
    if (valid.length < 2) return err(400, "need_two_members");
    // merge into the group of the first already-grouped member, else new group
    const existing = db.prepare<{ group_id: string }, [string, string]>(
      "SELECT group_id FROM journey_merges WHERE journey_token = ? AND member_id = ? LIMIT 1",
    );
    let gid: string | null = null;
    for (const id of valid) { const r = existing.get(j.token, id); if (r) { gid = r.group_id; break; } }
    gid ??= crypto.randomUUID();
    for (const id of valid)
      db.run("INSERT OR REPLACE INTO journey_merges (journey_token, member_id, group_id) VALUES (?,?,?)", [j.token, id, gid]);
    notify.journey(j.token);
    return json({ ok: true, group_id: gid });
  }],

  // journey settings: rename + Journey Wrapped toggle. Dissolving a journey
  // only removes the grouping — its trips are untouched.
  [/^\/api\/journeys\/([A-Za-z0-9]+)\/settings$/, "PATCH", async (req, m, body) => {
    const g = withJourney(req, m[1]);
    if (g instanceof Response) return g;
    const { j } = g;
    if (body.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (!name) return err(400, "bad_name");
      db.run("UPDATE journeys SET name = ? WHERE token = ?", [name, j.token]);
    }
    if (body.fun_leaderboard !== undefined) {
      db.run("UPDATE journeys SET fun_leaderboard = ? WHERE token = ?", [body.fun_leaderboard ? 1 : 0, j.token]);
    }
    notify.journey(j.token);
    return json({ ok: true });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)$/, "DELETE", async (req, m, body) => {
    const g = withJourney(req, m[1]);
    if (g instanceof Response) return g;
    const { j } = g;
    if (String(body.name ?? "") !== j.name) return err(400, "name_mismatch");
    const trips = journeyTrips(j);
    db.run("DELETE FROM journey_merges WHERE journey_token = ?", [j.token]);
    db.run("DELETE FROM journey_access WHERE journey_token = ?", [j.token]);
    db.run("DELETE FROM journey_trips WHERE journey_token = ?", [j.token]);
    db.run("DELETE FROM journeys WHERE token = ?", [j.token]);
    notify.journey(j.token);
    for (const t of trips) notify.trip(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/journeys\/([A-Za-z0-9]+)\/merge\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const g = withJourney(req, m[1]);
    if (g instanceof Response) return g;
    const { s, j } = g;
    db.run("DELETE FROM journey_merges WHERE journey_token = ? AND member_id = ?", [j.token, m[2]]);
    notify.journey(j.token);
    return json({ ok: true });
  }],

  // ---- SSE ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/events$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const o = openTrip(m[1], s);
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
  const { headers: sessionHeaders } = isApi ? ensureSession(req) : { headers: {} };

  for (const [re, method, fn] of routes) {
    const m = re.exec(path);
    if (m && req.method === method) {
      const res = await fn(req, m, body);
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

startFxLoop();

Bun.serve({ port: PORT, fetch: handle });
try { if (seedDemo()) console.log(`demo trip: http://localhost:${PORT}/#/t/${DEMO_TOKEN}`); }
catch (e) { console.error("demo seed failed:", e); }
console.log(`WatsTheSplit on http://localhost:${PORT}`);
