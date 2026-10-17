import { db } from "./db.ts";
import { decimals } from "./currencies.ts";
import { crossRate } from "./fx.ts";
import type { Trip, Journey, Member, ExpenseRow } from "./types.ts";

const qMember = db.prepare<Member, [string]>("SELECT * FROM members WHERE id = ?");
const qTrip = db.prepare<Trip, [string]>("SELECT * FROM trips WHERE token = ?");

export function sharesForExpense(expenseId: string): { member_id: string; share_minor: number | null }[] {
  return db.query<{ member_id: string; share_minor: number | null }, [string]>(
    "SELECT member_id, share_minor FROM expense_participants WHERE expense_id = ?",
  ).all(expenseId);
}


// Per-participant effective share in expense minor units.
// Hybrid: each member's share = typed share_minor + their portion of items
// (each item splits price equally among its sharers). NULL share_minor means
// "equal share of whatever is left" (the remainder): rest = total - fixed
// shares - item prices, spread evenly over participants whose share_minor is
// NULL. Rounding dust goes to the last remainder participant. Expenses with
// no NULL participants can still be unassigned/over — shown as badges.
export function effectiveShares(e: ExpenseRow): { member_id: string; minor: number | null }[] {
  const itemRows = db.query<{ member_id: string; price_minor: number; n: number }, [string]>(
    `SELECT s.member_id, i.price_minor, (SELECT COUNT(*) FROM item_sharers x WHERE x.item_id = i.id) AS n
     FROM item_sharers s JOIN items i ON i.id = s.item_id WHERE i.expense_id = ?`,
  ).all(e.id);
  const itemByMember: Record<string, number> = {};
  let itemTotal = 0;
  for (const r of itemRows) {
    itemByMember[r.member_id] = (itemByMember[r.member_id] ?? 0) + r.price_minor / r.n;
  }
  itemTotal = db.query<{ t: number }, [string]>(
    "SELECT COALESCE(SUM(price_minor),0) t FROM items WHERE expense_id = ?",
  ).get(e.id)!.t;
  const parts = db.query<{ member_id: string; share_minor: number | null; paid: number }, [string]>(
    "SELECT member_id, share_minor, paid FROM expense_participants WHERE expense_id = ?",
  ).all(e.id);
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

// Set of participant member_ids whose share is marked paid.
export function paidMembers(expenseId: string): Set<string> {
  return new Set(db.query<{ member_id: string }, [string]>(
    "SELECT member_id FROM expense_participants WHERE expense_id = ? AND paid = 1",
  ).all(expenseId).map((r) => r.member_id));
}



export function expensePayload(e: ExpenseRow, detail: boolean) {
  const shares = effectiveShares(e);
  const assigned = shares.reduce((a, s) => a + (s.minor ?? 0), 0);
  const unassigned = e.total_minor - assigned;
  const base: Record<string, unknown> = {
    id: e.id, name: e.name, currency: e.currency, total_minor: e.total_minor,
    payer_member_id: e.payer_member_id, category: e.category, recorded_at: e.recorded_at,
    rate: e.rate, rate_provider: e.rate_provider, rate_timestamp: e.rate_timestamp,
    last_edited_by: e.last_edited_by, last_edited_at: e.last_edited_at,
    assigned_minor: assigned, unassigned_minor: unassigned, over: unassigned < 0,
    paid_out: paidMembers(e.id).size > 0 && shares.every((s) => s.minor === null || paidMembers(e.id).has(s.member_id)),
    paid_count: paidMembers(e.id).size,
    share_count: shares.filter((s) => s.minor !== null).length,
  };
  if (!detail) return base;
  base.participants = db.query<{ member_id: string; share_minor: number | null; name: string; paid: number }, [string]>(
    `SELECT p.member_id, p.share_minor, p.paid, m.name FROM expense_participants p
     JOIN members m ON m.id = p.member_id WHERE p.expense_id = ?`,
  ).all(e.id);
  base.items = db.query<{ id: string; name: string; price_minor: number }, [string]>(
    "SELECT id, name, price_minor FROM items WHERE expense_id = ? ORDER BY rowid",
  ).all(e.id).map((i) => ({
    ...i,
    sharers: db.query<{ member_id: string }, [string]>(
      "SELECT member_id FROM item_sharers WHERE item_id = ?",
    ).all(i.id).map((s) => s.member_id),
  }));
  base.effective_shares = shares;
  base.photos = db.query<{ id: string }, [string]>(
    "SELECT id FROM expense_photos WHERE expense_id = ? ORDER BY created_at",
  ).all(e.id).map((p) => p.id);
  return base;
}

export function tripBalances(t: Trip) {
  const members = db.query<Member, [string]>(
    "SELECT * FROM members WHERE trip_token = ? ORDER BY name",
  ).all(t.token);
  const dec = decimals(t.settle_currency);
  const owed: Record<string, number> = {}; // "from>to" -> units of settle currency
  // per-pair contribution log for the "math" view
  const log: Record<string, {
    kind: "expense" | "settlement";
    label: string; share_minor?: number; currency?: string; rate?: number | null;
    converted?: number; amount_minor?: number;
  }[]> = {};
  for (const e of db.query<ExpenseRow, [string]>(
    "SELECT * FROM expenses WHERE trip_token = ?",
  ).all(t.token)) {
    if (!e.payer_member_id) continue;
    if (e.paid_out) continue; // payer marked it reimbursed — shares count for nothing
    const rate = e.currency === t.settle_currency ? 1 : e.rate;
    if (rate === null) continue;
    for (const s of effectiveShares(e)) {
      if (s.minor === null || s.member_id === e.payer_member_id) continue;
      const units = (s.minor / 10 ** decimals(e.currency)) * rate;
      const key = `${s.member_id}>${e.payer_member_id}`;
      owed[key] = (owed[key] ?? 0) + units;
      (log[key] ??= []).push({
        kind: "expense", label: e.name, share_minor: s.minor,
        currency: e.currency, rate, converted: units,
      });
    }
  }
  for (const s of db.query<{ from_member: string; to_member: string; amount_minor: number }, [string]>(
    "SELECT from_member, to_member, amount_minor FROM settlements WHERE trip_token = ?",
  ).all(t.token)) {
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
// A Journey reads each member trip's per-person net position (in that trip's
// settle currency), converts to the Journey Currency at the current rate,
// sums per Person, then simplifies to minimal transfers.


export function journeyTrips(j: Journey): Trip[] {
  return db.query<{ trip_token: string }, [string]>(
    "SELECT trip_token FROM journey_trips WHERE journey_token = ?",
  ).all(j.token).map((r) => qTrip.get(r.trip_token)).filter((t): t is Trip => !!t);
}

// Per-member net in settle-currency *units* (positive = owed money).
function netPositions(t: Trip): Map<string, number> {
  const dec = decimals(t.settle_currency);
  const net = new Map<string, number>();
  const add = (id: string, v: number) => net.set(id, (net.get(id) ?? 0) + v);
  for (const e of db.query<ExpenseRow, [string]>(
    "SELECT * FROM expenses WHERE trip_token = ?",
  ).all(t.token)) {
    if (!e.payer_member_id) continue;
    const paid = paidMembers(e.id);
    const rate = e.currency === t.settle_currency ? 1 : e.rate;
    if (rate === null) continue;
    for (const s of effectiveShares(e)) {
      if (s.minor === null || paid.has(s.member_id)) continue;
      const units = (s.minor / 10 ** decimals(e.currency)) * rate;
      add(e.payer_member_id, units);
      if (s.member_id !== e.payer_member_id) add(s.member_id, -units);
    }
  }
  for (const s of db.query<{ from_member: string; to_member: string; amount_minor: number }, [string]>(
    "SELECT from_member, to_member, amount_minor FROM settlements WHERE trip_token = ?",
  ).all(t.token)) {
    add(s.from_member, s.amount_minor / 10 ** dec);
    add(s.to_member, -s.amount_minor / 10 ** dec);
  }
  return net;
}

export type JourneyMember = Member & { trip_name?: string };

// Person key: linked members share their user_sub; manual merges share a
// group_id; otherwise the member stands alone.
export function journeyPeople(j: Journey): { persons: Map<string, { name: string; memberIds: string[]; linked: boolean }>; keyOf: (m: JourneyMember) => string } {
  const merges = db.query<{ member_id: string; group_id: string }, [string]>(
    "SELECT member_id, group_id FROM journey_merges WHERE journey_token = ?",
  ).all(j.token);
  const groupOf = new Map(merges.map((m) => [m.member_id, m.group_id]));
  const allMembers: JourneyMember[] = [];
  for (const t of journeyTrips(j)) {
    for (const m of db.query<Member, [string]>(
      "SELECT * FROM members WHERE trip_token = ? ORDER BY name",
    ).all(t.token)) allMembers.push({ ...m, trip_name: t.name });
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

export function journeyBalance(j: Journey) {
  const { persons, keyOf } = journeyPeople(j);
  const jDec = decimals(j.settle_currency);
  const net = new Map<string, number>(); // person key -> journey-currency units
  const perTrip: { token: string; name: string; settle_currency: string; converted: boolean; balances: { person: string; net: number }[] }[] = [];
  for (const t of journeyTrips(j)) {
    const nets = netPositions(t);
    const conv = t.settle_currency === j.settle_currency
      ? { rate: 1 }
      : crossRate(t.settle_currency, j.settle_currency);
    const members = db.query<Member, [string]>("SELECT * FROM members WHERE trip_token = ?").all(t.token);
    const rows: { person: string; net: number }[] = [];
    for (const [mid, v] of nets) {
      const m = members.find((mm) => mm.id === mid);
      if (!m || Math.abs(v) < 1e-9) continue;
      const key = keyOf(m);
      const person = persons.get(key)?.name ?? m.name;
      rows.push({ person, net: v });
      if (conv) net.set(key, (net.get(key) ?? 0) + v * conv.rate);
    }
    perTrip.push({ token: t.token, name: t.name, settle_currency: t.settle_currency, converted: !!conv, balances: rows.sort((a, b) => a.net - b.net) });
  }
  // greedy simplify: largest debtor pays largest creditor
  const debtors = [...net.entries()].filter(([, v]) => v < -1e-6).map(([k, v]) => ({ k, v: -v })).sort((a, b) => b.v - a.v);
  const creditors = [...net.entries()].filter(([, v]) => v > 1e-6).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
  const transfers: { from: string; to: string; amount: number }[] = [];
  let i = 0, jj = 0;
  while (i < debtors.length && jj < creditors.length) {
    const pay = Math.min(debtors[i].v, creditors[jj].v);
    transfers.push({
      from: persons.get(debtors[i].k)?.name ?? "?",
      to: persons.get(creditors[jj].k)?.name ?? "?",
      amount: Math.round(pay * 10 ** jDec) / 10 ** jDec,
    });
    debtors[i].v -= pay; creditors[jj].v -= pay;
    if (debtors[i].v < 1e-6) i++;
    if (creditors[jj].v < 1e-6) jj++;
  }
  const positions = [...net.entries()].map(([k, v]) => ({
    person: persons.get(k)?.name ?? "?", net: Math.round(v * 10 ** jDec) / 10 ** jDec,
  })).sort((a, b) => a.net - b.net);
  return { transfers, positions, perTrip };
}

