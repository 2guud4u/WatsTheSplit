import type { ErrorCode } from "../shared/wire.ts"
import {
  accessibleTrips,
  ensureSession,
  grantConsent,
  grantJourneyAccess,
  hasAccess,
  journeyAccess,
  journeyGrant,
  linkedMember,
  myMember,
  resolveJourney,
  resolveTrip,
  revokeConsents,
  type TripAccess,
} from "./access.ts"
import { createAuth, type Mailer } from "./auth.ts"
import { db, stmt } from "./db.ts"
import { routes as authRoutes } from "./routes/auth.ts"
import { routes as expenseRoutes } from "./routes/expenses.ts"
import { routes as itemRoutes } from "./routes/items.ts"
import { routes as journeyRoutes } from "./routes/journeys.ts"
import { routes as memberRoutes } from "./routes/members.ts"
import { routes as photoRoutes } from "./routes/photos.ts"
import { routes as settlementRoutes } from "./routes/settlements.ts"
import { routes as tripRoutes } from "./routes/trips.ts"
import type { Route, RouteCtx } from "./routes.ts"
import type { ExpenseRow, Journey, Member, Session, Trip } from "./types.ts"

export type AppDeps = {
  mailer: Mailer
  baseUrl: string
  basePath?: string
  dist: string
}

export function createApp(deps: AppDeps) {
  const auth = createAuth({ mailer: deps.mailer, baseUrl: deps.baseUrl })
  const BASE_URL = deps.baseUrl.replace(/\/$/, "")
  const BASE_PATH = (deps.basePath ?? "").replace(/\/$/, "")
  const DIST = deps.dist
  const COOKIE = "wts_session"

  const json = (data: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(data), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    })
  const err = (status: number, error: ErrorCode, extra: object = {}) => json({ error, ...extra }, { status })
  const now = () => new Date().toISOString()

  // Lazy prepared statements — getDb() isn't open until openDb() runs at boot.
  const qMember = { get: (id: string) => stmt<Member, [string]>("SELECT * FROM members WHERE id = ?").get(id) }
  const qTrip = { get: (t: string) => stmt<Trip, [string]>("SELECT * FROM trips WHERE token = ?").get(t) }
  const qJourney = { get: (t: string) => stmt<Journey, [string]>("SELECT * FROM journeys WHERE token = ?").get(t) }
  const qSession = {
    get: (t: string) => stmt<Session, [string]>("SELECT token, user_sub FROM sessions WHERE token = ?").get(t),
  }
  const qExpense = { get: (id: string) => stmt<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(id) }
  const qItem = {
    get: (id: string) =>
      stmt<{ id: string; expense_id: string; name: string; price_minor: number }, [string]>(
        "SELECT id, expense_id, name, price_minor FROM items WHERE id = ?"
      ).get(id),
  }
  const qPhoto = {
    get: (id: string) =>
      stmt<{ id: string; expense_id: string; mime: string; data: Uint8Array }, [string]>(
        "SELECT id, expense_id, mime, data FROM expense_photos WHERE id = ?"
      ).get(id),
  }
  const qSettlement = {
    get: (id: string) =>
      stmt<{ id: string; trip_token: string }, [string]>("SELECT id, trip_token FROM settlements WHERE id = ?").get(id),
  }

  // A linked member's Payment Method is their account's (shared across all trips).
  const paymentOf = (email: string): { phone: string | null; venmo: string | null; cash_app: string | null } => {
    const u = stmt<{ phone: string | null; venmo: string | null; cash_app: string | null }, [string]>(
      "SELECT phone, venmo, cash_app FROM users WHERE email = ?"
    ).get(email)
    return { phone: u?.phone ?? null, venmo: u?.venmo ?? null, cash_app: u?.cash_app ?? null }
  }

  // An unlinked member's Payment Method is stored on their own row (per trip).
  // null if the member has no payment info (so the card shows nothing).
  const memberPayment = (m: Member): { phone: string | null; venmo: string | null; cash_app: string | null } | null => {
    const phone = m.phone ?? null,
      venmo = m.venmo ?? null,
      cash_app = m.cash_app ?? null
    if (!phone && !venmo && !cash_app) return null
    return { phone, venmo, cash_app }
  }

  // A member's Payment Method: linked → account's (shared); unlinked → their row's.
  const paymentOfMember = (
    m: Member
  ): { phone: string | null; venmo: string | null; cash_app: string | null } | null =>
    m.user_sub ? paymentOf(m.user_sub) : memberPayment(m)

  const memberIsUsed = (tripToken: string, memberId: string): boolean => {
    const checks: [string, string[]][] = [
      ["SELECT COUNT(*) n FROM expenses WHERE trip_token = ? AND payer_member_id = ?", [tripToken, memberId]],
      [
        `SELECT COUNT(*) n FROM expense_participants p JOIN expenses e ON e.id = p.expense_id
      WHERE e.trip_token = ? AND p.member_id = ?`,
        [tripToken, memberId],
      ],
      [
        `SELECT COUNT(*) n FROM item_sharers s JOIN items i ON i.id = s.item_id
      JOIN expenses e ON e.id = i.expense_id WHERE e.trip_token = ? AND s.member_id = ?`,
        [tripToken, memberId],
      ],
      [
        "SELECT COUNT(*) n FROM settlements WHERE trip_token = ? AND (from_member = ? OR to_member = ?)",
        [tripToken, memberId, memberId],
      ],
    ]
    return checks.some(([sql, args]) => db.query<{ n: number }, string[]>(sql).get(...args)!.n > 0)
  }

  // Case-insensitive name check within a trip.
  const nameTaken = (tripToken: string, name: string, excludeId?: string): boolean => {
    return !!db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM members WHERE trip_token = ? AND name = ? COLLATE NOCASE"
      )
      .all(tripToken, name)
      .find((m) => m.id !== excludeId)
  }

  type Body = Record<string, unknown>

  const ctx: RouteCtx = {
    json,
    err,
    now,
    baseUrl: BASE_URL,
    qMember,
    qTrip,
    qJourney,
    qExpense,
    qItem,
    qPhoto,
    paymentOfMember,
    memberIsUsed,
    nameTaken,
    auth,
  }

  // One route module per domain; the order is the dispatch order.
  const routes: Route[] = [
    ...authRoutes(ctx),
    ...tripRoutes(ctx),
    ...memberRoutes(ctx),
    ...expenseRoutes(ctx),
    ...itemRoutes(ctx),
    ...photoRoutes(ctx),
    ...settlementRoutes(ctx),
    ...journeyRoutes(ctx),
  ]

  // ---------- server ----------
  async function handle(req: Request): Promise<Response> {
    if (req.method !== "GET" && !req.headers.get("x-wts")) {
      return err(403, "missing_header") // cheap CSRF guard for cookie auth
    }

    let body: Body = {}
    if (req.method !== "GET" && req.headers.get("content-type")?.includes("json")) {
      try {
        body = await req.json()
      } catch {
        return err(400, "bad_json")
      }
    }

    const url = new URL(req.url)
    let path = url.pathname
    if (BASE_PATH) {
      if (path === BASE_PATH) path = "/"
      else if (path.startsWith(BASE_PATH + "/")) path = path.slice(BASE_PATH.length)
      else return err(404, "not_found")
    }
    const isApi = path.startsWith("/api/")
    // Session resolved once: handlers receive `s`; the cookie rides out on any response.
    const { session, headers: sessionHeaders } = isApi
      ? ensureSession(req)
      : { session: null as Session | null, headers: {} }

    for (const [re, method, fn] of routes) {
      const m = re.exec(path)
      if (m && req.method === method) {
        const res = await fn(req, m, body, session!)
        const sc = (sessionHeaders as Record<string, string>)["set-cookie"]
        if (sc && !res.headers.has("set-cookie")) res.headers.set("set-cookie", sc)
        return res
      }
    }
    if (isApi) return err(404, "not_found")

    // static
    const file = path === "/" ? "/index.html" : path
    const f = Bun.file(DIST + file)
    if (await f.exists()) return new Response(f)
    return new Response(Bun.file(DIST + "/index.html")) // SPA fallback
  }

  return handle
}
