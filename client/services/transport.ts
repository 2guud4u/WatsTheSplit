import type { ErrorCode } from "../../shared/wire.ts"

// Deployed under BASE_PATH (e.g. /watsthesplit) — vite base bakes it into
// import.meta.env.BASE_URL; strip its trailing slash for path joins.
export const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "")

// ---------- errors ----------

export class ApiError<C extends string = ErrorCode> extends Error {
  readonly status: number // 0 = network failure
  readonly code: C
  readonly data: Record<string, unknown> // extra server fields, e.g. { protected: true }
  constructor(status: number, code: C, data: Record<string, unknown> = {}) {
    super(code)
    this.status = status
    this.code = code
    this.data = data
  }
}

export function isApiError<K extends string, P extends string>(e: unknown, ...codes: P[]): e is ApiError<P> {
  return e instanceof ApiError && (codes.length === 0 || codes.includes(e.code as P))
}

// Human copy for error codes — one catalog instead of per-site mapping.
const COPY: Partial<Record<ErrorCode | "network" | "bad_response", string>> = {
  bad_email: "That doesn't look like an email address",
  too_many_codes: "Too many codes sent — wait a bit and try again",
  send_failed: "Couldn't send the email — try again later",
  no_code: "Send a code first",
  code_expired: "Code expired — send a new one",
  too_many_attempts: "Too many tries — send a new code",
  wrong_code: "Wrong code — check the email",
  password_required: "This trip is locked — enter its password",
  password_empty: "Trips must keep a password",
  end_date_required: "Set an end date first — Wrapped unlocks when the trip ends",
  no_access: "You don't have access to this journey",
  name_taken: "Name taken — pick another",
  member_linked: "That member is linked to another account",
  member_in_use: "That member is used by expenses or settlements",
  cannot_remove_self: "You can't remove yourself",
  name_mismatch: "The name doesn't match — type it exactly to confirm",
  currencies_locked: "Currencies are set at creation only",
  only_creator: "Only the trip creator can change that",
  bad_currency: "Unknown currency",
  bad_total: "Enter a valid total",
  bad_payer: "Pick someone in this trip",
  bad_members: "Pick two different members of this trip",
  bad_amount: "Enter a positive amount",
  member_or_name_required: "Pick a member or type a new name",
  need_two_members: "Pick at least two members to merge",
  no_trips: "Pick at least one trip",
  settle_currency_mismatch: "All trips must settle in the same currency",
  already_in_journey: "That trip is already in a journey",
  not_image: "That file isn't an image",
  too_large: "Photo is over 10 MB",
  payer_only: "Only the payer can mark this paid",
  payer_or_self_only: "Only the payer or that person can change this",
  not_your_member: "You can only change your own member",
  not_signed_in: "Sign in first — how to pay you is tied to your account",
  network: "Can't reach the server — check your connection",
  bad_response: "Unexpected server response",
  trip_not_found: "Trip not found",
  expense_not_found: "Expense not found",
  journey_not_found: "Journey not found",
  member_not_found: "Member not found",
}

export function describeError(e: unknown, overrides: Partial<Record<ErrorCode, string>> = {}): string {
  if (e instanceof ApiError) {
    const o = overrides[e.code as ErrorCode]
    if (o) return o
    const c = COPY[e.code as ErrorCode]
    if (c) return c
    return `${e.code} (${e.status})`
  }
  return e instanceof Error ? e.message : "Something went wrong"
}

// ---------- transport ----------

export type Transport = {
  send(req: { method: string; path: string; json?: unknown; file?: Blob }): Promise<{ status: number; data: unknown }>
  subscribe(tripToken: string, on: (ev: "message" | "reopen") => void): () => void
  url(path: string): string
}

export const browserTransport = (base: string): Transport => ({
  send: async ({ method, path, json, file }) => {
    try {
      const res = await fetch(base + path, {
        method,
        headers: {
          "x-wts": "1",
          ...(json !== undefined ? { "content-type": "application/json" } : {}),
          ...(file !== undefined ? { "content-type": file.type } : {}),
        },
        body: file ?? (json !== undefined ? JSON.stringify(json) : undefined),
        credentials: "same-origin",
      })
      const data = await res.json().catch(() => ({}))
      return { status: res.status, data }
    } catch {
      return { status: 0, data: {} }
    }
  },
  subscribe: (tripToken, on) => {
    const es = new EventSource(base + `/api/trips/${tripToken}/events`)
    es.onmessage = () => on("message")
    // reopen = a stream that failed and reconnected; pings may have been
    // missed, so watchers treat it as a change. The initial open isn't a reopen.
    let seenError = false
    es.onerror = () => {
      seenError = true
    }
    es.onopen = () => {
      if (seenError) on("reopen")
    }
    return () => es.close()
  },
  url: (path) => base + path,
})
