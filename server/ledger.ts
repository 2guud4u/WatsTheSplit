import { db, stmt } from "./db.ts";
import { decimals } from "./currencies.ts";
import type { Trip, Journey, Member, ExpenseRow } from "./types.ts";

// ---------- row loader ----------
// One load per trip (or journey), then every computation below is pure:
// rows in -> numbers/payloads out. Tests seed rows directly — no db needed
// on the compute side, no N+1s on the read side.

export type ItemRow = { id: string; name: string; price_minor: number; sharers: string[] };
export type PartRow = { member_id: string; share_minor: number | null; paid: number };
export type SettleRow = { from_member: string; to_member: string; amount_minor: number };

export type TripRows = {
  trip: Trip;
  members: Member[];
  expenses: ExpenseRow[];
  participants: Record<string, PartRow[]>;   // by expense_id
  items: Record<string, ItemRow[]>;          // by expense_id
  settlements: SettleRow[];
  photos: Record<string, string[]>;          // expense_id -> photo ids
};

export function loadTripRows(t: Trip): TripRows {
  const members = db.query<Member, [string]>(
    "SELECT * FROM members WHERE trip_token = ? ORDER BY name",
  ).all(t.token);
  const expenses = db.query<ExpenseRow, [string]>(
    "SELECT * FROM expenses WHERE trip_token = ? ORDER BY recorded_at DESC",
  ).all(t.token);
  const ids = expenses.map((e) => e.id);
  const in_ = `(${ids.map(() => "?").join(",")})`;
  const participants: TripRows["participants"] = {};
  const items: TripRows["items"] = {};
  const photos: TripRows["photos"] = {};
  if (ids.length) {
    for (const p of db.query<PartRow & { expense_id: string }, string[]>(
      `SELECT expense_id, member_id, share_minor, paid FROM expense_participants WHERE expense_id IN ${in_}`,
    ).all(...ids)) (participants[p.expense_id] ??= []).push(p);
    const sharersByItem = new Map<string, string[]>();
    for (const s of db.query<{ item_id: string; member_id: string }, string[]>(
      `SELECT item_id, member_id FROM item_sharers WHERE item_id IN
         (SELECT id FROM items WHERE expense_id IN ${in_})`,
    ).all(...ids)) sharersByItem.set(s.item_id, [...(sharersByItem.get(s.item_id) ?? []), s.member_id]);
    for (const i of db.query<{ id: string; expense_id: string; name: string; price_minor: number }, string[]>(
      `SELECT id, expense_id, name, price_minor FROM items WHERE expense_id IN ${in_} ORDER BY rowid`,
    ).all(...ids))
      (items[i.expense_id] ??= []).push({ id: i.id, name: i.name, price_minor: i.price_minor, sharers: sharersByItem.get(i.id) ?? [] });
    for (const p of db.query<{ id: string; expense_id: string }, string[]>(
      `SELECT id, expense_id FROM expense_photos WHERE expense_id IN ${in_} ORDER BY created_at`,
    ).all(...ids)) (photos[p.expense_id] ??= []).push(p.id);
  }
  const settlements = db.query<SettleRow, [string]>(
    "SELECT from_member, to_member, amount_minor FROM settlements WHERE trip_token = ?",
  ).all(t.token);
  return { trip: t, members, expenses, participants, items, settlements, photos };
}

export type JourneyRows = { journey: Journey; trips: TripRows[]; merges: JourneyMerge[] };

export function loadJourneyRows(j: Journey): JourneyRows {
  const merges = db.query<JourneyMerge, [string]>(
    "SELECT member_id, group_id FROM journey_merges WHERE journey_token = ?",
  ).all(j.token);
  return { journey: j, trips: journeyTrips(j).map(loadTripRows), merges };
}

// ---------- pure core ----------

// The one Locked-Rate rule: an expense in the settle currency converts at 1.
export const effectiveRate = (e: ExpenseRow, settleCurrency: string): number | null =>
  e.currency === settleCurrency ? 1 : e.rate;

const partsOf = (rows: TripRows, e: ExpenseRow): PartRow[] => rows.participants[e.id] ?? [];
const paidSet = (rows: TripRows, e: ExpenseRow): Set<string> =>
  new Set(partsOf(rows, e).filter((p) => p.paid).map((p) => p.member_id));

// Per-participant effective share in expense minor units.
// Hybrid: each member's share = typed share_minor + their portion of items
// (each item splits price equally among its sharers). NULL share_minor means
// "equal share of whatever is left" (the remainder): rest = total - fixed
// shares - item prices, spread evenly over participants whose share_minor is
// NULL. Rounding dust goes to the last remainder participant. Expenses with
// no NULL participants can still be unassigned/over — shown as badges.
export function effectiveShares(rows: TripRows, e: ExpenseRow): { member_id: string; minor: number | null }[] {
  const itemRows = rows.items[e.id] ?? [];
  const itemByMember: Record<string, number> = {};
  let itemTotal = 0;
  for (const i of itemRows) {
    itemTotal += i.price_minor;
    for (const mid of i.sharers) itemByMember[mid] = (itemByMember[mid] ?? 0) + i.price_minor / i.sharers.length;
  }
  const parts = partsOf(rows, e);
  const ids = new Set(parts.map((p) => p.member_id));
  for (const id of Object.keys(itemByMember)) ids.add(id);
  const remIds = parts.filter((p) => p.share_minor === null).map((p) => p.member_id);
  const fixed = parts.reduce((a, p) => a + (p.share_minor ?? 0), 0);
  const rest = Math.max(0, e.total_minor - fixed - itemTotal);
  const eachRest = remIds.length ? Math.floor(rest / remIds.length) : 0;
  let remLeftover = rest - eachRest * remIds.length;
  return [...ids].map((id) => {
    const itemPart = itemByMember[id] ?? 0;
    const typed = parts.find((p) => p.member_id === id)?.share_minor ?? null;
    let minor = Math.round(itemPart);
    if (typed !== null) minor += typed;
    else if (remIds.includes(id)) {
      minor += eachRest + (remLeftover > 0 ? 1 : 0);
      remLeftover -= remLeftover > 0 ? 1 : 0;
    }
    return { member_id: id, minor: minor > 0 || typed !== null || remIds.includes(id) ? minor : null };
  });
}

export function expensePayload(rows: TripRows, e: ExpenseRow, detail: boolean) {
  const shares = effectiveShares(rows, e);
  const paid = paidSet(rows, e);
  const assigned = shares.reduce((a, s) => a + (s.minor ?? 0), 0);
  const unassigned = e.total_minor - assigned;
  const nameOf = (id: string) => rows.members.find((m) => m.id === id)?.name ?? "?";
  const base: Record<string, unknown> = {
    id: e.id, name: e.name, currency: e.currency, total_minor: e.total_minor,
    payer_member_id: e.payer_member_id, category: e.category, recorded_at: e.recorded_at,
    rate: e.rate, rate_provider: e.rate_provider, rate_timestamp: e.rate_timestamp,
    last_edited_by: e.last_edited_by, last_edited_at: e.last_edited_at,
    assigned_minor: assigned, unassigned_minor: unassigned, over: unassigned < 0,
    // the payer fronted the money — "paid" only tracks the other participants
    paid_out: paid.size > 0 && shares.every((s) =>
      s.member_id === e.payer_member_id || s.minor === null || paid.has(s.member_id)),
    paid_count: [...paid].filter((id) => id !== e.payer_member_id).length,
    share_count: shares.filter((s) => s.minor !== null && s.member_id !== e.payer_member_id).length,
  };
  if (!detail) return base;
  base.participants = partsOf(rows, e).map((p) => ({ ...p, name: nameOf(p.member_id) }));
  base.items = (rows.items[e.id] ?? []).map((i) => ({ id: i.id, name: i.name, price_minor: i.price_minor, sharers: i.sharers }));
  base.effective_shares = shares;
  base.photos = rows.photos[e.id] ?? [];
  return base;
}

export function tripBalances(rows: TripRows) {
  const { trip: t, members } = rows;
  const dec = decimals(t.settle_currency);
  const owed: Record<string, number> = {}; // "from>to" -> units of settle currency
  // per-pair contribution log for the "math" view
  const log: Record<string, {
    kind: "expense" | "settlement";
    label: string; share_minor?: number; currency?: string; rate?: number | null;
    converted?: number; amount_minor?: number;
  }[]> = {};
  for (const e of rows.expenses) {
    if (!e.payer_member_id) continue;
    const rate = effectiveRate(e, t.settle_currency);
    if (rate === null) continue;
    const paid = paidSet(rows, e);
    for (const s of effectiveShares(rows, e)) {
      if (s.minor === null || s.member_id === e.payer_member_id) continue;
      if (paid.has(s.member_id)) continue; // participant marked their share paid
      const units = (s.minor / 10 ** decimals(e.currency)) * rate;
      const key = `${s.member_id}>${e.payer_member_id}`;
      owed[key] = (owed[key] ?? 0) + units;
      (log[key] ??= []).push({
        kind: "expense", label: e.name, share_minor: s.minor,
        currency: e.currency, rate, converted: units,
      });
    }
  }
  for (const s of rows.settlements) {
    const key = `${s.from_member}>${s.to_member}`;
    owed[key] = (owed[key] ?? 0) - s.amount_minor / 10 ** dec;
    (log[key] ??= []).push({
      kind: "settlement", label: "paid", amount_minor: -s.amount_minor,
    });
  }
  // net pairwise
  const pairs: { from: string; to: string; amount: number }[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(owed)) {
    const [a, b] = key.split(">");
    const rev = `${b}>${a}`;
    if (seen.has(key) || seen.has(rev)) continue;
    seen.add(key); seen.add(rev);
    const net = (owed[key] ?? 0) - (owed[rev] ?? 0);
    const epsilon = 0.5 / 10 ** dec;
    if (Math.abs(net) < epsilon) continue;
    pairs.push(net > 0
      ? { from: a, to: b, amount: Math.round(net * 10 ** dec) / 10 ** dec }
      : { from: b, to: a, amount: Math.round(-net * 10 ** dec) / 10 ** dec });
  }
  return { members, pairs, log };
}

// ---------- journeys ----------

export function journeyTrips(j: Journey): Trip[] {
  const qTrip = stmt<Trip, [string]>("SELECT * FROM trips WHERE token = ?");
  return db.query<{ trip_token: string }, [string]>(
    "SELECT trip_token FROM journey_trips WHERE journey_token = ?",
  ).all(j.token).map((r) => qTrip.get(r.trip_token)).filter((t): t is Trip => !!t);
}

export type JourneyMember = Member & { trip_name?: string };
type JourneyMerge = { member_id: string; group_id: string };

// Person key: linked members share their user_sub; manual merges share a
// group_id; otherwise the member stands alone.
export function journeyPeople(jr: JourneyRows): { persons: Map<string, { name: string; memberIds: string[]; linked: boolean }>; keyOf: (m: JourneyMember) => string } {
  const groupOf = new Map(jr.merges.map((m) => [m.member_id, m.group_id]));
  const allMembers: JourneyMember[] = [];
  for (const tr of jr.trips) {
    for (const m of tr.members) allMembers.push({ ...m, trip_name: tr.trip.name });
  }
  const persons = new Map<string, { name: string; memberIds: string[]; linked: boolean }>();
  const keyOf = (m: JourneyMember) =>
    groupOf.get(m.id) ?? (m.user_sub ? `u:${m.user_sub}` : `m:${m.id}`);
  // prefer the linked member's name for a group's label
  const label = (ids: string[]) => {
    const ms = ids.map((id) => allMembers.find((m) => m.id === id)!).filter(Boolean);
    return (ms.find((m) => m.user_sub) ?? ms[0])?.name ?? "?";
  };
  const byKey = new Map<string, string[]>();
  for (const m of allMembers) {
    const k = keyOf(m);
    byKey.set(k, [...(byKey.get(k) ?? []), m.id]);
  }
  for (const [k, ids] of byKey) {
    persons.set(k, { name: label(ids), memberIds: ids, linked: ids.some((id) => allMembers.find((m) => m.id === id)?.user_sub) });
  }
  return { persons, keyOf };
}

// Journey "who owes who": each trip's own pairwise debts (the same numbers the
// trip page shows), re-keyed by Person and summed across trips. No cross-person
// simplification, so every card decomposes into real per-trip debts that can be
// settled trip by trip. All trips share one Settlement Currency (enforced on add).
export function journeyBalance(jr: JourneyRows) {
  const { persons, keyOf } = journeyPeople(jr);
  const dec = decimals(jr.journey.settle_currency);
  type Part = { trip_token: string; trip_name: string; from_member: string; to_member: string; from_key: string; amount: number };
  const pairs = new Map<string, { from_key: string; to_key: string; amount: number; parts: Part[] }>();
  for (const tr of jr.trips) {
    const { members, pairs: tripPairs } = tripBalances(tr);
    const byId = new Map(members.map((m) => [m.id, m]));
    for (const p of tripPairs) {
      const a = byId.get(p.from), b = byId.get(p.to);
      if (!a || !b) continue;
      let fk = keyOf(a), tk = keyOf(b), amt = p.amount;
      if (fk === tk) continue; // same Person on both sides after a merge
      // one entry per unordered Person pair, summed in a canonical direction
      if (fk > tk) { [fk, tk] = [tk, fk]; amt = -amt; }
      const key = `${fk}>${tk}`;
      const cur = pairs.get(key) ?? { from_key: fk, to_key: tk, amount: 0, parts: [] };
      cur.amount += amt;
      cur.parts.push({ trip_token: tr.trip.token, trip_name: tr.trip.name, from_member: p.from, to_member: p.to, from_key: keyOf(a), amount: p.amount });
      pairs.set(key, cur);
    }
  }
  const eps = 0.5 / 10 ** dec;
  const round = (v: number) => Math.round(v * 10 ** dec) / 10 ** dec;
  const transfers = [...pairs.values()].filter((p) => Math.abs(p.amount) >= eps).map((p) => {
    const fwd = p.amount > 0;
    const from_key = fwd ? p.from_key : p.to_key, to_key = fwd ? p.to_key : p.from_key;
    return {
      from: persons.get(from_key)?.name ?? "?", to: persons.get(to_key)?.name ?? "?",
      from_key, to_key, amount: round(Math.abs(p.amount)),
      // per-trip debts; `against` marks a trip where the card's payee owes the payer
      parts: p.parts.map(({ from_key: pk, ...x }) => ({ ...x, amount: round(x.amount), against: pk !== from_key })),
    };
  });
  return { transfers };
}
