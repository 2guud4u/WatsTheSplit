// Dev-only demo trip seeded on first boot: touches every feature — items,
// per-item splits, unassigned & over-assigned totals, categories, foreign
// currencies with locked rates, a no-rate expense, settlements, and the
// Trip Wrapped board. Always seeded in dev when absent; WTS_DEMO=0 disables.
import { db } from "./db.ts";

export const DEMO_TOKEN = "demo";

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
export function seedDemo(): string | null {
  if (process.env.WTS_DEMO === "0") return null;
  if (db.query("SELECT 1 FROM trips WHERE token = ?").get(DEMO_TOKEN)) return null;

  db.exec("BEGIN");
  try {
    db.run(
      `INSERT INTO trips (token, name, start_date, end_date, trip_currency, settle_currency,
         password_hash, password_text, password_ver, fun_leaderboard, created_by_token, created_at)
       VALUES (?,?,?,?,?,?, ?, 'demo', 0, 1, NULL, ?)`,
      [DEMO_TOKEN, "Demo Trip · Chiang Mai 🌴", "2026-10-10", "2026-10-14", "THB", "USD",
       Bun.password.hashSync("demo"), now()],
    );

    const members: Record<string, string> = {};
    for (const name of ["Alice", "Bob", "Carol", "Dave"]) {
      const id = uid();
      members[name] = id;
      db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
        [id, DEMO_TOKEN, name, now()]);
    }

    // Bob peeked at the details modal a suspicious number of times.
    db.run("UPDATE members SET detail_views = 6 WHERE id = ?", [members.Bob]);
    db.run("UPDATE members SET detail_views = 2 WHERE id = ?", [members.Carol]);

    const addExpense = (o: {
      name: string; currency: string; totalMinor: number; payer?: string;
      category?: string; rate?: number | null; when?: string;
    }) => {
      const id = uid();
      db.run(
        `INSERT INTO expenses (id, trip_token, name, currency, total_minor, payer_member_id,
           category, rate, rate_provider, rate_timestamp, recorded_at, last_edited_by, last_edited_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, DEMO_TOKEN, o.name, o.currency, o.totalMinor, o.payer ? members[o.payer] : null,
          o.category ?? null, o.rate ?? null, o.rate ? "demo" : null,
          o.rate ? "2026-10-13T09:00:00Z" : null,
          o.when ?? now(), null, now(), now()],
      );
      return id;
    };
    const share = (exp: string, member: string, minor: number | null) =>
      db.run("INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,?)",
        [exp, members[member], minor]);
    const addItem = (exp: string, name: string, priceMinor: number, sharers: string[]) => {
      const id = uid();
      db.run("INSERT INTO items (id, expense_id, name, price_minor) VALUES (?,?,?,?)",
        [id, exp, name, priceMinor]);
      for (const m of sharers) db.run(
        "INSERT INTO item_sharers (item_id, member_id) VALUES (?,?)", [id, members[m]]);
    };
    const settle = (from: string, to: string, minor: number) =>
      db.run("INSERT INTO settlements (id, trip_token, from_member, to_member, amount_minor, created_at, created_by) VALUES (?,?,?,?,?,?,?)",
        [uid(), DEMO_TOKEN, members[from], members[to], minor, now(), from]);

    // 1) Itemized dinner: per-item sharers, fully assigned.
    const dinner = addExpense({
      name: "Khao Soi dinner", currency: "THB", totalMinor: 142000,
      payer: "Alice", category: "Food", rate: 0.0281, when: "2026-10-11T12:00:00Z",
    });
    addItem(dinner, "Khao soi", 56000, ["Alice", "Bob", "Carol", "Dave"]);
    addItem(dinner, "Pad see ew", 30000, ["Bob", "Carol"]);
    addItem(dinner, "Mango sticky rice", 32000, ["Alice", "Dave"]);
    addItem(dinner, "Chang beers", 24000, ["Bob", "Dave"]);

    // 2) Equal split: everyone, share_minor NULL.
    const taxi = addExpense({
      name: "Songthaew to Old City", currency: "THB", totalMinor: 40000,
      payer: "Bob", category: "Transport", rate: 0.0281, when: "2026-10-11T15:00:00Z",
    });
    for (const m of ["Alice", "Bob", "Carol", "Dave"]) share(taxi, m, null);

    // 3) Partly assigned: typed shares don't cover the total → "unassigned" badge.
    const market = addExpense({
      name: "Night market snacks", currency: "THB", totalMinor: 60000,
      payer: "Carol", category: "Food", rate: 0.0281, when: "2026-10-12T14:00:00Z",
    });
    share(market, "Carol", 20000);
    share(market, "Dave", 20000);

    // 4) Over-assigned: typed shares exceed the total → "over" badge.
    const store = addExpense({
      name: "7-Eleven run", currency: "THB", totalMinor: 28000,
      payer: "Dave", category: "Shopping", rate: 0.0281, when: "2026-10-12T19:00:00Z",
    });
    share(store, "Alice", 15000);
    share(store, "Dave", 15000);

    // 5) EUR expense with a locked rate.
    const museum = addExpense({
      name: "Museum gift shop", currency: "EUR", totalMinor: 4500,
      payer: "Alice", category: "Shopping", rate: 1.09, when: "2026-10-13T10:00:00Z",
    });
    share(museum, "Alice", null);
    share(museum, "Carol", null);

    // 6) No rate: a currency outside the fetched set → "no rate" badge.
    const temple = addExpense({
      name: "Temple donation", currency: "XTS", totalMinor: 2000000,
      payer: "Bob", category: "Other", rate: null, when: "2026-10-13T16:00:00Z",
    });
    share(temple, "Bob", null);
    share(temple, "Carol", null);

    // 7) Bar crawl → Drinks category heavy.
    const crawl = addExpense({
      name: "Riverside bar crawl", currency: "THB", totalMinor: 180000,
      payer: "Dave", category: "Drinks", rate: 0.0281, when: "2026-10-13T20:00:00Z",
    });
    addItem(crawl, "Cocktails", 120000, ["Alice", "Dave"]);
    addItem(crawl, "Shots", 60000, ["Bob", "Carol", "Dave"]);

    // 8–10) New categories + creator spread (Alice files the most → Tax Man).
    const cafe = addExpense({
      name: "Café crawl", currency: "THB", totalMinor: 32000,
      payer: "Carol", category: "Coffee", rate: 0.0281, when: "2026-10-12T09:00:00Z",
    });
    share(cafe, "Alice", 20000); share(cafe, "Carol", 12000);
    const spa = addExpense({
      name: "Massage hour", currency: "THB", totalMinor: 70000,
      payer: "Alice", category: "Wellness", rate: 0.0281, when: "2026-10-13T13:00:00Z",
    });
    share(spa, "Alice", 40000); share(spa, "Dave", 30000);
    const club = addExpense({
      name: "Rooftop club", currency: "THB", totalMinor: 90000,
      payer: "Bob", category: "Nightlife", rate: 0.0281, when: "2026-10-13T23:00:00Z",
    });
    addItem(club, "Bottle service", 60000, ["Bob", "Carol"]);
    addItem(club, "Cover charge", 30000, ["Alice", "Bob", "Carol", "Dave"]);

    // expense creators for the Tax Man award (Alice: 3, Bob: 2, Carol: 2, Dave: 2)
    const creators: [string, string][] = [
      [dinner, "Alice"], [taxi, "Alice"], [market, "Alice"], [store, "Bob"],
      [museum, "Alice"], [temple, "Bob"], [crawl, "Carol"], [cafe, "Carol"],
      [spa, "Dave"], [club, "Dave"],
    ];
    for (const [exp, m] of creators)
      db.run("UPDATE expenses SET created_by_member_id = ? WHERE id = ?", [members[m], exp]);

    // Settlements.
    settle("Bob", "Alice", 2000);
    settle("Carol", "Dave", 1500);

    db.exec("COMMIT");
    return DEMO_TOKEN;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
