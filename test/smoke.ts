// End-to-end smoke test: spawns the server on port 3999 with a temp DB
// seeded with an FX snapshot, then exercises the full flow.
import { Database } from "bun:sqlite";

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const DB = "/tmp/wts-smoke.db";

// fresh DB + seed rates (USD base): 1 USD = 0.9 EUR, 150 JPY
try { await Bun.file(DB).delete(); } catch {}
try { await Bun.file(DB + "-wal").delete(); } catch {}
try { await Bun.file(DB + "-shm").delete(); } catch {}
{
  const seed = new Database(DB, { create: true });
  seed.exec(`CREATE TABLE IF NOT EXISTS fx_latest (code TEXT PRIMARY KEY, usd_rate REAL NOT NULL, provider_timestamp TEXT NOT NULL, fetched_at TEXT NOT NULL)`);
  seed.run("INSERT INTO fx_latest VALUES ('USD', 1.0, '2026-10-15T12:00:00Z', '2026-10-15T12:00:00Z')", []);
  seed.run("INSERT INTO fx_latest VALUES ('EUR', 0.9, '2026-10-15T12:00:00Z', '2026-10-15T12:00:00Z')", []);
  seed.run("INSERT INTO fx_latest VALUES ('JPY', 150.0, '2026-10-15T12:00:00Z', '2026-10-15T12:00:00Z')", []);
  seed.close();
}

const proc = Bun.spawn(["bun", "server/index.ts"], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, OXR_APP_ID: "", FX_OFFLINE: "1", BASE_URL: BASE },
  stdout: "inherit", stderr: "inherit",
});
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`FAIL  ${name}`, extra ?? ""); }
};

{ const { promise, resolve } = Promise.withResolvers<undefined>(); setTimeout(() => resolve(undefined), 800); await promise; }
class Dev {
  cookie = "";
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "x-wts": "1",
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
  get(p: string) { return this.req("GET", p); }
  post(p: string, b?: unknown) { return this.req("POST", p, b ?? {}); }
  patch(p: string, b: unknown) { return this.req("PATCH", p, b); }
  put(p: string, b: unknown) { return this.req("PUT", p, b); }
  del(p: string, b?: unknown) { return this.req("DELETE", p, b); }
}

const alice = new Dev();
const bob = new Dev();

// --- create + join ---
const trip = (await alice.post("/api/trips", {
  name: "Japan", start_date: "2026-11-01", end_date: "2026-11-10",
  trip_currency: "JPY", settle_currency: "USD", password: "nabe",
})).data;
check("create trip", !!trip.token, trip);

// password required at creation
let r = await bob.post("/api/trips", { name: "x", trip_currency: "USD", settle_currency: "USD" });
check("create without password rejected", r.status === 400 && r.data.error === "password_required");
// fun leaderboard needs an end date (unlocks on the end day)
r = await bob.post("/api/trips", { name: "Undated", trip_currency: "USD", settle_currency: "USD", password: "x" });
const undated = r.data.token;
r = await bob.post(`/api/trips/${undated}/password`, { password: "x" });
r = await bob.patch(`/api/trips/${undated}/settings`, { fun_leaderboard: true });
check("wrapped enable needs end date", r.status === 400 && r.data.error === "end_date_required");
r = await bob.patch(`/api/trips/${undated}/settings`, { end_date: "2026-12-01", fun_leaderboard: true });
check("wrapped enable ok once dated", r.status === 200);
const T = `/api/trips/${trip.token}`;

r = await alice.get(T);
check("new session sees trip w/o me", r.data.me === null && r.data.trip.name === "Japan");

r = await alice.post(`${T}/claim`, { name: "Alice" });
check("alice joins", r.data.ok);
const aliceId = r.data.member_id;

r = await alice.post(`${T}/members`, { name: "Bob" });
const bobId = r.data.id;
r = await alice.post(`${T}/members`, { name: "Carol" });
const carolId = r.data.id;

r = await bob.post(`${T}/password`, { password: "nabe" });
check("bob consents via password", r.data.ok);

r = await bob.post(`${T}/claim`, { member_id: bobId });
check("bob claims placeholder", r.data.ok);

r = await alice.get(T);
check("trip lists 3 members", r.data.members.length === 3, r.data.members);

// reselect: claiming a different member moves "me"; claiming back restores it
r = await bob.post(`${T}/claim`, { member_id: carolId });
check("bob re-claims a different member", r.data.ok);
r = await bob.get(T);
check("re-claim moves me", r.data.me?.id === carolId, r.data.me);
r = await bob.post(`${T}/claim`, { member_id: bobId });
check("bob claims back", r.data.ok);

// --- expense with shares ---
r = await alice.post(`${T}/expenses`, { name: "Dinner", total_minor: 9000, currency: "JPY", payer_member_id: aliceId });
check("create expense", !!r.data.id, r.data);
const expId = r.data.id;

let exp = (await alice.get(`/api/expenses/${expId}`)).data.expense;
check("rate locked at creation", exp.rate === 1 / 150, exp.rate); // USD per JPY via USD base
check("rate timestamp stored", exp.rate_timestamp === "2026-10-15T12:00:00Z");

exp = (await alice.get(`/api/expenses/${expId}`)).data.expense;
check("new expense auto-includes everyone", exp.participants.length === 3, exp.participants.length);
await alice.put(`/api/expenses/${expId}/shares`, { member_id: bobId, share_minor: 6000 });
exp = (await alice.get(`/api/expenses/${expId}`)).data.expense;
check("remainder split across NULL participants", exp.unassigned_minor === 0, exp.unassigned_minor);
const eff0 = Object.fromEntries(exp.effective_shares.map((s: { member_id: string; minor: number | null }) => [s.member_id, s.minor]));
check("alice+carol get equal remainder", eff0[aliceId] === 1500 && eff0[carolId] === 1500, eff0);
check("not over", exp.over === false);

// over-assigned is allowed
await alice.put(`/api/expenses/${expId}/shares`, { member_id: aliceId, share_minor: 5000 });
exp = (await alice.get(`/api/expenses/${expId}`)).data.expense;
check("over-assigned flagged", exp.over === true && exp.unassigned_minor === -2000, exp);

// anyone (bob) can type alice's share
r = await bob.put(`/api/expenses/${expId}/shares`, { member_id: aliceId, share_minor: 3000 });
check("bob edits alice's share", r.data.ok);
exp = (await alice.get(`/api/expenses/${expId}`)).data.expense;
check("fully assigned", exp.unassigned_minor === 0);
check("last edited by bob", exp.last_edited_by === "Bob", exp.last_edited_by);

// balance: bob owes alice 6000 JPY * (1/150) = 40 USD
r = await alice.get(T);
const pair = r.data.balances.find((p: { from: string; to: string }) => p.from === bobId && p.to === aliceId);
check("bob owes alice $40", Math.abs(pair?.amount - 40) < 0.001, r.data.balances);

// --- items mode expense ---
r = await alice.post(`${T}/expenses`, { name: "Sushi", total_minor: 4500, currency: "JPY", payer_member_id: bobId });
const exp2 = r.data.id;
await alice.patch(`/api/expenses/${exp2}`, { mode: "items" });
r = await alice.post(`/api/expenses/${exp2}/items`, { name: "nigiri", price_minor: 3000, sharers: [aliceId, bobId] });
const itemId = r.data.id;
await alice.post(`/api/expenses/${exp2}/items`, { name: "carol's bowl", price_minor: 1500, sharers: [carolId] });
exp = (await alice.get(`/api/expenses/${exp2}`)).data.expense;
check("item sharers auto-participate", exp.participants.length === 3, exp.participants.map((p: { name: string }) => p.name));
check("fully assigned via items", exp.unassigned_minor === 0, exp.unassigned_minor);
const eff = Object.fromEntries(exp.effective_shares.map((s: { member_id: string; minor: number | null }) => [s.member_id, s.minor]));
check("derived shares", eff[aliceId] === 1500 && eff[bobId] === 1500 && eff[carolId] === 1500, eff);

// removing participant removes their item sharership
await alice.put(`/api/expenses/${exp2}/participants`, { member_id: carolId, on: false });
exp = (await alice.get(`/api/expenses/${exp2}`)).data.expense;
const carolItem = exp.items.find((i: { name: string }) => i.name === "carol's bowl");
check("removing participant clears item sharer", carolItem.sharers.length === 0, carolItem);
await alice.put(`/api/expenses/${exp2}/participants`, { member_id: carolId, on: true });
await alice.patch(`/api/items/${itemId}`.replace(itemId, carolItem.id), { sharers: [carolId] });

// --- currency change re-fetches rate ---
await alice.patch(`/api/expenses/${exp2}`, { currency: "EUR" });
exp = (await alice.get(`/api/expenses/${exp2}`)).data.expense;
check("currency change re-locks rate", Math.abs(exp.rate - 1 / 0.9) < 1e-9, exp.rate);

// --- trip currencies locked at creation ---
r = await alice.patch(`${T}/settings`, { settle_currency: "EUR" });
check("settle currency locked", r.status === 400 && r.data.error === "currencies_locked", r.data);
r = await alice.patch(`${T}/settings`, { trip_currency: "EUR" });
check("trip currency locked", r.status === 400 && r.data.error === "currencies_locked", r.data);

// --- settlement ---
// alice's sushi share now outweighs bob's dinner debt → net is alice→bob
r = await alice.get(T);
const owed = r.data.balances.find((p: { from: string; to: string }) => p.from === aliceId && p.to === bobId)?.amount ?? 0;
await alice.post(`${T}/settlements`, { from_member: aliceId, to_member: bobId, amount_minor: Math.round(owed * 100) });
r = await alice.get(T);
const after = r.data.balances.find((p: { from: string; to: string; amount: number }) =>
  (p.from === bobId && p.to === aliceId) || (p.from === aliceId && p.to === bobId));
check("settlement nets out", !after || Math.abs(after.amount) < 0.02, r.data.balances);

// --- member removal rules ---
r = await alice.post(`${T}/members`, { name: "Unused" });
const unusedId = r.data.id;
r = await alice.del(`/api/members/${unusedId}`);
check("unused member removable", r.data.ok);
r = await alice.del(`/api/members/${bobId}`);
check("used member not removable", r.status === 400 && r.data.error === "member_in_use");

// --- password: changing revokes; removal rejected ---
const dave = new Dev();
r = await dave.get(T);
check("password blocks new device", r.status === 401 && r.data.error === "password_required");
r = await dave.post(`${T}/password`, { password: "nabe" });
check("right password opens", r.data.ok);
r = await dave.get(T);
check("dave sees trip after password", r.data.trip.name === "Japan");
check("trip payload exposes password for invite link", r.data.trip.password === "nabe");
r = await alice.patch(`${T}/settings`, { password: "" });
check("password removal rejected", r.status === 400 && r.data.error === "password_empty");
await alice.patch(`${T}/settings`, { password: "sushi" });


// changing password revokes existing sessions
await alice.patch(`${T}/settings`, { password: "ramen" });
r = await dave.get(T);
check("password change revokes consent", r.status === 401);
await dave.post(`${T}/password`, { password: "ramen" });

// --- CSRF guard ---
const raw = await fetch(`${BASE}${T}/members`, {
  method: "POST", headers: { "content-type": "application/json", cookie: dave.cookie },
  body: JSON.stringify({ name: "csrf" }),
});
check("mutation without x-wts rejected", raw.status === 403);

// --- SSE emits on change ---
const ev = await fetch(`${BASE}${T}/events`, { headers: { cookie: alice.cookie } });
const reader = ev.body!.getReader();
await reader.read(); // consume the ": connected" keepalive
await alice.post(`${T}/members`, { name: "SSE" });
const sseTimeout = Promise.withResolvers<never>();
const sseTimer = setTimeout(() => sseTimeout.reject(new Error("no SSE")), 3000);
const { value } = await Promise.race([reader.read(), sseTimeout.promise]);
clearTimeout(sseTimer);
check("SSE fires on mutation", new TextDecoder().decode(value).includes("data:"));
reader.cancel().catch(() => {});

// --- delete trip requires name ---
r = await alice.del(T, { name: "wrong" });
check("delete needs exact name", r.status === 400);
r = await alice.del(T, { name: "Japan" });
check("delete trip", r.data.ok);
r = await alice.get(T);
check("deleted trip 404s", r.status === 404);

proc.kill();
console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
