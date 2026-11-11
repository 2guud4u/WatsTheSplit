import type { HistoryValue } from "../shared/wire.ts"
import { db } from "./db.ts"
import { crossRate } from "./fx.ts"
import * as notify from "./notify.ts"

// One seam for every trip/journey mutation: writes run inside a transaction,
// SSE fan-out fires only after commit. Throw `Abort(err(...))` from inside an
// operation to roll back and return that error Response; anything else thrown
// rolls back and propagates.

class Abort extends Error {
  constructor(public res: Response) {
    super("abort")
  }
}

export const abort = (res: Response): never => {
  throw new Abort(res)
}

function transact<T>(fn: () => T): T | Response {
  const tx = db.transaction(fn)
  try {
    return tx()
  } catch (e) {
    if (e instanceof Abort) return e.res
    throw e
  }
}

/** Trip-scoped mutation: transaction + notify.trip after commit. */
// A Response returned *from* fn is passed through; fan-out fires only for
// success (<400). Use abort(err(...)) after writes to force a rollback.
function mutate_<T>(fanout: () => void, fn: () => T): T | Response {
  const r = transact(fn)
  if (!(r instanceof Response) || r.status < 400) fanout()
  return r
}

/** Trip-scoped mutation: transaction + notify.trip after commit. */
export function mutateTrip<T>(tripToken: string, fn: () => T): T | Response {
  return mutate_(() => notify.trip(tripToken), fn)
}

/** Journey-scoped mutation: transaction + fan-out to every member trip. */
export function mutateJourney<T>(journeyToken: string, fn: () => T): T | Response {
  return mutate_(() => notify.journey(journeyToken), fn)
}

/** Untyped mutation (auth, session linking): transaction, no fan-out. */
export function mutate<T>(fn: () => T): T | Response {
  return transact(fn)
}

const now = () => new Date().toISOString()

/** Stamp the expense's last-editor + time. */
export function edited(e: { id: string }, memberName: string | null) {
  db.run("UPDATE expenses SET last_edited_by = ?, last_edited_at = ? WHERE id = ?", [memberName, now(), e.id])
}

/** Lock the expense's conversion rate at write time (the Locked-Rate rule). */
export function lockRate(eId: string, currency: string, settle: string): void {
  const r =
    currency === settle ? { rate: 1, provider: "same-currency", providerTimestamp: null } : crossRate(currency, settle)
  db.run("UPDATE expenses SET currency = ?, rate = ?, rate_provider = ?, rate_timestamp = ? WHERE id = ?", [
    currency,
    r?.rate ?? null,
    r?.provider ?? null,
    r?.providerTimestamp ?? null,
    eId,
  ])
}

/** Log a history event. One row per field change, plus 'created'/'deleted' events
 * so every record's life is visible. Call inside the mutation transaction
 * (the same `mutateTrip` block) so it commits with the change.
 */
export function logChange(
  tripToken: string,
  entity: { type: "expense" | "settlement"; id: string; name: string },
  kind: "created" | "deleted" | "changed",
  field: string | null = null,
  oldValue: HistoryValue | null = null,
  newValue: HistoryValue | null = null,
  by: string | null = null
) {
  db.run(
    "INSERT INTO expense_history (id, trip_token, entity_type, entity_id, entity_name, kind, field, old_value, new_value, by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [
      crypto.randomUUID(),
      tripToken,
      entity.type,
      entity.id,
      entity.name,
      kind,
      field,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      by,
      now(),
    ]
  )
}

/** Deep equality for structured history values (skips unchanged fields). */
function valueEq(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b
  const ka = (a as Record<string, unknown>) ?? null
  const kb = (b as Record<string, unknown>) ?? null
  if (ka !== null && kb !== null) {
    const keys = new Set([...Object.keys(ka), ...Object.keys(kb)])
    for (const k of keys) {
      const va = ka[k]
      const vb = kb[k]
      if (va === vb) continue
      if (typeof va === "object" && typeof vb === "object" && va !== null && vb !== null) {
        if (!valueEq(va, vb)) return false
      } else if (va !== vb) {
        return false
      }
    }
    return true
  }
  return a === b
}

/** Log a per-field change, comparing before/after structured snapshots. Skips
 * the row when the field is unchanged (the client can send a value that
 * matches the current one, in which case nothing actually changed).
 */
export function logField(
  tripToken: string,
  entity: { type: "expense" | "settlement"; id: string; name: string },
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  field: string,
  by: string | null = null
) {
  const old = before[field]
  const neu = after[field]
  if (valueEq(old, neu)) return
  logChange(tripToken, entity, "changed", field, old as HistoryValue, neu as HistoryValue, by)
}
