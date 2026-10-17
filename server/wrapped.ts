import { db } from "./db.ts";
import { decimals } from "./currencies.ts";
import type { Trip, Member, ExpenseRow } from "./types.ts";
import { effectiveShares, sharesForExpense } from "./ledger.ts";

// Trip Wrapped: silly awards computed from trip data. Everything in
// settle-currency units. Pure read: rows in -> awards out, no routing.

export function funBoard(t: Trip) {
  const members = db.query<Member, [string]>(
    "SELECT * FROM members WHERE trip_token = ? ORDER BY name",
  ).all(t.token);
  if (members.length === 0) return { awards: [] };
  const out = new Set(members.filter((m) => m.opted_out_fun).map((m) => m.id));
  const dec = decimals(t.settle_currency);
  const paid: Record<string, number> = {};      // settle units paid
  const consumed: Record<string, number> = {};  // settle units owed
  const catShare: Record<string, number> = {};  // "cat>member" -> share minor (expense currency)
  const catTotal: Record<string, number> = {};  // category -> total share minor
  const payerCount: Record<string, number> = {};
  const partCount: Record<string, number> = {};
  const pairShare: Record<string, number> = {};   // "a>b" -> co-share count
  const tripleShare: Record<string, number> = {}; // "a>b>c" -> co-share count
  const owed: Record<string, number> = {};      // net per member for "most in debt"
  const settlePair: Record<string, number> = {};
  const createdCount: Record<string, number> = {}; // expenses created per member
  const typedCount: Record<string, number> = {};   // exact shares entered per member
  const biggestShare: Record<string, number> = {}; // largest single share (settle units)

  for (const e of db.query<ExpenseRow, [string]>(
    "SELECT * FROM expenses WHERE trip_token = ?",
  ).all(t.token)) {
    const rate = e.currency === t.settle_currency ? 1 : e.rate;
    if (e.created_by_member_id && !out.has(e.created_by_member_id))
      createdCount[e.created_by_member_id] = (createdCount[e.created_by_member_id] ?? 0) + 1;
    if (rate === null) continue;
    if (e.payer_member_id && !out.has(e.payer_member_id)) {
      paid[e.payer_member_id] = (paid[e.payer_member_id] ?? 0) + (e.total_minor / 10 ** decimals(e.currency)) * rate;
      payerCount[e.payer_member_id] = (payerCount[e.payer_member_id] ?? 0) + 1;
    }
    const sharers = effectiveShares(e).filter((s) => (s.minor ?? 0) > 0);
    for (const s of sharers) {
      if (out.has(s.member_id)) continue;
      const units = (s.minor! / 10 ** decimals(e.currency)) * rate;
      consumed[s.member_id] = (consumed[s.member_id] ?? 0) + units;
      partCount[s.member_id] = (partCount[s.member_id] ?? 0) + 1;
      biggestShare[s.member_id] = Math.max(biggestShare[s.member_id] ?? 0, units);
      if (s.member_id !== e.payer_member_id) {
        owed[s.member_id] = (owed[s.member_id] ?? 0) + units;
      }
      if (e.category) {
        const ck = `${e.category}>${s.member_id}`;
        catShare[ck] = (catShare[ck] ?? 0) + units;
        catTotal[e.category] = (catTotal[e.category] ?? 0) + units;
      }
    }
    for (const p of sharesForExpense(e.id))
      if (p.share_minor !== null && !out.has(p.member_id))
        typedCount[p.member_id] = (typedCount[p.member_id] ?? 0) + 1;
    const ids = sharers.map((s) => s.member_id).filter((id) => !out.has(id)).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = `${ids[i]}>${ids[j]}`;
      pairShare[k] = (pairShare[k] ?? 0) + 1;
      for (let l = j + 1; l < ids.length; l++) {
        const tk = `${ids[i]}>${ids[j]}>${ids[l]}`;
        tripleShare[tk] = (tripleShare[tk] ?? 0) + 1;
      }
    }
  }
  for (const s of db.query<{ from_member: string; to_member: string; amount_minor: number }, [string]>(
    "SELECT from_member, to_member, amount_minor FROM settlements WHERE trip_token = ?",
  ).all(t.token)) {
    if (out.has(s.from_member) || out.has(s.to_member)) continue;
    const key = [s.from_member, s.to_member].sort().join(">");
    settlePair[key] = (settlePair[key] ?? 0) + 1;
    owed[s.from_member] = (owed[s.from_member] ?? 0) - s.amount_minor / 10 ** dec;
  }

  const top = (rec: Record<string, number>, min = 0): { key: string; v: number } | null => {
    let best: { key: string; v: number } | null = null;
    for (const k of Object.keys(rec)) {
      if (rec[k] > (best?.v ?? min)) best = { key: k, v: rec[k] };
    }
    return best;
  };
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? "?";
  const fmtU = (v: number) => `${v.toFixed(decimals(t.settle_currency))} ${t.settle_currency}`;
  const awards: Award[] = [];

  type Award = { emoji: string; title: string; members: string[]; detail: string; score?: number };
  const totalSpend = Object.values(consumed).reduce((a, b) => a + b, 0) || 1;
  const nExp = Object.values(payerCount).reduce((a, b) => a + b, 0) || 1;
  const debtTop = top(owed);
  if (debtTop && debtTop.v > 0) awards.push({ emoji: "🧾", title: "Chief IOU Officer", members: [name(debtTop.key)], detail: `${fmtU(debtTop.v)} owed`, score: 30 + debtTop.v / totalSpend });
  const paidTop = top(paid);
  if (paidTop) awards.push({ emoji: "💸", title: "Sugar Daddy", members: [name(paidTop.key)], detail: `${fmtU(paidTop.v)} fronted`, score: 29 + paidTop.v / totalSpend });
  const gap: Record<string, number> = {};
  for (const m of members) gap[m.id] = (consumed[m.id] ?? 0) - (paid[m.id] ?? 0);
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
    const t2 = top(Object.fromEntries(Object.keys(catShare)
      .filter((k) => k.startsWith(`${cat}>`))
      .map((k) => [k.split(">")[1], catShare[k]])));
    if (t2) awards.push({ emoji, title, members: [name(t2.key)], detail: `biggest ${cat.toLowerCase()} share`, score: 15 + (t2.v / (catTotal[cat] || 1)) });
  }
  const payerTop = top(payerCount);
  if (payerTop) awards.push({ emoji: "🏧", title: "Human ATM", members: [name(payerTop.key)], detail: `paid for ${payerTop.v} expense${payerTop.v > 1 ? "s" : ""}`, score: 20 + payerTop.v / nExp });
  const partTop = top(partCount);
  if (partTop) awards.push({ emoji: "🤝", title: "Split King/Queen", members: [name(partTop.key)], detail: `in on ${partTop.v} splits`, score: 20 + partTop.v / nExp });
  const nosyTop = top(Object.fromEntries(
    members.filter((m) => !out.has(m.id) && (m.detail_views ?? 0) > 0)
      .map((m) => [m.id, m.detail_views ?? 0])));
  if (nosyTop) awards.push({ emoji: "🕵️", title: "The Receipt Auditor", members: [name(nosyTop.key)], detail: `checked the math ${nosyTop.v} time${nosyTop.v > 1 ? "s" : ""} — trusts no one`, score: 10 + Math.min(nosyTop.v / 5, 1) });
  const taxTop = top(createdCount);
  if (taxTop && taxTop.v >= 2) awards.push({ emoji: "🧮", title: "The Tax Man", members: [name(taxTop.key)], detail: `filed ${taxTop.v} expenses — receipts for everything`, score: 21 + taxTop.v / nExp });
  const accTop = top(typedCount);
  if (accTop && accTop.v >= 2) awards.push({ emoji: "🤓", title: "The Accountant", members: [name(accTop.key)], detail: `typed ${accTop.v} exact shares — nobody trusts equal splits`, score: 10 + Math.min(accTop.v / (nExp * 2), 1) });
  const bigTop = top(biggestShare);
  if (bigTop && bigTop.v > 0) awards.push({ emoji: "🍾", title: "Champagne Tastes", members: [name(bigTop.key)], detail: `biggest single share: ${fmtU(bigTop.v)}`, score: 19 + bigTop.v / totalSpend });
  const tiny = Object.fromEntries(Object.keys(consumed).filter((k) => consumed[k] > 0).map((k) => [k, consumed[k]]));
  const pinKey = Object.keys(tiny).length ? Object.keys(tiny).reduce((a, b) => tiny[a] < tiny[b] ? a : b) : null;
  if (pinKey) awards.push({ emoji: "🤏", title: "Penny Pincher", members: [name(pinKey)], detail: `only ${fmtU(tiny[pinKey])} of total damage`, score: 9 + (1 - tiny[pinKey] / totalSpend) });
  const ghosts = members.filter((m) => !out.has(m.id) && !paid[m.id] && !consumed[m.id]);
  if (ghosts.length && (Object.keys(paid).length || Object.keys(consumed).length))
    awards.push({ emoji: "👻", title: "The Ghost", members: ghosts.map((m) => m.name), detail: "never paid, never on a receipt", score: 8 + Math.min(ghosts.length / members.length, 1) });

  const txTop = top(settlePair);
  if (txTop) awards.push({ emoji: "💞", title: "Transactional Couple", members: txTop.key.split(">").map(name), detail: `${txTop.v} payments between them`, score: 12 + Math.min(txTop.v / 3, 1) });
  const duoTop = top(pairShare);
  if (duoTop && duoTop.v >= 2) awards.push({ emoji: "🍔", title: "Codependent Diners", members: duoTop.key.split(">").map(name), detail: `${duoTop.v} shared expenses`, score: 14 + duoTop.v / nExp });
  const trioTop = top(tripleShare);
  if (trioTop && trioTop.v >= 2) awards.push({ emoji: "⚔️", title: "Three Musketeers", members: trioTop.key.split(">").map(name), detail: `${trioTop.v} items together`, score: 14 + trioTop.v / nExp });

  const catTop = top(catTotal);
  const catSquad: Record<string, string> = {
    Food: "The Buffet Battalion", Drinks: "The Liquid Assets", Coffee: "The Bean Counters",
    Groceries: "The Cart Pushers", Transport: "The Wheel Deal", Lodging: "The Pillow Talk Posse",
    Activities: "The Thrill Seekers", Tickets: "The Turnstile Gang", Shopping: "The Retail Therapists",
    Souvenirs: "The Trinket Tribe", Fees: "The Fine Print Club", Nightlife: "The Last Call Crew",
    Wellness: "The Spa Society", Other: "The Miscellaneous Society",
  };
  if (catTop) awards.push({ emoji: "🏆", title: catSquad[catTop.key] ?? `The ${catTop.key} Squad`, members: [], detail: `most spent on ${catTop.key}`, score: 22 + catTotal[catTop.key] / totalSpend });
  awards.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  // everyone gets an award before anyone gets two: first pass covers new members
  const eligible = members.filter((m) => !out.has(m.id)).length;
  const covered = new Set<string>();
  const picked: Award[] = [];
  const rest: Award[] = [];
  for (const a of awards) {
    const fresh = a.members.filter((n) => !covered.has(n));
    if (fresh.length > 0 && covered.size < eligible) {
      picked.push(a);
      fresh.forEach((n) => covered.add(n));
    } else {
      rest.push(a);
    }
  }
  picked.push(...rest.slice(0, Math.max(0, 7 - picked.length)));
  return { awards: picked.slice(0, 7).map(({ score: _s, ...a }) => a) };
}
