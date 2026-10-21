import { db, stmt } from "./db.ts";
import { journeyTrips } from "./ledger.ts";
import type { Session, Member, Trip, Journey } from "./types.ts";
import type { ErrorCode } from "../shared/wire.ts";

// ---------- sessions ----------
// handle() resolves the session once and passes it to the route — handlers
// receive `s` directly; the WeakMap ordering trick is gone.
const COOKIE = "wts_session";
const now = () => new Date().toISOString();

const qSession = { get: (t: string) => stmt<Session, [string]>("SELECT token, user_sub FROM sessions WHERE token = ?").get(t) };
const qTrip = { get: (t: string) => stmt<Trip, [string]>("SELECT * FROM trips WHERE token = ?").get(t) };
const qJourney = { get: (t: string) => stmt<Journey, [string]>("SELECT * FROM journeys WHERE token = ?").get(t) };
const qMember = { get: (id: string) => stmt<Member, [string]>("SELECT * FROM members WHERE id = ?").get(id) };

/** Cookie session → session row, or a fresh anonymous session (+ cookie headers). */
export function ensureSession(req: Request): { session: Session; headers: HeadersInit } {
  const m = /(?:^|;\s*)wts_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  if (m) {
    const s = qSession.get(decodeURIComponent(m[1]));
    if (s) return { session: s, headers: {} };
  }
  const token = crypto.randomUUID();
  db.run("INSERT INTO sessions (token, user_sub, created_at) VALUES (?, NULL, ?)", [token, now()]);
  return {
    session: { token, user_sub: null },
    headers: { "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` },
  };
}

// ---------- access ----------
// ADR-0004 lives here: trips open two ways (password consent, member claim —
// Linked Members exempt from the password) and journeys grant read access to
// every member Trip, upgradeable by claiming.

export const linkedMember = (s: Session, tripToken: string): Member | null =>
  s.user_sub
    ? db.query<Member, [string, string]>(
        "SELECT * FROM members WHERE trip_token = ? AND user_sub = ?",
      ).get(tripToken, s.user_sub) ?? null
    : null;

export function myMember(s: Session, trip: Trip): Member | null {
  const l = linkedMember(s, trip.token);
  if (l) return l;
  const claim = db.query<{ member_id: string }, [string, string]>(
    "SELECT member_id FROM claims WHERE session_token = ? AND trip_token = ?",
  ).get(s.token, trip.token);
  return claim ? qMember.get(claim.member_id) ?? null : null;
}

// Password access: Linked members are exempt; others need consent at the
// current password version.
export function hasAccess(s: Session, trip: Trip): boolean {
  if (!trip.password_hash) return true;
  if (linkedMember(s, trip.token)) return true;
  const c = db.query<{ password_ver: number }, [string, string]>(
    "SELECT password_ver FROM consents WHERE session_token = ? AND trip_token = ?",
  ).get(s.token, trip.token);
  return c?.password_ver === trip.password_ver;
}

// Trips the session may open (journey trip-picker, accessible-trips route).
export function accessibleTrips(s: Session): Trip[] {
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
export function journeyGrant(s: Session, journeyToken: string): boolean {
  return !!db.query("SELECT 1 FROM journey_access WHERE session_token = ? AND journey_token = ?")
    .get(s.token, journeyToken);
}
export function journeyAccess(s: Session, j: Journey): boolean {
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

// ---------- consent writes (the grant side of ADR-0004) ----------
export function grantConsent(s: Session, trip: Trip): void {
  db.run("INSERT OR REPLACE INTO consents (session_token, trip_token, password_ver) VALUES (?,?,?)",
    [s.token, trip.token, trip.password_ver]);
}
export function revokeConsents(trip: Trip): void {
  db.run("DELETE FROM consents WHERE trip_token = ?", [trip.token]);
}
export function grantJourneyAccess(s: Session, j: Journey): void {
  db.run("INSERT OR IGNORE INTO journey_access (session_token, journey_token, created_at) VALUES (?,?,?)",
    [s.token, j.token, now()]);
}

// ---------- the resolver seam ----------
// Every entity id a route accepts resolves to its Trip in one place, then the
// view/edit tier applies. Callers get {trip, me, edit} or a ready Response.
export type EntityRef =
  | { trip: string }
  | { expense: string }
  | { item: string }
  | { photo: string }
  | { member: string }
  | { settlement: string };

export type TripAccess = { trip: Trip; me: Member | null; edit: boolean };

const childTrip = (sql: string) => (id: string) =>
  db.query<{ trip_token: string }, [string]>(sql).get(id)?.trip_token ?? null;
// keyof over the union gives only common keys (= never) — name them.
type EntityKind = "trip" | "expense" | "item" | "photo" | "member" | "settlement";

const entityTripToken: Record<EntityKind, (id: string) => string | null> = {
  trip: (id: string) => id,

  expense: childTrip("SELECT trip_token FROM expenses WHERE id = ?"),
  item: childTrip(`SELECT e.trip_token FROM items i JOIN expenses e ON e.id = i.expense_id WHERE i.id = ?`),
  photo: childTrip(`SELECT e.trip_token FROM expense_photos p JOIN expenses e ON e.id = p.expense_id WHERE p.id = ?`),
  member: childTrip("SELECT trip_token FROM members WHERE id = ?"),
  settlement: childTrip("SELECT trip_token FROM settlements WHERE id = ?"),
};

const notFoundFor: Record<EntityKind, [number, ErrorCode]> = {
  trip: [404, "trip_not_found"],
  expense: [404, "expense_not_found"],
  item: [404, "item_not_found"],
  photo: [404, "photo_not_found"],
  member: [404, "member_not_found"],
  settlement: [404, "settlement_not_found"],
};

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const err = (status: number, error: ErrorCode, extra: object = {}) => json({ error, ...extra }, { status });

export function resolveTrip(s: Session, ref: EntityRef, tier: "view" | "edit"): TripAccess | Response {
  const kind = Object.keys(ref)[0] as EntityKind;
  const token = entityTripToken[kind]((ref as Record<string, string>)[kind]);
  const trip = token ? qTrip.get(token) : null;
  if (!trip) { const [st, code] = notFoundFor[kind]; return err(st, code); }
  if (tier === "edit" && !hasAccess(s, trip)) return err(401, "password_required", { protected: true });
  if (tier === "view" && !canViewTrip(s, trip)) return err(401, "password_required", { protected: true });
  return { trip, me: myMember(s, trip), edit: hasAccess(s, trip) };
}

export function resolveJourney(s: Session, token: string): { j: Journey } | Response {
  const j = qJourney.get(token);
  if (!j) return err(404, "journey_not_found");
  if (!journeyAccess(s, j)) return err(403, "no_access");
  return { j };
}
