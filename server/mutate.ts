import { db } from "./db.ts";
import * as notify from "./notify.ts";
import { crossRate } from "./fx.ts";

// One seam for every trip/journey mutation: writes run inside a transaction,
// SSE fan-out fires only after commit. Throw `Abort(err(...))` from inside an
// operation to roll back and return that error Response; anything else thrown
// rolls back and propagates.

class Abort extends Error {
  constructor(public res: Response) { super("abort"); }
}

export const abort = (res: Response): never => { throw new Abort(res); };

function transact<T>(fn: () => T): T | Response {
  const tx = db.transaction(fn);
  try { return tx(); }
  catch (e) {
    if (e instanceof Abort) return e.res;
    throw e;
  }
}

/** Trip-scoped mutation: transaction + notify.trip after commit. */
// A Response returned *from* fn is passed through; fan-out fires only for
// success (<400). Use abort(err(...)) after writes to force a rollback.
function mutate_<T>(fanout: () => void, fn: () => T): T | Response {
  const r = transact(fn);
  if (!(r instanceof Response) || r.status < 400) fanout();
  return r;
}

/** Trip-scoped mutation: transaction + notify.trip after commit. */
export function mutateTrip<T>(tripToken: string, fn: () => T): T | Response {
  return mutate_(() => notify.trip(tripToken), fn);
}

/** Journey-scoped mutation: transaction + fan-out to every member trip. */
export function mutateJourney<T>(journeyToken: string, fn: () => T): T | Response {
  return mutate_(() => notify.journey(journeyToken), fn);
}

/** Untyped mutation (auth, session linking): transaction, no fan-out. */
export function mutate<T>(fn: () => T): T | Response {
  return transact(fn);
}

const now = () => new Date().toISOString();

/** Stamp the expense's last-editor + time. */
export function edited(e: { id: string }, memberName: string | null) {
  db.run("UPDATE expenses SET last_edited_by = ?, last_edited_at = ? WHERE id = ?", [
    memberName, now(), e.id,
  ]);
}

/** Lock the expense's conversion rate at write time (the Locked-Rate rule). */
export function lockRate(eId: string, currency: string, settle: string): void {
  const r = currency === settle
    ? { rate: 1, provider: "same-currency", providerTimestamp: null }
    : crossRate(currency, settle);
  db.run(
    "UPDATE expenses SET currency = ?, rate = ?, rate_provider = ?, rate_timestamp = ? WHERE id = ?",
    [currency, r?.rate ?? null, r?.provider ?? null, r?.providerTimestamp ?? null, eId],
  );
}
