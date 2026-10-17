import { db } from "./db.ts";

// SSE fan-out: which listeners to wake when a trip's data changed.
// Journey-scoped changes wake every member trip's listeners — routes
// don't need to know that topology.

const listeners = new Map<string, Set<ReadableStreamDefaultController>>();

export function addListener(tripToken: string, c: ReadableStreamDefaultController) {
  if (!listeners.has(tripToken)) listeners.set(tripToken, new Set());
  listeners.get(tripToken)!.add(c);
}
export function removeListener(tripToken: string, c: ReadableStreamDefaultController) {
  listeners.get(tripToken)?.delete(c);
}

export function trip(token: string) {
  const set = listeners.get(token);
  if (!set) return;
  for (const c of set) {
    try { c.enqueue(`data: {"t":${Date.now()}}\n\n`); } catch { set.delete(c); }
  }
}

export function journey(journeyToken: string) {
  const trips = db.query<{ trip_token: string }, [string]>(
    "SELECT trip_token FROM journey_trips WHERE journey_token = ?",
  ).all(journeyToken);
  for (const t of trips) trip(t.trip_token);
}
