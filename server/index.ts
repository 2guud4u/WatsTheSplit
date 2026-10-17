import { db } from "./db.ts";
import { decimals, isCurrency, CURRENCIES } from "./currencies.ts";
import { crossRate, startFxLoop, latestProviderTimestamp } from "./fx.ts";
import { seedDemo, DEMO_TOKEN } from "./demo.ts";
import { createRemoteJWKSet, jwtVerify } from "jose";
const PORT = Number(process.env.PORT ?? 8081);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
// Serve under a path prefix when set (e.g. BASE_PATH=/watsthesplit on jiathe.dev).
// The tunnel forwards unprefixed-path URLs, so we strip it before routing.
const BASE_PATH = (process.env.BASE_PATH ?? "").replace(/\/$/, "");
const COOKIE = "wts_session";
const DIST = new URL("../dist", import.meta.url).pathname;

type Session = { token: string; user_sub: string | null };
type Member = {
  id: string; trip_token: string; name: string; user_sub: string | null; opted_out_fun?: number; detail_views?: number;
};
type Trip = {
  token: string; name: string; start_date: string | null; end_date: string | null;
  trip_currency: string; settle_currency: string; password_hash: string | null;
  password_text: string | null;
  created_at: string;
  password_ver: number; fun_leaderboard: number; created_by_token: string | null;
};

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
const err = (status: number, error: string, extra: object = {}) =>
  json({ error, ...extra }, { status });
const now = () => new Date().toISOString();

const qMember = db.prepare<Member, [string]>("SELECT * FROM members WHERE id = ?");
const qTrip = db.prepare<Trip, [string]>("SELECT * FROM trips WHERE token = ?");
const qSession = db.prepare<Session, [string]>(
  "SELECT token, user_sub FROM sessions WHERE token = ?",
);
const reqSessions = new WeakMap<Request, Session>();

function sessionFrom(req: Request): Session | null {
  const cached = reqSessions.get(req);
  if (cached) return cached;
  const m = /(?:^|;\s*)wts_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  if (!m) return null;
  return qSession.get(decodeURIComponent(m[1])) ?? null;
}

function ensureSession(req: Request): { session: Session; headers: HeadersInit } {
  const s = sessionFrom(req);
  if (s) return { session: s, headers: {} };
  const token = crypto.randomUUID();
  db.run("INSERT INTO sessions (token, user_sub, created_at) VALUES (?, NULL, ?)", [
    token, now(),
  ]);
  const session = { token, user_sub: null };
  reqSessions.set(req, session);
  return {
    session,
    headers: { "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` },
  };
}

const linkedMember = (s: Session, tripToken: string) =>
  s.user_sub
    ? db.query<Member, [string, string]>(
        "SELECT * FROM members WHERE trip_token = ? AND user_sub = ?",
      ).get(tripToken, s.user_sub) ?? null
    : null;

function myMember(s: Session, trip: Trip): Member | null {
  const l = linkedMember(s, trip.token);
  if (l) return l;
  const claim = db.query<{ member_id: string }, [string, string]>(
    "SELECT member_id FROM claims WHERE session_token = ? AND trip_token = ?",
  ).get(s.token, trip.token);
  return claim ? qMember.get(claim.member_id) ?? null : null;
}

// Password access: Linked members are exempt; others need consent at the
// current password version.
function hasAccess(s: Session, trip: Trip): boolean {
  if (!trip.password_hash) return true;
  if (linkedMember(s, trip.token)) return true;
  const c = db.query<{ password_ver: number }, [string, string]>(
    "SELECT password_ver FROM consents WHERE session_token = ? AND trip_token = ?",
  ).get(s.token, trip.token);
  return c?.password_ver === trip.password_ver;
}

const memberIsUsed = (tripToken: string, memberId: string): boolean => {
  const checks: [string, string[]][] = [
    ["SELECT COUNT(*) n FROM expenses WHERE trip_token = ? AND payer_member_id = ?", [tripToken, memberId]],
    [`SELECT COUNT(*) n FROM expense_participants p JOIN expenses e ON e.id = p.expense_id
      WHERE e.trip_token = ? AND p.member_id = ?`, [tripToken, memberId]],
    [`SELECT COUNT(*) n FROM item_sharers s JOIN items i ON i.id = s.item_id
      JOIN expenses e ON e.id = i.expense_id WHERE e.trip_token = ? AND s.member_id = ?`, [tripToken, memberId]],
    ["SELECT COUNT(*) n FROM settlements WHERE trip_token = ? AND (from_member = ? OR to_member = ?)", [tripToken, memberId, memberId]],
  ];
  return checks.some(([sql, args]) =>
    db.query<{ n: number }, string[]>(sql).get(...args)!.n > 0
  );
};

// ---------- domain payload builders ----------

function sharesForExpense(expenseId: string): { member_id: string; share_minor: number | null }[] {
  return db.query<{ member_id: string; share_minor: number | null }, [string]>(
    "SELECT member_id, share_minor FROM expense_participants WHERE expense_id = ?",
  ).all(expenseId);
}

type ExpenseRow = {
  id: string; trip_token: string; name: string; currency: string;
  total_minor: number; payer_member_id: string | null; category: string | null;
  rate: number | null; rate_provider: string | null; rate_timestamp: string | null;
  recorded_at: string; last_edited_by: string | null; last_edited_at: string;
  created_by_member_id?: string | null;
};

// Per-participant effective share in expense minor units.
// Hybrid: each member's share = typed share_minor + their portion of items
// (each item splits price equally among its sharers). NULL share_minor means
// "equal share of whatever is left" (the remainder): rest = total - fixed
// shares - item prices, spread evenly over participants whose share_minor is
// NULL. Rounding dust goes to the last remainder participant. Expenses with
// no NULL participants can still be unassigned/over — shown as badges.
function effectiveShares(e: ExpenseRow): { member_id: string; minor: number | null }[] {
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
  const parts = db.query<{ member_id: string; share_minor: number | null }, [string]>(
    "SELECT member_id, share_minor FROM expense_participants WHERE expense_id = ?",
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

function expensePayload(e: ExpenseRow, detail: boolean) {
  const shares = effectiveShares(e);
  const assigned = shares.reduce((a, s) => a + (s.minor ?? 0), 0);
  const unassigned = e.total_minor - assigned;
  const base: Record<string, unknown> = {
    id: e.id, name: e.name, currency: e.currency, total_minor: e.total_minor,
    payer_member_id: e.payer_member_id, category: e.category, recorded_at: e.recorded_at,
    rate: e.rate, rate_provider: e.rate_provider, rate_timestamp: e.rate_timestamp,
    last_edited_by: e.last_edited_by, last_edited_at: e.last_edited_at,
    assigned_minor: assigned, unassigned_minor: unassigned, over: unassigned < 0,
  };
  if (!detail) return base;
  base.participants = db.query<{ member_id: string; share_minor: number | null; name: string }, [string]>(
    `SELECT p.member_id, p.share_minor, m.name FROM expense_participants p
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
// Silly awards computed from trip data. Everything in settle-currency units.
function funBoard(t: Trip) {
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

function balancesForTrip(t: Trip) {
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

// ---------- SSE ----------
const listeners = new Map<string, Set<ReadableStreamDefaultController>>();
function broadcast(tripToken: string) {
  const set = listeners.get(tripToken);
  if (!set) return;
  for (const c of set) {
    try { c.enqueue(`data: {"t":${Date.now()}}\n\n`); } catch { set.delete(c); }
  }
}

// ---------- helpers ----------
function edited(e: { id: string }, memberName: string | null) {
  db.run("UPDATE expenses SET last_edited_by = ?, last_edited_at = ? WHERE id = ?", [
    memberName, now(), e.id,
  ]);
}

function lockRate(eId: string, currency: string, settle: string): void {
  const r = currency === settle ? { rate: 1, provider: "same-currency", providerTimestamp: null } : crossRate(currency, settle);
  db.run(
    "UPDATE expenses SET currency = ?, rate = ?, rate_provider = ?, rate_timestamp = ? WHERE id = ?",
    [currency, r?.rate ?? null, r?.provider ?? null, r?.providerTimestamp ?? null, eId],
  );
}

async function verifyGoogle(credential: string) {
  const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  const { payload } = await jwtVerify(credential, JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: GOOGLE_CLIENT_ID,
  });
  return payload as { sub: string; email?: string; name?: string; picture?: string };
}

type Ctx = { session: Session; trip: Trip; member: Member | null };

function openTrip(token: string, s: Session): { trip: Trip } | Response {
  const trip = qTrip.get(token);
  if (!trip) return err(404, "trip_not_found");
  if (!hasAccess(s, trip)) return err(401, "password_required", { protected: true });
  return { trip };
}

// Case-insensitive name check within a trip.
function nameTaken(tripToken: string, name: string, excludeId?: string): boolean {
  return !!db.query<{ id: string }, [string, string]>(
    "SELECT id FROM members WHERE trip_token = ? AND name = ? COLLATE NOCASE",
  ).all(tripToken, name).find((m) => m.id !== excludeId);
}
// ---------- routes ----------
type Body = Record<string, unknown>;
type Route = [RegExp, string, (req: Request, m: RegExpMatchArray, body: Body) => Promise<Response> | Response];

const routes: Route[] = [
  [/^\/api\/config$/, "GET", async () =>
    json({ googleClientId: GOOGLE_CLIENT_ID, baseUrl: BASE_URL, currencies: CURRENCIES })],

  [/^\/api\/me$/, "GET", async (req) => {
    const s = sessionFrom(req);
    if (!s) return json({ user: null });
    const user = s.user_sub
      ? db.query("SELECT google_sub, email, name, picture FROM users WHERE google_sub = ?").get(s.user_sub)
      : null;
    return json({ user });
  }],

  [/^\/api\/auth\/google$/, "POST", async (req, _m, body) => {
    if (!GOOGLE_CLIENT_ID) return err(503, "google_not_configured");
    let payload;
    try { payload = await verifyGoogle(String(body.credential ?? "")); }
    catch { return err(401, "invalid_token"); }
    db.run(
      `INSERT INTO users (google_sub, email, name, picture) VALUES (?,?,?,?)
       ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture`,
      [payload.sub, payload.email ?? "", payload.name ?? "", payload.picture ?? ""],
    );
    const { session, headers } = ensureSession(req);
    db.run("UPDATE sessions SET user_sub = ? WHERE token = ?", [payload.sub, session.token]);
    return json({ ok: true }, { headers });
  }],

  [/^\/api\/auth\/signout$/, "POST", async (req) => {
    const s = sessionFrom(req);
    if (s) db.run("UPDATE sessions SET user_sub = NULL WHERE token = ?", [s.token]);
    return json({ ok: true });
  }],

  [/^\/api\/my-trips$/, "GET", async (req) => {
    const s = sessionFrom(req);
    if (!s?.user_sub) return json({ trips: [] });
    return json({
      trips: db.query(
        `SELECT t.token, t.name, t.trip_currency, t.settle_currency FROM trips t
         JOIN members m ON m.trip_token = t.token WHERE m.user_sub = ?`,
      ).all(s.user_sub),
    });
  }],

  // ---- trips ----
  [/^\/api\/trips$/, "POST", async (req, _m, body) => {
    const { session, headers } = ensureSession(req);
    const name = String(body.name ?? "").trim();
    if (!name) return err(400, "name_required");
    const tc = String(body.trip_currency ?? "").toUpperCase();
    const sc = String(body.settle_currency ?? "").toUpperCase();
    if (!isCurrency(tc) || !isCurrency(sc)) return err(400, "bad_currency");
    const pw = String(body.password ?? "").trim();
    if (!pw) return err(400, "password_required");
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    // optional pre-added members: comma/line-separated, deduped case-insensitively
    const raw = Array.isArray(body.members) ? body.members.join(",") : String(body.members ?? "");
    const seen = new Map<string, string>();
    for (const n of raw.split(/[,\n]/).map((n) => n.trim()).filter(Boolean)) {
      if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    }
    const names = [...seen.values()];
    db.run(
      `INSERT INTO trips (token, name, start_date, end_date, trip_currency, settle_currency,
         password_hash, password_text, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [token, name, body.start_date ? String(body.start_date) : null, body.end_date ? String(body.end_date) : null,
       tc, sc, await Bun.password.hash(pw), pw, now()],
    );
    db.run("UPDATE trips SET created_by_token = ? WHERE token = ?", [session.token, token]);
    // creator's session counts as having entered the password (ver starts at 0)
    db.run("INSERT OR REPLACE INTO consents (session_token, trip_token, password_ver) VALUES (?,?,0)",
      [session.token, token]);
    for (const n of names) {
      db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
        [crypto.randomUUID(), token, n, now()]);
    }
    return json({ token, url: `${BASE_URL}/#/t/${token}` }, { headers });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    const { members, pairs, log } = balancesForTrip(t);
    return json({
      trip: {
        token: t.token, name: t.name, start_date: t.start_date, end_date: t.end_date,
        created_at: t.created_at,
        trip_currency: t.trip_currency, settle_currency: t.settle_currency,
        has_password: !!t.password_hash, password: t.password_text, fun_leaderboard: !!t.fun_leaderboard,
      },
      me: me ? { id: me.id, name: me.name, linked: !!me.user_sub, opted_out_fun: !!me.opted_out_fun } : null,
      signed_in: !!s.user_sub,
      is_creator: t.created_by_token !== null && t.created_by_token === s.token,
      members: members.map((mm) => ({
        id: mm.id, name: mm.name, linked: !!mm.user_sub,
        used: memberIsUsed(t.token, mm.id), opted_out_fun: !!mm.opted_out_fun,
        is_me: me?.id === mm.id,
      })),
      balances: pairs,
      balance_log: log,
      no_rate_count: db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) n FROM expenses WHERE trip_token = ? AND rate IS NULL",
      ).get(t.token)!.n,
      unfinished_count: db.query<ExpenseRow, [string]>(
        "SELECT * FROM expenses WHERE trip_token = ?",
      ).all(t.token).filter((e) => {
        const assigned = effectiveShares(e).reduce((a, s) => a + (s.minor ?? 0), 0);
        return e.total_minor - assigned > 0.5;
      }).length,
      expenses: db.query<ExpenseRow, [string]>(
        "SELECT * FROM expenses WHERE trip_token = ? ORDER BY recorded_at DESC",
      ).all(t.token).map((e) => expensePayload(e, false)),
      settlements: db.query<{ id: string; from_member: string; to_member: string; amount_minor: number; created_at: string; created_by: string | null }, [string]>(
        "SELECT * FROM settlements WHERE trip_token = ? ORDER BY created_at DESC",
      ).all(t.token),
      fx_timestamp: latestProviderTimestamp(),
      // current FX snapshot for the trip pair (display only; expenses keep their locked rate)
      current_rate: t.trip_currency === t.settle_currency
        ? { rate: 1, providerTimestamp: null }
        : crossRate(t.trip_currency, t.settle_currency),
      fun: t.fun_leaderboard ? funBoard(t) : null,
    });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/password$/, "POST", async (req, m, body) => {
    // ensureSession (not sessionFrom): this can be the client's very first call
    // when a ?pw= share link opens straight to a locked trip.
    const { session: s, headers } = ensureSession(req);
    const trip = qTrip.get(m[1]);
    if (!trip) return err(404, "trip_not_found");
    let ok = false;
    try { ok = await Bun.password.verify(String(body.password ?? ""), trip.password_hash ?? "$invalid$"); }
    catch { ok = false; }
    if (!ok) return err(403, "wrong_password");
    db.run("INSERT OR REPLACE INTO consents (session_token, trip_token, password_ver) VALUES (?,?,?)",
      [s.token, trip.token, trip.password_ver]);
    return json({ ok: true }, { headers });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/settings$/, "PATCH", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const t = o.trip;
    if (body.name !== undefined) db.run("UPDATE trips SET name = ? WHERE token = ?", [String(body.name), t.token]);
    if (body.start_date !== undefined) db.run("UPDATE trips SET start_date = ? WHERE token = ?", [body.start_date === null ? null : String(body.start_date), t.token]);
    if (body.end_date !== undefined) db.run("UPDATE trips SET end_date = ? WHERE token = ?", [body.end_date === null ? null : String(body.end_date), t.token]);
    if (body.trip_currency !== undefined || body.settle_currency !== undefined) {
      return err(400, "currencies_locked"); // set at creation only
    }
    if (body.fun_leaderboard !== undefined) {
      if (t.created_by_token === null || t.created_by_token !== s.token) {
        return err(403, "only_creator");
      }
      db.run("UPDATE trips SET fun_leaderboard = ? WHERE token = ?", [body.fun_leaderboard ? 1 : 0, t.token]);
    }
    if (body.password !== undefined) {
      const pw = String(body.password);
      if (pw === "") {
        return err(400, "password_required"); // trips must keep a password
      } else {
        db.run("UPDATE trips SET password_hash = ?, password_text = ?, password_ver = password_ver + 1 WHERE token = ?",
          [await Bun.password.hash(pw), pw, t.token]);
        // revoke all existing consents, then re-grant the acting session at the new version
        db.run("DELETE FROM consents WHERE trip_token = ?", [t.token]);
        const ver = db.query<{ password_ver: number }, [string]>(
          "SELECT password_ver FROM trips WHERE token = ?",
        ).get(t.token)!.password_ver;
        db.run("INSERT OR REPLACE INTO consents (session_token, trip_token, password_ver) VALUES (?,?,?)",
          [s.token, t.token, ver]);
      }
    }
    broadcast(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)$/, "DELETE", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const t = o.trip;
    if (body.name !== t.name) return err(400, "name_mismatch");
    db.run("DELETE FROM trips WHERE token = ?", [t.token]);
    broadcast(t.token);
    return json({ ok: true });
  }],

  // ---- members ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/claim$/, "POST", async (req, m, body) => {
    const { session: s, headers } = ensureSession(req);
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const memberId = String(body.member_id ?? "");
    const newName = String(body.name ?? "").trim();
    let member: Member | null = null;
    if (memberId) {
      member = qMember.get(memberId);
      if (!member || member.trip_token !== t.token) return err(404, "member_not_found");
      if (member.user_sub && member.user_sub !== s.user_sub)
        return err(403, "member_linked");
    } else if (newName) {
      if (nameTaken(t.token, newName)) return err(409, "name_taken");
      member = {
        id: crypto.randomUUID(), trip_token: t.token, name: newName,
        user_sub: s.user_sub,
      };
      db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,?,?)",
        [member.id, t.token, newName, s.user_sub, now()]);
    } else return err(400, "member_or_name_required");
    if (s.user_sub && member.user_sub && member.user_sub !== s.user_sub)
      return err(403, "member_linked");
    // signed-in user claiming/linking: enforce one linked member per trip
    if (s.user_sub) {
      const existing = linkedMember(s, t.token);
      if (existing && existing.id !== member.id) return err(409, "already_linked_other_member");
      if (!member.user_sub) db.run("UPDATE members SET user_sub = ? WHERE id = ?", [s.user_sub, member.id]);
    }
    db.run("INSERT OR REPLACE INTO claims (session_token, trip_token, member_id) VALUES (?,?,?)",
      [s.token, t.token, member.id]);
    broadcast(t.token);
    return json({ ok: true, member_id: member.id }, { headers });
  }],

  [/^\/api\/trips\/([A-Za-z0-9]+)\/members$/, "POST", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const name = String(body.name ?? "").trim();
    if (nameTaken(o.trip.token, name)) return err(409, "name_taken");
    if (!name) return err(400, "name_required");
    const id = crypto.randomUUID();
    db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
      [id, o.trip.token, name, now()]);
    broadcast(o.trip.token);
    return json({ id });
  }],

  [/^\/api\/members\/([A-Za-z0-9-]+)$/, "PATCH", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const mem = qMember.get(m[1]);
    if (!mem) return err(404, "member_not_found");
    const o = openTrip(mem.trip_token, s);
    if (o instanceof Response) return o;
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return err(400, "name_required");
      if (nameTaken(mem.trip_token, name, mem.id)) return err(409, "name_taken");
      db.run("UPDATE members SET name = ? WHERE id = ?", [name, mem.id]);
    }
    if (body.opted_out_fun !== undefined) {
      const me = myMember(s, o.trip);
      if (!me || me.id !== mem.id) return err(403, "not_your_member");
      db.run("UPDATE members SET opted_out_fun = ? WHERE id = ?", [body.opted_out_fun ? 1 : 0, mem.id]);
    }
    broadcast(mem.trip_token);
    return json({ ok: true });
  }],

  [/^\/api\/members\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const mem = qMember.get(m[1]);
    if (!mem) return err(404, "member_not_found");
    const o = openTrip(mem.trip_token, s);
    if (o instanceof Response) return o;
    if (memberIsUsed(mem.trip_token, mem.id)) return err(400, "member_in_use");
    if (mem.id === myMember(s, o.trip)?.id) return err(400, "cannot_remove_self");
    db.run("DELETE FROM claims WHERE member_id = ?", [mem.id]);
    db.run("DELETE FROM members WHERE id = ?", [mem.id]);
    broadcast(mem.trip_token);
    return json({ ok: true });
  }],

  // counts how often the acting member opens an owe-card details modal
  [/^\/api\/trips\/([A-Za-z0-9]+)\/detail-view$/, "POST", async (req, m) => {
    const s = sessionFrom(req)!;
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const me = myMember(s, o.trip);
    if (me) db.run("UPDATE members SET detail_views = detail_views + 1 WHERE id = ?", [me.id]);
    return json({ ok: true });
  }],

  // ---- expenses ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/expenses$/, "POST", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    const name = String(body.name ?? "").trim();
    if (!name) return err(400, "name_required");
    const currency = String(body.currency ?? t.trip_currency).toUpperCase();
    if (!isCurrency(currency)) return err(400, "bad_currency");
    const totalMinor = Number(body.total_minor);
    if (!Number.isFinite(totalMinor) || totalMinor < 0) return err(400, "bad_total");
    const payer = body.payer_member_id ? qMember.get(String(body.payer_member_id)) : null;
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO expenses (id, trip_token, name, currency, total_minor, payer_member_id,
        rate, rate_provider, rate_timestamp, recorded_at, last_edited_by, last_edited_at, created_at,
        created_by_member_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, t.token, name, currency, totalMinor, payer?.id ?? null,
        null, null, null, now(), me?.name ?? null, now(), now(), me?.id ?? null],
    );
    // everyone is in by default with NULL share = equal split of the total
    for (const mm of db.query<{ id: string }, [string]>(
      "SELECT id FROM members WHERE trip_token = ?",
    ).all(t.token)) {
      db.run("INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)",
        [id, mm.id]);
    }
    lockRate(id, currency, t.settle_currency);
    broadcast(t.token);
    return json({ id });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const members = db.query<Member, [string]>(
      "SELECT * FROM members WHERE trip_token = ? ORDER BY name",
    ).all(t.token);
    return json({
      expense: expensePayload(e, true),
      trip: { token: t.token, name: t.name, settle_currency: t.settle_currency },
      members: members.map((mm) => ({ id: mm.id, name: mm.name })),
      me: s.token ? (myMember(s, t)?.id ?? null) : null,
    });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "PATCH", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    if (body.name !== undefined) db.run("UPDATE expenses SET name = ? WHERE id = ?", [String(body.name), e.id]);
    if (body.total_minor !== undefined) {
      const v = Number(body.total_minor);
      if (!Number.isFinite(v) || v < 0) return err(400, "bad_total");
      db.run("UPDATE expenses SET total_minor = ? WHERE id = ?", [v, e.id]);
    }
    if (body.payer_member_id !== undefined) {
      const p = body.payer_member_id ? qMember.get(String(body.payer_member_id)) : null;
      if (body.payer_member_id && (!p || p.trip_token !== t.token)) return err(400, "bad_payer");
      db.run("UPDATE expenses SET payer_member_id = ? WHERE id = ?", [p?.id ?? null, e.id]);
    }
    if (body.category !== undefined) {
      const c = body.category === null || body.category === "" ? null : String(body.category).trim();
      db.run("UPDATE expenses SET category = ? WHERE id = ?", [c, e.id]);
    }
    if (body.currency !== undefined) {
      const c = String(body.currency).toUpperCase();
      if (!isCurrency(c)) return err(400, "bad_currency");
      if (c !== e.currency) {
        // the typed number stays the same, but minor units can differ:
        // re-scale total + typed shares + items when decimal places differ
        const factor = 10 ** (decimals(c) - decimals(e.currency));
        if (factor !== 1) {
          db.run("UPDATE expenses SET total_minor = ROUND(total_minor * ?) WHERE id = ?", [factor, e.id]);
          db.run("UPDATE expense_participants SET share_minor = ROUND(share_minor * ?) WHERE expense_id = ? AND share_minor IS NOT NULL", [factor, e.id]);
          db.run("UPDATE items SET price_minor = ROUND(price_minor * ?) WHERE expense_id = ?", [factor, e.id]);
        }
        lockRate(e.id, c, t.settle_currency); // re-lock rate for the new currency
      }
    }
    edited(e, me?.name ?? null);
    broadcast(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    db.run("DELETE FROM expenses WHERE id = ?", [e.id]);
    broadcast(o.trip.token);
    return json({ ok: true });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/participants$/, "PUT", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    const memberId = String(body.member_id ?? "");
    const on = !!body.on;
    const mem = qMember.get(memberId);
    if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found");
    if (on) {
      db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, memberId]);
    } else {
      db.run("DELETE FROM expense_participants WHERE expense_id = ? AND member_id = ?", [e.id, memberId]);
      db.run(`DELETE FROM item_sharers WHERE member_id = ? AND item_id IN
        (SELECT id FROM items WHERE expense_id = ?)`, [memberId, e.id]);
    }
    edited(e, me?.name ?? null);
    broadcast(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/shares$/, "PUT", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    const memberId = String(body.member_id ?? "");
    const value = body.share_minor === null ? null : Number(body.share_minor);
    const mem = qMember.get(memberId);
    if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found");
    db.run(
      `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,?)
       ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = excluded.share_minor`,
      [e.id, memberId, value],
    );
    edited(e, me?.name ?? null);
    broadcast(t.token);
    return json({ ok: true });
  }],

  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/split$/, "POST", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    const type = String(body.type);
    const parts = db.query<{ member_id: string; share_minor: number | null }, [string]>(
      "SELECT member_id, share_minor FROM expense_participants WHERE expense_id = ?",
    ).all(e.id);
    const eff = effectiveShares(e);
    const assignedEff = eff.reduce((a, s) => a + (s.minor ?? 0), 0);
    const rest = e.total_minor - assignedEff;
    if (type === "equal_rest") {
      // distribute the unassigned remainder equally across all participants,
      // freezing typed/item shares (so remainder participants no longer absorb it)
      const memberIds = Array.isArray(body.member_ids) ? body.member_ids.map(String) : null;
      const target = memberIds?.length
        ? eff.filter((p) => memberIds.includes(p.member_id) && (p.minor ?? 0) > 0)
        : eff.filter((p) => (p.minor ?? 0) > 0);
      const n = target.length;
      if (!n || rest <= 0) return json({ ok: true });
      const each = Math.floor(rest / n);
      let leftover = rest - each * n;
      const stmt = db.prepare(
        `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,0)
         ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = expense_participants.share_minor + ?`,
      );
      for (const p of target) {
        const add = leftover > 0 ? 1 : 0;
        stmt.run(e.id, p.member_id, (p.minor ?? 0) + each + add);
        leftover -= add;
      }
    } else if (type === "proportional") {
      // spread unassigned proportionally to current effective shares (typed + items)
      const total = eff.reduce((a, s) => a + (s.minor ?? 0), 0);
      if (rest <= 0 || total <= 0) return json({ ok: true });
      let allocated = 0;
      const withShare = eff.filter((p) => (p.minor ?? 0) > 0);
      const upd = db.prepare(
        `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,0)
         ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = expense_participants.share_minor + ?`,
      );
      for (let i = 0; i < withShare.length; i++) {
        const p = withShare[i];
        const add = i === withShare.length - 1
          ? rest - allocated
          : Math.floor((p.minor! / total) * rest);
        allocated += add;
        upd.run(e.id, p.member_id, add);
      }
    } else return err(400, "bad_split_type");
    edited(e, me?.name ?? null);
    broadcast(t.token);
    return json({ ok: true });
  }],

  // ---- items ----
  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/items$/, "POST", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    const name = String(body.name ?? "").trim() || "Item";
    const price = Number(body.price_minor ?? 0);
    const sharers: string[] = Array.isArray(body.sharers) ? body.sharers : [];
    const itemId = crypto.randomUUID();
    db.run("INSERT INTO items (id, expense_id, name, price_minor) VALUES (?,?,?,?)",
      [itemId, e.id, name, price]);
    for (const mid of sharers) {
      db.run("INSERT OR IGNORE INTO item_sharers (item_id, member_id) VALUES (?,?)", [itemId, mid]);
      db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, mid]);
    }
    edited(e, me?.name ?? null);
    broadcast(t.token);
    return json({ id: itemId });
  }],

  [/^\/api\/items\/([A-Za-z0-9-]+)$/, "PATCH", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const item = db.query<{ id: string; expense_id: string }, [string]>(
      "SELECT id, expense_id FROM items WHERE id = ?",
    ).get(m[1]);
    if (!item) return err(404, "item_not_found");
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(item.expense_id)!;
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const me = myMember(s, o.trip);
    if (body.name !== undefined) db.run("UPDATE items SET name = ? WHERE id = ?", [String(body.name), item.id]);
    if (body.price_minor !== undefined) db.run("UPDATE items SET price_minor = ? WHERE id = ?", [Number(body.price_minor), item.id]);
    if (Array.isArray(body.sharers)) {
      db.run("DELETE FROM item_sharers WHERE item_id = ?", [item.id]);
      for (const mid of body.sharers) {
        db.run("INSERT OR IGNORE INTO item_sharers (item_id, member_id) VALUES (?,?)", [item.id, mid]);
        db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, mid]);
      }
    }
    edited(e, me?.name ?? null);
    broadcast(o.trip.token);
    return json({ ok: true });
  }],

  [/^\/api\/items\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const item = db.query<{ id: string; expense_id: string }, [string]>(
      "SELECT id, expense_id FROM items WHERE id = ?",
    ).get(m[1]);
    if (!item) return err(404, "item_not_found");
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(item.expense_id)!;
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    db.run("DELETE FROM items WHERE id = ?", [item.id]);
    broadcast(o.trip.token);
    return json({ ok: true });
  }],

  // ---- photos ----
  [/^\/api\/expenses\/([A-Za-z0-9-]+)\/photos$/, "POST", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(m[1]);
    if (!e) return err(404, "expense_not_found");
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const me = myMember(s, o.trip);
    const mime = req.headers.get("content-type") ?? "application/octet-stream";
    if (!mime.startsWith("image/")) return err(400, "not_image");
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength === 0) return err(400, "empty");
    if (buf.byteLength > 10 * 1024 * 1024) return err(413, "too_large");
    const id = crypto.randomUUID();
    db.run("INSERT INTO expense_photos (id, expense_id, mime, data, created_at) VALUES (?,?,?,?,?)",
      [id, e.id, mime, buf, now()]);
    edited(e, me?.name ?? null);
    broadcast(o.trip.token);
    return json({ id });
  }],

  [/^\/api\/photos\/([A-Za-z0-9-]+)$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const p = db.query<{ mime: string; data: Uint8Array; expense_id: string }, [string]>(
      "SELECT mime, data, expense_id FROM expense_photos WHERE id = ?",
    ).get(m[1]);
    if (!p) return err(404, "photo_not_found");
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(p.expense_id)!;
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    return new Response(Buffer.from(p.data), { headers: { "content-type": p.mime, "cache-control": "private, max-age=3600" } });
  }],

  [/^\/api\/photos\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const p = db.query<{ id: string; expense_id: string }, [string]>(
      "SELECT id, expense_id FROM expense_photos WHERE id = ?",
    ).get(m[1]);
    if (!p) return err(404, "photo_not_found");
    const e = db.query<ExpenseRow, [string]>("SELECT * FROM expenses WHERE id = ?").get(p.expense_id)!;
    const o = openTrip(e.trip_token, s);
    if (o instanceof Response) return o;
    const me = myMember(s, o.trip);
    db.run("DELETE FROM expense_photos WHERE id = ?", [p.id]);
    edited(e, me?.name ?? null);
    broadcast(o.trip.token);
    return json({ ok: true });
  }],

  // ---- settlements ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/settlements$/, "POST", async (req, m, body) => {
    const s = sessionFrom(req)!;
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const t = o.trip;
    const me = myMember(s, t);
    const from = qMember.get(String(body.from_member ?? ""));
    const to = qMember.get(String(body.to_member ?? ""));
    if (!from || !to || from.trip_token !== t.token || to.trip_token !== t.token || from.id === to.id)
      return err(400, "bad_members");
    const amount = Number(body.amount_minor);
    if (!Number.isFinite(amount) || amount <= 0) return err(400, "bad_amount");
    const id = crypto.randomUUID();
    db.run("INSERT INTO settlements (id, trip_token, from_member, to_member, amount_minor, created_at, created_by) VALUES (?,?,?,?,?,?,?)",
      [id, t.token, from.id, to.id, amount, now(), me?.name ?? null]);
    broadcast(t.token);
    return json({ id });
  }],

  [/^\/api\/settlements\/([A-Za-z0-9-]+)$/, "DELETE", async (req, m) => {
    const s = sessionFrom(req)!;
    const st = db.query<{ id: string; trip_token: string }, [string]>(
      "SELECT id, trip_token FROM settlements WHERE id = ?",
    ).get(m[1]);
    if (!st) return err(404, "settlement_not_found");
    const o = openTrip(st.trip_token, s);
    if (o instanceof Response) return o;
    db.run("DELETE FROM settlements WHERE id = ?", [st.id]);
    broadcast(st.trip_token);
    return json({ ok: true });
  }],

  // ---- SSE ----
  [/^\/api\/trips\/([A-Za-z0-9]+)\/events$/, "GET", async (req, m) => {
    const s = sessionFrom(req) ?? { token: "", user_sub: null };
    const o = openTrip(m[1], s);
    if (o instanceof Response) return o;
    const token = o.trip.token;
    let ctrl!: ReadableStreamDefaultController;
    const stream = new ReadableStream({
      start(c) {
        ctrl = c;
        c.enqueue(": connected\n\n");
        if (!listeners.has(token)) listeners.set(token, new Set());
        listeners.get(token)!.add(c);
      },
      cancel() {
        listeners.get(token)?.delete(ctrl);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }],
];

// ---------- server ----------
async function handle(req: Request): Promise<Response> {
  if (req.method !== "GET" && !req.headers.get("x-wts")) {
    return err(403, "missing_header"); // cheap CSRF guard for cookie auth
  }

  let body: Body = {};
  if (req.method !== "GET" && req.headers.get("content-type")?.includes("json")) {
    try { body = await req.json(); } catch { return err(400, "bad_json"); }
  }

  const url = new URL(req.url);
  let path = url.pathname;
  if (BASE_PATH) {
    if (path === BASE_PATH) path = "/";
    else if (path.startsWith(BASE_PATH + "/")) path = path.slice(BASE_PATH.length);
    else return err(404, "not_found");
  }
  const isApi = path.startsWith("/api/");
  const { headers: sessionHeaders } = isApi ? ensureSession(req) : { headers: {} };

  for (const [re, method, fn] of routes) {
    const m = re.exec(path);
    if (m && req.method === method) {
      const res = await fn(req, m, body);
      const sc = (sessionHeaders as Record<string, string>)["set-cookie"];
      if (sc && !res.headers.has("set-cookie")) res.headers.set("set-cookie", sc);
      return res;
    }
  }
  if (isApi) return err(404, "not_found");

  // static
  const file = path === "/" ? "/index.html" : path;
  const f = Bun.file(DIST + file);
  if (await f.exists()) return new Response(f);
  return new Response(Bun.file(DIST + "/index.html")); // SPA fallback
}

startFxLoop();

Bun.serve({ port: PORT, fetch: handle });
try { if (seedDemo()) console.log(`demo trip: http://localhost:${PORT}/#/t/${DEMO_TOKEN}`); }
catch (e) { console.error("demo seed failed:", e); }
console.log(`WatsTheSplit on http://localhost:${PORT}`);
