import { decimals } from "./currencies.ts"
import { type JourneyMember, type JourneyRows, journeyPeople, type TripRows } from "./ledger.ts"
import { add, collectStats, type Entity, emptyStats, mergeInto, review, type TripStats, top } from "./stats.ts"
import type { Member } from "./types.ts"

// The Wrapped award menu: every award is built over collected TripStats,
// keyed by member ids (Trip Wrapped) or merged person keys (Journey Wrapped).
// Pure read: stats in -> awards out.

export type Award = { emoji: string; title: string; members: string[]; detail: string; score?: number }

// Board composition: reserve the best duo and best group award up front so a
// data-rich trip can't be all solo majors. Then everyone gets an award before
// anyone gets two; fill to cap 7 by score.
export function pick(awards: Award[], eligibleCount: number): Award[] {
  const picked: Award[] = []
  const rest: Award[] = []
  const reserved = new Set<Award>()
  const sectionOf = (a: Award) => (a.members.length === 2 ? "duo" : a.members.length !== 1 ? "group" : "solo")
  for (const sec of ["duo", "group"] as const) {
    const best = awards.find((a) => sectionOf(a) === sec && !reserved.has(a))
    if (best) {
      reserved.add(best)
      picked.push(best)
    }
  }
  const covered = new Set<string>(picked.flatMap((a) => a.members))
  for (const a of awards) {
    if (reserved.has(a)) continue
    const fresh = a.members.filter((n) => !covered.has(n))
    if (fresh.length > 0 && covered.size < eligibleCount) {
      if (picked.length < 7) picked.push(a)
      for (const n of fresh) covered.add(n)
    } else {
      rest.push(a)
    }
  }
  picked.push(...rest.slice(0, Math.max(0, 7 - picked.length)))
  return picked.slice(0, 7)
}

export function buildAwards(entities: Entity[], st: TripStats, fmtU: (v: number) => string): Award[] {
  const name = (key: string) => entities.find((e) => e.key === key)?.name ?? "?"
  const awards: Award[] = []
  const totalSpend = st.totalSpend || 1
  const nExp = st.nExp || 1
  const debtTop = top(st.owed)
  if (debtTop && debtTop.v > 0)
    awards.push({
      emoji: "🧾",
      title: "Chief IOU Officer",
      members: [name(debtTop.key)],
      detail: `${fmtU(debtTop.v)} owed`,
      score: 30 + debtTop.v / totalSpend,
    })
  const paidTop = top(st.paid)
  if (paidTop)
    awards.push({
      emoji: "💸",
      title: "Sugar Daddy",
      members: [name(paidTop.key)],
      detail: `${fmtU(paidTop.v)} fronted`,
      score: 29 + paidTop.v / totalSpend,
    })
  const gap: Record<string, number> = {}
  for (const e of entities) gap[e.key] = (st.consumed[e.key] ?? 0) - (st.paid[e.key] ?? 0)
  const freeTop = top(gap)
  if (freeTop && freeTop.v > 0)
    awards.push({
      emoji: "🫥",
      title: "Freeloader-in-Chief",
      members: [name(freeTop.key)],
      detail: `${fmtU(freeTop.v)} net`,
      score: 28 + freeTop.v / totalSpend,
    })
  // one silly champion title per category
  const catChamp: Record<string, [string, string]> = {
    Food: ["🍽️", "MVP · Most Voracious Person"],
    Drinks: ["🍻", "Chief Hydration Officer"],
    Coffee: ["☕", "The Caffeine Addict"],
    Groceries: ["🛒", "The Snack Barron"],
    Transport: ["🚕", "The Backseat Driver"],
    Lodging: ["🏨", "The Sleep King"],
    Activities: ["🎟️", "The Adrenaline Junkie"],
    Tickets: ["🎫", "The Queue Jumper"],
    Shopping: ["🛍️", "The Retail Therapist"],
    Souvenirs: ["🧸", "The Trinket Hoarder"],
    Fees: ["💳", "The Fine Print Fan"],
    Nightlife: ["🌙", "The Night Owl"],
    Wellness: ["💆", "The Zen Master"],
    Other: ["📦", "The Miscellaneous Maniac"],
  }
  for (const [cat, [emoji, title]] of Object.entries(catChamp)) {
    const t2 = top(
      Object.fromEntries(
        Object.keys(st.catShare)
          .filter((k) => k.startsWith(`${cat}>`))
          .map((k) => [k.split(">")[1], st.catShare[k]])
      )
    )
    if (t2)
      awards.push({
        emoji,
        title,
        members: [name(t2.key)],
        detail: `biggest ${cat.toLowerCase()} share`,
        score: 15 + t2.v / (st.catTotal[cat] || 1),
      })
  }
  const payerTop = top(st.payerCount)
  if (payerTop)
    awards.push({
      emoji: "🏧",
      title: "Human ATM",
      members: [name(payerTop.key)],
      detail: `paid for ${payerTop.v} expense${payerTop.v > 1 ? "s" : ""}`,
      score: 20 + payerTop.v / nExp,
    })
  const partTop = top(st.partCount)
  if (partTop)
    awards.push({
      emoji: "🤝",
      title: "Split King/Queen",
      members: [name(partTop.key)],
      detail: `in on ${partTop.v} splits`,
      score: 20 + partTop.v / nExp,
    })
  const nosyTop = top(Object.fromEntries(entities.filter((e) => e.views > 0).map((e) => [e.key, e.views])))
  if (nosyTop)
    awards.push({
      emoji: "🕵️",
      title: "The Receipt Auditor",
      members: [name(nosyTop.key)],
      detail: `checked the math ${nosyTop.v} time${nosyTop.v > 1 ? "s" : ""} — trusts no one`,
      score: 10 + Math.min(nosyTop.v / 5, 1),
    })
  const taxTop = top(st.createdCount)
  if (taxTop && taxTop.v >= 2)
    awards.push({
      emoji: "🧮",
      title: "The Tax Man",
      members: [name(taxTop.key)],
      detail: `filed ${taxTop.v} expenses — receipts for everything`,
      score: 21 + taxTop.v / nExp,
    })
  const accTop = top(st.typedCount)
  if (accTop && accTop.v >= 2)
    awards.push({
      emoji: "🤓",
      title: "The Accountant",
      members: [name(accTop.key)],
      detail: `typed ${accTop.v} exact shares — nobody trusts equal splits`,
      score: 10 + Math.min(accTop.v / (nExp * 2), 1),
    })
  const bigTop = top(st.biggestShare)
  if (bigTop && bigTop.v > 0)
    awards.push({
      emoji: "🍾",
      title: "Champagne Tastes",
      members: [name(bigTop.key)],
      detail: `biggest single share: ${fmtU(bigTop.v)}`,
      score: 19 + bigTop.v / totalSpend,
    })
  const tiny = Object.fromEntries(
    Object.keys(st.consumed)
      .filter((k) => (st.consumed[k] ?? 0) > 0)
      .map((k) => [k, st.consumed[k]])
  )
  const pinKey = Object.keys(tiny).length
    ? Object.keys(tiny).reduce((a, b) => ((tiny[a] ?? 0) < (tiny[b] ?? 0) ? a : b))
    : null
  if (pinKey)
    awards.push({
      emoji: "🤏",
      title: "Penny Pincher",
      members: [name(pinKey)],
      detail: `only ${fmtU(tiny[pinKey] ?? 0)} of total damage`,
      score: 9 + (1 - (tiny[pinKey] ?? 0) / totalSpend),
    })
  const ghosts = entities.filter((e) => !st.paid[e.key] && !st.consumed[e.key])
  if (ghosts.length && (Object.keys(st.paid).length || Object.keys(st.consumed).length))
    awards.push({
      emoji: "👻",
      title: "The Ghost",
      members: ghosts.map((g) => g.name),
      detail: "never paid, never on a receipt",
      score: 8 + Math.min(ghosts.length / entities.length, 1),
    })

  const txTop = top(st.settlePair)
  if (txTop)
    awards.push({
      emoji: "💞",
      title: "Transactional Couple",
      members: txTop.key.split(">").map(name),
      detail: `${txTop.v} payments between them`,
      score: 12 + Math.min(txTop.v / 3, 1),
    })
  const duoTop = top(st.pairShare)
  if (duoTop && duoTop.v >= 2)
    awards.push({
      emoji: "🍔",
      title: "Codependent Diners",
      members: duoTop.key.split(">").map(name),
      detail: `${duoTop.v} shared expenses`,
      score: 14 + duoTop.v / nExp,
    })
  const trioTop = top(st.tripleShare)
  if (trioTop && trioTop.v >= 2)
    awards.push({
      emoji: "⚔️",
      title: "Three Musketeers",
      members: trioTop.key.split(">").map(name),
      detail: `${trioTop.v} items together`,
      score: 14 + trioTop.v / nExp,
    })

  // ---- bigger menu: duo, group, and solo achievements ----
  const nEnt = entities.length
  const membersOf = (k: string) => k.split(">").map(name)
  // "cat>a>b[>c[>d]]" entries -> aggregate per combo for the given categories + combo size
  const comboTop = (cats: string[], size: number): { key: string; v: number } | null => {
    const rec: Record<string, number> = {}
    for (const [k, v] of Object.entries(st.catCombo)) {
      const [cat, ...ids] = k.split(">")
      if (cats.includes(cat ?? "") && ids.length === size) add(rec, ids.join(">"), v)
    }
    return top(rec)
  }
  const comboAnyTop = (size: number): { key: string; v: number } | null => {
    const rec: Record<string, number> = {}
    for (const [k, v] of Object.entries(st.catCombo)) {
      const ids = k.split(">").slice(1)
      if (ids.length === size) add(rec, ids.join(">"), v)
    }
    return top(rec)
  }
  const catAwards: [number, string[], string, string][] = [
    // [combo size, categories, emoji, title]
    [2, ["Lodging"], "🏨", "Roommates"],
    [2, ["Drinks"], "🍻", "Drinking Buddies"],
    [2, ["Food"], "🍽️", "Table for Two"],
    [2, ["Transport"], "🚕", "Jet Lag Gang"],
    [2, ["Drinks", "Nightlife"], "🌃", "Duo of Darkness"],
    [2, ["Activities", "Tickets"], "🎢", "Adventure Buddies"],
    [3, ["Drinks", "Nightlife"], "🌙", "Trio de Noche"],
    [3, ["Lodging"], "🏨", "The Threesome Suite"],
    [3, ["Food"], "🍽️", "Three's a Crowd"],
    [4, ["Transport"], "🚕", "The Van"],
    [4, ["Food"], "🍽️", "Dinner for Four"],
    [4, ["Activities", "Tickets"], "🎢", "The Foursome"],
  ]
  for (const [size, cats, emoji, title] of catAwards) {
    if (size >= 3 && nEnt <= size) continue // a trio/quad that is everyone is The Whole Squad
    const c = comboTop(cats, size)
    if (c)
      awards.push({
        emoji,
        title,
        members: membersOf(c.key),
        detail: `${fmtU(c.v)} of shared ${cats.map((x) => x.toLowerCase()).join("+")}`,
        score: 15 + c.v / totalSpend,
      })
  }
  // directional cover: who always fronts for whom
  const piggyTop = top(st.coverPair, 1)
  if (piggyTop && nEnt >= 2) {
    const [payer, sharer] = piggyTop.key.split(">")
    awards.push({
      emoji: "🫰",
      title: "Cover Piggybacker",
      members: [name(sharer ?? ""), name(payer ?? "")],
      detail: `${name(payer ?? "")} covered them ${piggyTop.v} times`,
      score: 15 + Math.min(piggyTop.v / 5, 1),
    })
  }
  // tag team: pair with the most alternating cover (A fronted for B and B for A)
  const coverByPair: Record<string, number> = {}
  for (const [k, v] of Object.entries(st.coverPair)) {
    const [a, b] = k.split(">")
    add(coverByPair, [a, b].sort().join(">"), 0) // ensure key exists
  }
  const mutual: Record<string, number> = {}
  for (const k of Object.keys(coverByPair)) {
    const [a, b] = k.split(">")
    mutual[k] = Math.min(st.coverPair[`${a}>${b}`] ?? 0, st.coverPair[`${b}>${a}`] ?? 0)
  }
  const tagTop = top(mutual, 0)
  if (tagTop)
    awards.push({
      emoji: "🤝",
      title: "Tag Team",
      members: membersOf(tagTop.key),
      detail: `covered each other ${tagTop.v} times each way`,
      score: 15 + Math.min(tagTop.v / 4, 1),
    })
  const duoOnlyTop = top(st.duoOnly, 1)
  if (duoOnlyTop && nEnt >= 3)
    awards.push({
      emoji: "👯",
      title: "Two-Person Crew",
      members: membersOf(duoOnlyTop.key),
      detail: `${duoOnlyTop.v} expenses just the two of them`,
      score: 14 + Math.min(duoOnlyTop.v / nExp, 1),
    })
  const moneyTop = top(st.settleSum)
  if (moneyTop)
    awards.push({
      emoji: "💑",
      title: "Money Couple",
      members: membersOf(moneyTop.key),
      detail: `${fmtU(moneyTop.v)} settled between them`,
      score: 13 + moneyTop.v / totalSpend,
    })
  for (const [bucket, emoji, title, label] of [
    ["am", "🌅", "Early Birds", "before 9am"],
    ["pm", "🌙", "Last Call Duo", "after 9pm"],
  ] as const) {
    const rec = Object.fromEntries(
      Object.entries(st.hourPair)
        .filter(([k]) => k.startsWith(`${bucket}>`))
        .map(([k, v]) => [k.slice(3), v])
    )
    const t2 = top(rec, 1)
    if (t2)
      awards.push({
        emoji,
        title,
        members: membersOf(t2.key),
        detail: `${t2.v} shared expenses ${label}`,
        score: 13 + Math.min(t2.v / 4, 1),
      })
  }
  // group-wide achievements (score capped so they don't always headline)
  if (st.allIn > 0) {
    const everyone = entities.map((e) => e.name)
    awards.push({
      emoji: "🧑‍🤝‍🧑",
      title: "The Whole Squad",
      members: everyone,
      detail: `${st.allIn} expense${st.allIn > 1 ? "s" : ""} everyone shared`,
      score: 16,
    })
  }
  if (st.dinnerExp && st.dinnerExp.sharers.length >= 4)
    awards.push({
      emoji: "🍽️",
      title: "Family Dinner",
      members: st.dinnerExp.sharers.map(name),
      detail: `${st.dinnerExp.name} · ${fmtU(st.dinnerExp.units)}`,
      score: 14 + st.dinnerExp.units / totalSpend,
    })
  if (st.crowdExp && st.crowdExp.sharers.length >= 4)
    awards.push({
      emoji: "🤹",
      title: "The Circus",
      members: st.crowdExp.sharers.map(name),
      detail: `${st.crowdExp.sharers.length} people on "${st.crowdExp.name}"`,
      score: 13 + st.crowdExp.sharers.length / nEnt,
    })
  const deg: Record<string, Set<string>> = {}
  for (const k of Object.keys(st.pairShare)) {
    const [a, b] = k.split(">")
    const degA = deg[a ?? ""] ?? new Set()
    degA.add(b ?? "")
    deg[a ?? ""] = degA
    const degB = deg[b ?? ""] ?? new Set()
    degB.add(a ?? "")
    deg[b ?? ""] = degB
  }
  const pack = entities.filter((e) => (deg[e.key]?.size ?? 0) >= Math.min(3, nEnt - 1))
  if (pack.length === nEnt && nEnt >= 4)
    awards.push({
      emoji: "🎉",
      title: "The Pack",
      members: pack.map((e) => e.name),
      detail: "everyone split expenses with 3+ different people",
      score: 15.5,
    })
  const settled = entities.filter((e) => (st.owed[e.key] ?? 0) <= 0.005 * 10 ** 2)
  if (settled.length === nEnt && nEnt >= 2 && Object.keys(st.settlePair).length > 0)
    awards.push({
      emoji: "🧹",
      title: "Clean Sweep",
      members: settled.map((e) => e.name),
      detail: "every balance squared away",
      score: 15.8,
    })
  // solo additions
  const soloTop = top(Object.fromEntries(entities.map((e) => [e.key, (st.consumed[e.key] ?? 0) / totalSpend])), 0.3)
  if (soloTop && soloTop.v > 0.3)
    awards.push({
      emoji: "💪",
      title: "Solo Mission",
      members: [name(soloTop.key)],
      detail: `${Math.round(soloTop.v * 100)}% of the whole trip's spend`,
      score: 16 + soloTop.v,
    })
  const luckyTop = top(
    Object.fromEntries(
      entities
        .filter((e) => (st.paid[e.key] ?? 0) > 0)
        .map((e) => [e.key, (st.paid[e.key] ?? 0) - (st.consumed[e.key] ?? 0)])
    )
  )
  if (luckyTop && luckyTop.v > 0)
    awards.push({
      emoji: "🍀",
      title: "The Lucky One",
      members: [name(luckyTop.key)],
      detail: `fronted ${fmtU(luckyTop.v)} more than they consumed`,
      score: 12 + luckyTop.v / totalSpend,
    })
  const itemTop = top(st.itemLines, 1)
  if (itemTop)
    awards.push({
      emoji: "📝",
      title: "The Itemizer",
      members: [name(itemTop.key)],
      detail: `${itemTop.v} itemized lines to their name`,
      score: 11 + Math.min(itemTop.v / 10, 1),
    })
  const sponTop = top(Object.fromEntries(Object.entries(st.coveredBy).map(([k, s]) => [k, s.size])), 1)
  if (sponTop)
    awards.push({
      emoji: "🌟",
      title: "The Sponsor",
      members: [name(sponTop.key)],
      detail: `fronted for ${sponTop.v} different people`,
      score: 13 + sponTop.v / Math.max(nEnt - 1, 1),
    })
  const dayShare: Record<string, number> = {}
  for (const e of entities) {
    const days = Object.entries(st.memberDay).filter(([k]) => k.startsWith(`${e.key}>`))
    const total = st.consumed[e.key] ?? 0
    if (total > 0) dayShare[e.key] = Math.max(...days.map(([, v]) => v)) / total
  }
  const splurgeTop = top(dayShare, 0.5)
  if (splurgeTop)
    awards.push({
      emoji: "⚡",
      title: "The Splurger",
      members: [name(splurgeTop.key)],
      detail: `${Math.round(splurgeTop.v * 100)}% of their spend in one day`,
      score: 11 + splurgeTop.v,
    })
  const big3Top = comboAnyTop(3)
  if (big3Top && nEnt >= 4)
    awards.push({
      emoji: "💰",
      title: "The Big Three",
      members: membersOf(big3Top.key),
      detail: `${fmtU(big3Top.v)} of categorized spend together`,
      score: 15 + big3Top.v / totalSpend,
    })
  const big4Top = comboAnyTop(4)
  if (big4Top && nEnt >= 5)
    awards.push({
      emoji: "🧮",
      title: "The Big Four",
      members: membersOf(big4Top.key),
      detail: `${fmtU(big4Top.v)} of categorized spend together`,
      score: 15 + big4Top.v / totalSpend,
    })
  const coreTrio = top(st.trioOnly, 1)
  if (coreTrio && nEnt >= 4)
    awards.push({
      emoji: "👨‍👦‍👦",
      title: "Core Trio",
      members: membersOf(coreTrio.key),
      detail: `${coreTrio.v} expenses just the three of them`,
      score: 13 + Math.min(coreTrio.v / nExp, 1),
    })
  const catTop = top(st.catTotal)
  const catSquad: Record<string, string> = {
    Food: "The Buffet Battalion",
    Drinks: "The Liquid Assets",
    Coffee: "The Bean Counters",
    Groceries: "The Cart Pushers",
    Transport: "The Wheel Deal",
    Lodging: "The Pillow Talk Posse",
    Activities: "The Thrill Seekers",
    Tickets: "The Turnstile Gang",
    Shopping: "The Retail Therapists",
    Souvenirs: "The Trinket Tribe",
    Fees: "The Fine Print Club",
    Nightlife: "The Last Call Crew",
    Wellness: "The Spa Society",
    Other: "The Miscellaneous Society",
  }
  if (catTop)
    awards.push({
      emoji: "🏆",
      title: catSquad[catTop.key] ?? `The ${catTop.key} Squad`,
      members: [],
      detail: `most spent on ${catTop.key}`,
      score: 22 + (st.catTotal[catTop.key] ?? 0) / totalSpend,
    })
  return awards
}

export function funBoard(rows: TripRows) {
  const { trip: t, members } = rows
  if (members.length === 0) return { awards: [] }
  const out = new Set(members.filter((m) => m.opted_out_fun).map((m) => m.id))
  const st = collectStats(rows)
  const dec = decimals(t.settle_currency)
  const fmtU = (v: number) => `${v.toFixed(dec)} ${t.settle_currency}`
  const entities: Entity[] = members
    .filter((m) => !out.has(m.id))
    .map((m) => ({ key: m.id, name: m.name, views: m.detail_views ?? 0 }))
  const awards = pick(buildAwards(entities, st, fmtU), entities.length)
  return { awards: awards.map(({ score: _s, ...a }) => a), review: review(st, entities, fmtU) }
}

export function journeyBoard(jr: JourneyRows) {
  const { journey: j, trips } = jr
  if (trips.length === 0) return { awards: [] }
  const { persons, keyOf } = journeyPeople(jr)
  const memberById = new Map<string, Member>()
  for (const tr of trips) for (const m of tr.members) memberById.set(m.id, m)
  const kOf = (id: string) => {
    const m = memberById.get(id) as JourneyMember | undefined
    return m ? keyOf(m) : id
  }
  // a person is opted out if ANY of their member rows opted out
  const optedOut = new Set([...memberById.values()].filter((m) => m.opted_out_fun).map((m) => kOf(m.id)))
  const entities: Entity[] = [...persons.entries()]
    .filter(([k]) => !optedOut.has(k))
    .map(([k, p]) => ({
      key: k,
      name: p.name,
      views: p.memberIds.reduce((s, id) => s + (memberById.get(id)?.detail_views ?? 0), 0),
    }))
  if (entities.length === 0) return { awards: [] }
  const name = (k: string) => entities.find((e) => e.key === k)?.name ?? "?"

  const st = emptyStats()
  // count trips per person for Always Boarding / The Bank
  const tripPaid: Record<string, number> = {}
  const tripCovered: Record<string, number> = {}
  for (const tr of trips) {
    const ts = collectStats(tr)
    mergeInto(st, ts, kOf)
    for (const id of ts.paidTrip) {
      const k = kOf(id)
      tripPaid[k] = (tripPaid[k] ?? 0) + 1
    }
    for (const id of ts.coveredTrip) {
      const k = kOf(id)
      tripCovered[k] = (tripCovered[k] ?? 0) + 1
    }
  }
  const dec = decimals(j.settle_currency)
  const fmtU = (v: number) => `${v.toFixed(dec)} ${j.settle_currency}`
  const nTrips = trips.length
  const totalSpend = st.totalSpend || 1
  const awards = buildAwards(entities, st, fmtU)

  // journey-only achievements
  const whale = top(st.consumed)
  if (whale && whale.v > 0)
    awards.push({
      emoji: "💎",
      title: "Whale of the Journey",
      members: [name(whale.key)],
      detail: `${fmtU(whale.v)} across ${nTrips} trip${nTrips > 1 ? "s" : ""}`,
      score: 26 + whale.v / totalSpend,
    })
  const curTop = top(Object.fromEntries(Object.entries(st.currencies).map(([k, s]) => [k, s.size])))
  if (curTop && curTop.v >= 2)
    awards.push({
      emoji: "🪙",
      title: "Currency Collector",
      members: [name(curTop.key)],
      detail: `spent in ${curTop.v} currencies`,
      score: 18 + curTop.v / 6,
    })
  const boardTop = top(tripPaid)
  if (boardTop && boardTop.v >= 2)
    awards.push({
      emoji: "🚂",
      title: "Always Boarding",
      members: [name(boardTop.key)],
      detail: `paid for things on ${boardTop.v} trips`,
      score: 18 + boardTop.v / nTrips,
    })
  const bankTop = top(tripCovered)
  if (bankTop && bankTop.v >= 2)
    awards.push({
      emoji: "💳",
      title: "The Bank",
      members: [name(bankTop.key)],
      detail: `covered others on ${bankTop.v} trips`,
      score: 18 + bankTop.v / nTrips,
    })
  const partners: Record<string, Set<string>> = {}
  for (const k of Object.keys(st.pairShare)) {
    const [a, b] = k.split(">")
    const pa = partners[a ?? ""] ?? new Set()
    pa.add(b ?? "")
    partners[a ?? ""] = pa
    const pb = partners[b ?? ""] ?? new Set()
    pb.add(a ?? "")
    partners[b ?? ""] = pb
  }
  const glueTop = top(Object.fromEntries(Object.entries(partners).map(([k, s]) => [k, s.size])))
  if (glueTop && glueTop.v >= 2)
    awards.push({
      emoji: "🤝",
      title: "The Glue",
      members: [name(glueTop.key)],
      detail: `split expenses with ${glueTop.v} different people`,
      score: 17 + glueTop.v / Math.max(entities.length - 1, 1),
    })
  if (st.biggestExp && st.biggestExp.sharers.length)
    awards.push({
      emoji: "🧊",
      title: "The Iceberg",
      members: st.biggestExp.sharers.map(name),
      detail: `everyone on the biggest expense: ${fmtU(st.biggestExp.units)}`,
      score: 16 + st.biggestExp.units / totalSpend,
    })

  const picked = pick(awards, entities.length)
  return { awards: picked.map(({ score: _s, ...a }) => a), review: review(st, entities, fmtU) }
}
