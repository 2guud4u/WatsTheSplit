import { decimals } from "./currencies.ts";
import { effectiveRate, effectiveShares, type TripRows } from "./ledger.ts";
import type { TripReview } from "../shared/wire.ts";

// Wrapped: silly awards computed from expense data, in settle-currency units.
// Stats are collected per trip keyed by member id; awards are then built over
// member ids (Trip Wrapped) or merged person keys (Journey Wrapped).
// Pure read: rows in -> awards out.

export type TripStats = {
  paid: Record<string, number>;       // settle units paid
  consumed: Record<string, number>;   // settle units owed
  payerCount: Record<string, number>; // expenses paid
  partCount: Record<string, number>;  // expenses shared in
  owed: Record<string, number>;       // consumed minus settled
  createdCount: Record<string, number>;
  typedCount: Record<string, number>;
  biggestShare: Record<string, number>;
  catShare: Record<string, number>;   // "cat>member" -> share units
  catTotal: Record<string, number>;
  pairShare: Record<string, number>;  // "a>b" -> co-share count
  tripleShare: Record<string, number>;
  quadShare: Record<string, number>;  // "a>b>c>d" -> co-share count
  settlePair: Record<string, number>;
  settleSum: Record<string, number>;  // "a>b" -> settle units moved
  catCombo: Record<string, number>;   // "cat>a>b[>c[>d]]" -> combo members' share units
  duoOnly: Record<string, number>;    // "a>b" -> expenses shared by exactly the two
  trioOnly: Record<string, number>;   // same for exactly three
  hourPair: Record<string, number>;   // "am|pm>a>b" -> co-shares before 9am / after 9pm
  coverPair: Record<string, number>;  // "payer>sharer" -> times payer fronted for sharer
  coveredBy: Record<string, Set<string>>; // payer -> distinct people they covered
  itemLines: Record<string, number>;  // member -> itemized lines under their name
  memberDay: Record<string, number>;  // "member>YYYY-MM-DD" -> share units
  currencies: Record<string, Set<string>>;
  paidTrip: Set<string>;    // paid at least one expense (this trip)
  coveredTrip: Set<string>; // paid an expense someone else shared (this trip)
  biggestExp: { name: string; units: number; sharers: string[] } | null;
  crowdExp: { name: string; units: number; sharers: string[] } | null;  // most people on one expense
  dinnerExp: { name: string; units: number; sharers: string[] } | null; // biggest expense with a full-ish table
  allIn: number;            // expenses every eligible member shared
  daySpend: Record<string, number>; // "YYYY-MM-DD" -> spend in settle units
  totalSpend: number;
  nExp: number;
};

export function emptyStats(): TripStats {
  return {
    paid: {}, consumed: {}, payerCount: {}, partCount: {}, owed: {},
    createdCount: {}, typedCount: {}, biggestShare: {}, catShare: {},
    catTotal: {}, pairShare: {}, tripleShare: {}, quadShare: {}, settlePair: {},
    settleSum: {}, catCombo: {}, duoOnly: {}, trioOnly: {}, hourPair: {},
    coverPair: {}, coveredBy: {}, itemLines: {}, memberDay: {},
    currencies: {}, paidTrip: new Set(), coveredTrip: new Set(),
    crowdExp: null, dinnerExp: null, allIn: 0,
    daySpend: {}, biggestExp: null, totalSpend: 0, nExp: 0,
  };
}

export const add = (rec: Record<string, number>, k: string, v: number) => { rec[k] = (rec[k] ?? 0) + v; };

// All sorted-size subsets of sorted ids. Bounded by caller (combo loops only
// run when ids.length <= 10 to keep the stats maps small).
function* subsets(ids: string[], size: number): Generator<string[]> {
  const idx: number[] = [];
  function* rec(start: number): Generator<string[]> {
    if (idx.length === size) { yield idx.map((i) => ids[i]); return; }
    for (let i = start; i <= ids.length - (size - idx.length); i++) {
      idx.push(i); yield* rec(i + 1); idx.pop();
    }
  }
  yield* rec(0);
}


export function collectStats(rows: TripRows): TripStats {
  const { trip: t, members } = rows;
  const out = new Set(members.filter((m) => m.opted_out_fun).map((m) => m.id));
  const dec = decimals(t.settle_currency);
  const st = emptyStats();

  for (const e of rows.expenses) {
    if (e.created_by_member_id && !out.has(e.created_by_member_id))
      add(st.createdCount, e.created_by_member_id, 1);
    const rate = effectiveRate(e, t.settle_currency);
    if (rate === null) continue;
    const totalUnits = (e.total_minor / 10 ** decimals(e.currency)) * rate;
    if (e.payer_member_id && !out.has(e.payer_member_id)) {
      add(st.paid, e.payer_member_id, totalUnits);
      add(st.payerCount, e.payer_member_id, 1);
      st.paidTrip.add(e.payer_member_id);
      (st.currencies[e.payer_member_id] ??= new Set()).add(e.currency);
    }
    const sharers = effectiveShares(rows, e).filter((s) => (s.minor ?? 0) > 0);
    const sharerIds = sharers.map((s) => s.member_id);
    if (e.payer_member_id && sharerIds.some((id) => id !== e.payer_member_id))
      st.coveredTrip.add(e.payer_member_id);
    st.nExp += 1;
    for (const s of sharers) {
      if (out.has(s.member_id)) continue;
      const units = (s.minor! / 10 ** decimals(e.currency)) * rate;
      add(st.consumed, s.member_id, units);
      st.totalSpend += units;
      add(st.daySpend, e.recorded_at.slice(0, 10), units);
      add(st.partCount, s.member_id, 1);
      st.biggestShare[s.member_id] = Math.max(st.biggestShare[s.member_id] ?? 0, units);
      add(st.memberDay, `${s.member_id}>${e.recorded_at.slice(0, 10)}`, units);
      if (e.payer_member_id && !out.has(e.payer_member_id) && s.member_id !== e.payer_member_id) {
        add(st.coverPair, `${e.payer_member_id}>${s.member_id}`, 1);
        (st.coveredBy[e.payer_member_id] ??= new Set()).add(s.member_id);
      }
      (st.currencies[s.member_id] ??= new Set()).add(e.currency);
      if (s.member_id !== e.payer_member_id) add(st.owed, s.member_id, units);
      if (e.category) {
        add(st.catShare, `${e.category}>${s.member_id}`, units);
        add(st.catTotal, e.category, units);
      }
    }
    if (!st.biggestExp || totalUnits > st.biggestExp.units)
      st.biggestExp = { name: e.name, units: totalUnits, sharers: sharerIds.filter((id) => !out.has(id)) };
    for (const it of rows.items[e.id] ?? [])
      for (const mid of it.sharers)
        if (!out.has(mid)) add(st.itemLines, mid, 1);
    for (const p of rows.participants[e.id] ?? [])
      if (p.share_minor !== null && !out.has(p.member_id))
        add(st.typedCount, p.member_id, 1);
    const ids = sharerIds.filter((id) => !out.has(id)).sort();
    const eligible = members.length - out.size;
    if (ids.length === eligible && eligible >= 3) st.allIn += 1;
    if (!st.crowdExp || ids.length > st.crowdExp.sharers.length)
      st.crowdExp = { name: e.name, units: totalUnits, sharers: ids };
    if (ids.length >= Math.min(4, eligible) && (!st.dinnerExp || totalUnits > st.dinnerExp.units))
      st.dinnerExp = { name: e.name, units: totalUnits, sharers: ids };
    // time-of-day buckets are whatever clock stamped recorded_at — good
    // enough for silly "early birds / last call" awards
    const hour = Number(e.recorded_at.slice(11, 13));
    const daypart = hour < 9 ? "am" : hour >= 21 ? "pm" : null;
    if (ids.length <= 10) {
      const comboUnits = sharers.filter((s) => !out.has(s.member_id))
        .reduce((sum, s) => sum + (s.minor! / 10 ** decimals(e.currency)) * rate, 0);
      for (const c of subsets(ids, 2)) {
        const k = c.join(">");
        add(st.pairShare, k, 1);
        if (daypart) add(st.hourPair, `${daypart}>${k}`, 1);
        if (e.category) add(st.catCombo, `${e.category}>${k}`, comboUnits);
      }
      for (const c of subsets(ids, 3)) {
        const k = c.join(">");
        add(st.tripleShare, k, 1);
        if (e.category) add(st.catCombo, `${e.category}>${k}`, comboUnits);
      }
      for (const c of subsets(ids, 4)) {
        const k = c.join(">");
        add(st.quadShare, k, 1);
        if (e.category) add(st.catCombo, `${e.category}>${k}`, comboUnits);
      }
      if (ids.length === 2) add(st.duoOnly, ids.join(">"), 1);
      if (ids.length === 3) add(st.trioOnly, ids.join(">"), 1);
    }
  }
  for (const s of rows.settlements) {
    if (out.has(s.from_member) || out.has(s.to_member)) continue;
    const pk = [s.from_member, s.to_member].sort().join(">");
    add(st.settlePair, pk, 1);
    add(st.settleSum, pk, s.amount_minor / 10 ** dec);
    add(st.owed, s.from_member, -s.amount_minor / 10 ** dec);
  }
  return st;
}

// Re-key member stats onto person keys (journey merges / linked sign-ins).
export function mergeInto(dst: TripStats, src: TripStats, keyOf: (id: string) => string) {
  for (const f of ["paid", "consumed", "payerCount", "partCount", "owed", "createdCount", "typedCount"] as const)
    for (const [k, v] of Object.entries(src[f])) add(dst[f], keyOf(k), v);
  for (const [k, v] of Object.entries(src.biggestShare)) {
    const nk = keyOf(k);
    dst.biggestShare[nk] = Math.max(dst.biggestShare[nk] ?? 0, v);
  }
  for (const [k, v] of Object.entries(src.catShare)) {
    const [cat, mid] = k.split(">");
    add(dst.catShare, `${cat}>${keyOf(mid)}`, v);
  }
  for (const [k, v] of Object.entries(src.catTotal)) add(dst.catTotal, k, v);
  for (const f of ["pairShare", "tripleShare", "quadShare", "settlePair", "settleSum", "duoOnly", "trioOnly"] as const)
    for (const [k, v] of Object.entries(src[f])) {
      const orig = k.split(">");
      const parts = [...new Set(orig.map(keyOf))].sort();
      if (parts.length !== orig.length) continue; // collapses onto one person
      add(dst[f], parts.join(">"), v);
    }
  for (const [k, v] of Object.entries(src.catCombo)) {
    const [cat, ...orig] = k.split(">");
    const parts = [...new Set(orig.map(keyOf))].sort();
    if (parts.length !== orig.length) continue;
    add(dst.catCombo, `${cat}>${parts.join(">")}`, v);
  }
  for (const [k, v] of Object.entries(src.hourPair)) {
    const [bucket, ...orig] = k.split(">");
    const parts = [...new Set(orig.map(keyOf))].sort();
    if (parts.length !== orig.length) continue;
    add(dst.hourPair, `${bucket}>${parts.join(">")}`, v);
  }
  for (const [k, v] of Object.entries(src.coverPair)) {
    const [payer, sharer] = k.split(">").map(keyOf);
    if (payer === sharer) continue;
    add(dst.coverPair, `${payer}>${sharer}`, v);
  }
  for (const [k, set] of Object.entries(src.coveredBy)) {
    const d = (dst.coveredBy[keyOf(k)] ??= new Set());
    for (const id of set) { const nk = keyOf(id); if (nk !== keyOf(k)) d.add(nk); }
  }
  for (const [k, v] of Object.entries(src.itemLines)) add(dst.itemLines, keyOf(k), v);
  for (const [k, v] of Object.entries(src.memberDay)) {
    const [mid, day] = k.split(">");
    add(dst.memberDay, `${keyOf(mid)}>${day}`, v);
  }
  for (const [k, set] of Object.entries(src.currencies)) {
    const nk = keyOf(k);
    const d = (dst.currencies[nk] ??= new Set());
    for (const c of set) d.add(c);
  }
  for (const id of src.paidTrip) dst.paidTrip.add(keyOf(id));
  for (const id of src.coveredTrip) dst.coveredTrip.add(keyOf(id));
  if (src.biggestExp && (!dst.biggestExp || src.biggestExp.units > dst.biggestExp.units))
    dst.biggestExp = { name: src.biggestExp.name, units: src.biggestExp.units, sharers: [...new Set(src.biggestExp.sharers.map(keyOf))] };
  dst.totalSpend += src.totalSpend;
  dst.nExp += src.nExp;
  for (const [k, v] of Object.entries(src.daySpend)) add(dst.daySpend, k, v);
}


// The "Trip in Review" stats layer: formatted totals + breakdowns, all in
// settle-currency units. Entities carry the display names (member names for a
// trip, person names for a journey).
export function review(st: TripStats, entities: Entity[], fmtU: (v: number) => string): TripReview {
  const currencies = [...new Set(Object.values(st.currencies).flatMap((s) => [...s]))].sort();
  const daily = Object.entries(st.daySpend).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([day, units]) => ({ day, units }));
  const biggestDay = top(st.daySpend);
  const members = entities
    .filter((e) => (st.consumed[e.key] ?? 0) > 0 || (st.paid[e.key] ?? 0) > 0)
    .map((e) => ({
      name: e.name,
      consumed: fmtU(st.consumed[e.key] ?? 0),
      covered: fmtU(st.paid[e.key] ?? 0),
      count: st.partCount[e.key] ?? 0,
    }))
    .sort((a, b) => parseFloat(b.consumed) - parseFloat(a.consumed));
  return {
    total: fmtU(st.totalSpend),
    expenseCount: st.nExp,
    currencies,
    biggest: st.biggestExp ? { name: st.biggestExp.name, total: fmtU(st.biggestExp.units) } : null,
    biggestDay: biggestDay ? { date: biggestDay.key, total: fmtU(biggestDay.v) } : null,
    categories: Object.entries(st.catTotal).sort((a, b) => b[1] - a[1])
      .map(([cat, units]) => ({ cat, units })),
    members,
    daily,
  };
}
export type Entity = { key: string; name: string; views: number };

export function top(rec: Record<string, number>, min = 0): { key: string; v: number } | null {
  let best: { key: string; v: number } | null = null;
  for (const k of Object.keys(rec))
    if (rec[k] > (best?.v ?? min)) best = { key: k, v: rec[k] };
  return best;
}
