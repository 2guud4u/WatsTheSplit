import { decimals } from "./currencies.ts";
import type { Member } from "./types.ts";
import { effectiveRate, effectiveShares, journeyPeople, type TripRows, type JourneyRows, type JourneyMember } from "./ledger.ts";

// Wrapped: silly awards computed from expense data, in settle-currency units.
// Stats are collected per trip keyed by member id; awards are then built over
// member ids (Trip Wrapped) or merged person keys (Journey Wrapped).
// Pure read: rows in -> awards out.

type TripStats = {
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
  settlePair: Record<string, number>;
  currencies: Record<string, Set<string>>;
  paidTrip: Set<string>;    // paid at least one expense (this trip)
  coveredTrip: Set<string>; // paid an expense someone else shared (this trip)
  biggestExp: { units: number; sharers: string[] } | null;
  totalSpend: number;
  nExp: number;
};

function emptyStats(): TripStats {
  return {
    paid: {}, consumed: {}, payerCount: {}, partCount: {}, owed: {},
    createdCount: {}, typedCount: {}, biggestShare: {}, catShare: {},
    catTotal: {}, pairShare: {}, tripleShare: {}, settlePair: {},
    currencies: {}, paidTrip: new Set(), coveredTrip: new Set(),
    biggestExp: null, totalSpend: 0, nExp: 0,
  };
}

const add = (rec: Record<string, number>, k: string, v: number) => { rec[k] = (rec[k] ?? 0) + v; };

function collectStats(rows: TripRows): TripStats {
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
      add(st.partCount, s.member_id, 1);
      st.biggestShare[s.member_id] = Math.max(st.biggestShare[s.member_id] ?? 0, units);
      (st.currencies[s.member_id] ??= new Set()).add(e.currency);
      if (s.member_id !== e.payer_member_id) add(st.owed, s.member_id, units);
      if (e.category) {
        add(st.catShare, `${e.category}>${s.member_id}`, units);
        add(st.catTotal, e.category, units);
      }
    }
    if (!st.biggestExp || totalUnits > st.biggestExp.units)
      st.biggestExp = { units: totalUnits, sharers: sharerIds.filter((id) => !out.has(id)) };
    for (const p of rows.participants[e.id] ?? [])
      if (p.share_minor !== null && !out.has(p.member_id))
        add(st.typedCount, p.member_id, 1);
    const ids = sharerIds.filter((id) => !out.has(id)).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      add(st.pairShare, `${ids[i]}>${ids[j]}`, 1);
      for (let l = j + 1; l < ids.length; l++)
        add(st.tripleShare, `${ids[i]}>${ids[j]}>${ids[l]}`, 1);
    }
  }
  for (const s of rows.settlements) {
    if (out.has(s.from_member) || out.has(s.to_member)) continue;
    add(st.settlePair, [s.from_member, s.to_member].sort().join(">"), 1);
    add(st.owed, s.from_member, -s.amount_minor / 10 ** dec);
  }
  return st;
}

// Re-key member stats onto person keys (journey merges / linked sign-ins).
function mergeInto(dst: TripStats, src: TripStats, keyOf: (id: string) => string) {
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
  for (const f of ["pairShare", "tripleShare", "settlePair"] as const)
    for (const [k, v] of Object.entries(src[f])) {
      const orig = k.split(">");
      const parts = [...new Set(orig.map(keyOf))].sort();
      if (parts.length !== orig.length) continue; // collapses onto one person
      add(dst[f], parts.join(">"), v);
    }
  for (const [k, set] of Object.entries(src.currencies)) {
    const nk = keyOf(k);
    const d = (dst.currencies[nk] ??= new Set());
    for (const c of set) d.add(c);
  }
  for (const id of src.paidTrip) dst.paidTrip.add(keyOf(id));
  for (const id of src.coveredTrip) dst.coveredTrip.add(keyOf(id));
  if (src.biggestExp && (!dst.biggestExp || src.biggestExp.units > dst.biggestExp.units))
    dst.biggestExp = { units: src.biggestExp.units, sharers: [...new Set(src.biggestExp.sharers.map(keyOf))] };
  dst.totalSpend += src.totalSpend;
  dst.nExp += src.nExp;
}

type Entity = { key: string; name: string; views: number };
type Award = { emoji: string; title: string; members: string[]; detail: string; score?: number };

function top(rec: Record<string, number>, min = 0): { key: string; v: number } | null {
  let best: { key: string; v: number } | null = null;
  for (const k of Object.keys(rec))
    if (rec[k] > (best?.v ?? min)) best = { key: k, v: rec[k] };
  return best;
}

// everyone gets an award before anyone gets two, then fill to cap 7 by score
function pick(awards: Award[], eligibleCount: number): Award[] {
  awards.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const covered = new Set<string>();
  const picked: Award[] = [];
  const rest: Award[] = [];
  for (const a of awards) {
    const fresh = a.members.filter((n) => !covered.has(n));
    if (fresh.length > 0 && covered.size < eligibleCount) {
      picked.push(a);
      fresh.forEach((n) => covered.add(n));
    } else {
      rest.push(a);
    }
  }
  picked.push(...rest.slice(0, Math.max(0, 7 - picked.length)));
  return picked.slice(0, 7);
}

function buildAwards(entities: Entity[], st: TripStats, fmtU: (v: number) => string): Award[] {
  const name = (key: string) => entities.find((e) => e.key === key)?.name ?? "?";
  const awards: Award[] = [];
  const totalSpend = st.totalSpend || 1;
  const nExp = st.nExp || 1;
  const debtTop = top(st.owed);
  if (debtTop && debtTop.v > 0) awards.push({ emoji: "🧾", title: "Chief IOU Officer", members: [name(debtTop.key)], detail: `${fmtU(debtTop.v)} owed`, score: 30 + debtTop.v / totalSpend });
  const paidTop = top(st.paid);
  if (paidTop) awards.push({ emoji: "💸", title: "Sugar Daddy", members: [name(paidTop.key)], detail: `${fmtU(paidTop.v)} fronted`, score: 29 + paidTop.v / totalSpend });
  const gap: Record<string, number> = {};
  for (const e of entities) gap[e.key] = (st.consumed[e.key] ?? 0) - (st.paid[e.key] ?? 0);
  const freeTop = top(gap);
  if (freeTop && freeTop.v > 0) awards.push({ emoji: "🫥", title: "Freeloader-in-Chief", members: [name(freeTop.key)], detail: `${fmtU(freeTop.v)} net`, score: 28 + freeTop.v / totalSpend });
  // one silly champion title per category
  const catChamp: Record<string, [string, string]> = {
    Food: ["🍽️", "MVP · Most Voracious Person"], Drinks: ["🍻", "Chief Hydration Officer"],
    Coffee: ["☕", "The Caffeine Addict"], Groceries: ["🛒", "The Snack Barron"],
    Transport: ["🚕", "The Backseat Driver"], Lodging: ["🏨", "The Sleep King"],
    Activities: ["🎟️", "The Adrenaline Junkie"], Tickets: ["🎫", "The Queue Jumper"],
    Shopping: ["🛍️", "The Retail Therapist"], Souvenirs: ["🧸", "The Trinket Hoarder"],
    Fees: ["💳", "The Fine Print Fan"], Nightlife: ["🌙", "The Night Owl"],
    Wellness: ["💆", "The Zen Master"], Other: ["📦", "The Miscellaneous Maniac"],
  };
  for (const [cat, [emoji, title]] of Object.entries(catChamp)) {
    const t2 = top(Object.fromEntries(Object.keys(st.catShare)
      .filter((k) => k.startsWith(`${cat}>`))
      .map((k) => [k.split(">")[1], st.catShare[k]])));
    if (t2) awards.push({ emoji, title, members: [name(t2.key)], detail: `biggest ${cat.toLowerCase()} share`, score: 15 + (t2.v / (st.catTotal[cat] || 1)) });
  }
  const payerTop = top(st.payerCount);
  if (payerTop) awards.push({ emoji: "🏧", title: "Human ATM", members: [name(payerTop.key)], detail: `paid for ${payerTop.v} expense${payerTop.v > 1 ? "s" : ""}`, score: 20 + payerTop.v / nExp });
  const partTop = top(st.partCount);
  if (partTop) awards.push({ emoji: "🤝", title: "Split King/Queen", members: [name(partTop.key)], detail: `in on ${partTop.v} splits`, score: 20 + partTop.v / nExp });
  const nosyTop = top(Object.fromEntries(entities.filter((e) => e.views > 0).map((e) => [e.key, e.views])));
  if (nosyTop) awards.push({ emoji: "🕵️", title: "The Receipt Auditor", members: [name(nosyTop.key)], detail: `checked the math ${nosyTop.v} time${nosyTop.v > 1 ? "s" : ""} — trusts no one`, score: 10 + Math.min(nosyTop.v / 5, 1) });
  const taxTop = top(st.createdCount);
  if (taxTop && taxTop.v >= 2) awards.push({ emoji: "🧮", title: "The Tax Man", members: [name(taxTop.key)], detail: `filed ${taxTop.v} expenses — receipts for everything`, score: 21 + taxTop.v / nExp });
  const accTop = top(st.typedCount);
  if (accTop && accTop.v >= 2) awards.push({ emoji: "🤓", title: "The Accountant", members: [name(accTop.key)], detail: `typed ${accTop.v} exact shares — nobody trusts equal splits`, score: 10 + Math.min(accTop.v / (nExp * 2), 1) });
  const bigTop = top(st.biggestShare);
  if (bigTop && bigTop.v > 0) awards.push({ emoji: "🍾", title: "Champagne Tastes", members: [name(bigTop.key)], detail: `biggest single share: ${fmtU(bigTop.v)}`, score: 19 + bigTop.v / totalSpend });
  const tiny = Object.fromEntries(Object.keys(st.consumed).filter((k) => st.consumed[k] > 0).map((k) => [k, st.consumed[k]]));
  const pinKey = Object.keys(tiny).length ? Object.keys(tiny).reduce((a, b) => tiny[a] < tiny[b] ? a : b) : null;
  if (pinKey) awards.push({ emoji: "🤏", title: "Penny Pincher", members: [name(pinKey)], detail: `only ${fmtU(tiny[pinKey])} of total damage`, score: 9 + (1 - tiny[pinKey] / totalSpend) });
  const ghosts = entities.filter((e) => !st.paid[e.key] && !st.consumed[e.key]);
  if (ghosts.length && (Object.keys(st.paid).length || Object.keys(st.consumed).length))
    awards.push({ emoji: "👻", title: "The Ghost", members: ghosts.map((g) => g.name), detail: "never paid, never on a receipt", score: 8 + Math.min(ghosts.length / entities.length, 1) });

  const txTop = top(st.settlePair);
  if (txTop) awards.push({ emoji: "💞", title: "Transactional Couple", members: txTop.key.split(">").map(name), detail: `${txTop.v} payments between them`, score: 12 + Math.min(txTop.v / 3, 1) });
  const duoTop = top(st.pairShare);
  if (duoTop && duoTop.v >= 2) awards.push({ emoji: "🍔", title: "Codependent Diners", members: duoTop.key.split(">").map(name), detail: `${duoTop.v} shared expenses`, score: 14 + duoTop.v / nExp });
  const trioTop = top(st.tripleShare);
  if (trioTop && trioTop.v >= 2) awards.push({ emoji: "⚔️", title: "Three Musketeers", members: trioTop.key.split(">").map(name), detail: `${trioTop.v} items together`, score: 14 + trioTop.v / nExp });

  const catTop = top(st.catTotal);
  const catSquad: Record<string, string> = {
    Food: "The Buffet Battalion", Drinks: "The Liquid Assets", Coffee: "The Bean Counters",
    Groceries: "The Cart Pushers", Transport: "The Wheel Deal", Lodging: "The Pillow Talk Posse",
    Activities: "The Thrill Seekers", Tickets: "The Turnstile Gang", Shopping: "The Retail Therapists",
    Souvenirs: "The Trinket Tribe", Fees: "The Fine Print Club", Nightlife: "The Last Call Crew",
    Wellness: "The Spa Society", Other: "The Miscellaneous Society",
  };
  if (catTop) awards.push({ emoji: "🏆", title: catSquad[catTop.key] ?? `The ${catTop.key} Squad`, members: [], detail: `most spent on ${catTop.key}`, score: 22 + st.catTotal[catTop.key] / totalSpend });
  return awards;
}

export function funBoard(rows: TripRows) {
  const { trip: t, members } = rows;
  if (members.length === 0) return { awards: [] };
  const out = new Set(members.filter((m) => m.opted_out_fun).map((m) => m.id));
  const st = collectStats(rows);
  const dec = decimals(t.settle_currency);
  const fmtU = (v: number) => `${v.toFixed(dec)} ${t.settle_currency}`;
  const entities: Entity[] = members
    .filter((m) => !out.has(m.id))
    .map((m) => ({ key: m.id, name: m.name, views: m.detail_views ?? 0 }));
  const awards = pick(buildAwards(entities, st, fmtU), entities.length);
  return { awards: awards.map(({ score: _s, ...a }) => a) };
}

export function journeyBoard(jr: JourneyRows) {
  const { journey: j, trips } = jr;
  if (trips.length === 0) return { awards: [] };
  const { persons, keyOf } = journeyPeople(jr);
  const memberById = new Map<string, Member>();
  for (const tr of trips)
    for (const m of tr.members) memberById.set(m.id, m);
  const kOf = (id: string) => {
    const m = memberById.get(id) as JourneyMember | undefined;
    return m ? keyOf(m) : id;
  };
  // a person is opted out if ANY of their member rows opted out
  const optedOut = new Set(
    [...memberById.values()].filter((m) => m.opted_out_fun).map((m) => kOf(m.id)),
  );
  const entities: Entity[] = [...persons.entries()]
    .filter(([k]) => !optedOut.has(k))
    .map(([k, p]) => ({
      key: k, name: p.name,
      views: p.memberIds.reduce((s, id) => s + (memberById.get(id)?.detail_views ?? 0), 0),
    }));
  if (entities.length === 0) return { awards: [] };
  const name = (k: string) => entities.find((e) => e.key === k)?.name ?? "?";

  const st = emptyStats();
  // count trips per person for Always Boarding / The Bank
  const tripPaid: Record<string, number> = {};
  const tripCovered: Record<string, number> = {};
  for (const tr of trips) {
    const ts = collectStats(tr);
    mergeInto(st, ts, kOf);
    for (const id of ts.paidTrip) { const k = kOf(id); tripPaid[k] = (tripPaid[k] ?? 0) + 1; }
    for (const id of ts.coveredTrip) { const k = kOf(id); tripCovered[k] = (tripCovered[k] ?? 0) + 1; }
  }
  const dec = decimals(j.settle_currency);
  const fmtU = (v: number) => `${v.toFixed(dec)} ${j.settle_currency}`;
  const nTrips = trips.length;
  const totalSpend = st.totalSpend || 1;
  const awards = buildAwards(entities, st, fmtU);

  // journey-only achievements
  const whale = top(st.consumed);
  if (whale && whale.v > 0)
    awards.push({ emoji: "💎", title: "Whale of the Journey", members: [name(whale.key)], detail: `${fmtU(whale.v)} across ${nTrips} trip${nTrips > 1 ? "s" : ""}`, score: 26 + whale.v / totalSpend });
  const curTop = top(Object.fromEntries(Object.entries(st.currencies).map(([k, s]) => [k, s.size])));
  if (curTop && curTop.v >= 2)
    awards.push({ emoji: "🪙", title: "Currency Collector", members: [name(curTop.key)], detail: `spent in ${curTop.v} currencies`, score: 18 + curTop.v / 6 });
  const boardTop = top(tripPaid);
  if (boardTop && boardTop.v >= 2)
    awards.push({ emoji: "🚂", title: "Always Boarding", members: [name(boardTop.key)], detail: `paid for things on ${boardTop.v} trips`, score: 18 + boardTop.v / nTrips });
  const bankTop = top(tripCovered);
  if (bankTop && bankTop.v >= 2)
    awards.push({ emoji: "💳", title: "The Bank", members: [name(bankTop.key)], detail: `covered others on ${bankTop.v} trips`, score: 18 + bankTop.v / nTrips });
  const partners: Record<string, Set<string>> = {};
  for (const k of Object.keys(st.pairShare)) {
    const [a, b] = k.split(">");
    (partners[a] ??= new Set()).add(b);
    (partners[b] ??= new Set()).add(a);
  }
  const glueTop = top(Object.fromEntries(Object.entries(partners).map(([k, s]) => [k, s.size])));
  if (glueTop && glueTop.v >= 2)
    awards.push({ emoji: "🤝", title: "The Glue", members: [name(glueTop.key)], detail: `split expenses with ${glueTop.v} different people`, score: 17 + glueTop.v / Math.max(entities.length - 1, 1) });
  if (st.biggestExp && st.biggestExp.sharers.length)
    awards.push({ emoji: "🧊", title: "The Iceberg", members: st.biggestExp.sharers.map(name), detail: `everyone on the biggest expense: ${fmtU(st.biggestExp.units)}`, score: 16 + st.biggestExp.units / totalSpend });

  const picked = pick(awards, entities.length);
  return { awards: picked.map(({ score: _s, ...a }) => a) };
}
