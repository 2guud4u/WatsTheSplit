// In-process app tests: :memory: db + captured mailer. No process spawn,
// no sleeps. Covers what smoke.ts can't reach: the email-code sign-in flow
// (rate limit, wrong code, claim→Linked promotion) and BASE_PATH stripping.
import { openDb } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { captureMailer } from "../server/auth.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`FAIL  ${name}`, extra ?? ""); }
};

const DIST = new URL("../dist", import.meta.url).pathname;

function newApp(basePath = "") {
  openDb(":memory:");
  const { mailer, sent } = captureMailer();
  const app = createApp({ mailer, baseUrl: "http://test", basePath, dist: DIST });
  return { app, sent };
}

class Dev {
  cookie = "";
  constructor(private app: (req: Request) => Promise<Response>) {}
  async req(method: string, path: string, body?: unknown) {
    const res = await this.app(new Request(`http://test${path}`, {
      method,
      headers: {
        "x-wts": "1",
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const data: unknown = await res.json().catch(() => ({}));
    return { status: res.status, data: data && typeof data === "object" ? data as Record<string, unknown> : {} };
  }
  get(p: string) { return this.req("GET", p); }
  post(p: string, b?: unknown) { return this.req("POST", p, b ?? {}); }
  patch(p: string, b: unknown) { return this.req("PATCH", p, b); }
  async postRaw(p: string, buf: Uint8Array, contentType: string) {
    const res = await this.app(new Request(`http://test${p}`, {
      method: "POST",
      headers: { "x-wts": "1", "content-type": contentType, ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: buf,
    }));
    const data: unknown = await res.json().catch(() => ({}));
    return { status: res.status, data: data && typeof data === "object" ? data as Record<string, unknown> : {} };
  }
  async raw(p: string) { return this.app(new Request(`http://test${p}`, { headers: this.cookie ? { cookie: this.cookie } : {} })); }
}

const codeOf = (text: string) => /code is ([A-Z0-9]{4})/.exec(text)?.[1] ?? "";
const str = (v: unknown) => (typeof v === "string" ? v : "");

// ---- config + BASE_PATH ----
{
  const { app } = newApp();
  const r = await app(new Request("http://test/api/config"));
  const cfg = await r.json() as Record<string, unknown>;
  check("config responds", r.status === 200);
  check("config baseUrl", cfg.baseUrl === "http://test");
}
{
  const { app } = newApp("/watsthesplit");
  const r = await app(new Request("http://test/watsthesplit/api/config"));
  check("BASE_PATH route served", r.status === 200);
  const r2 = await app(new Request("http://test/api/config"));
  check("unprefixed path 404s under BASE_PATH", r2.status === 404);
}

// ---- CSRF ----
{
  const { app } = newApp();
  const r = await app(new Request("http://test/api/auth/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.co" }),
  }));
  check("POST without x-wts rejected", r.status === 403);
}

// ---- email sign-in: the whole flow, unreachable in smoke ----
{
  const { app, sent } = newApp();
  const d = new Dev(app);

  const bad = await d.post("/api/auth/email", { email: "notanemail" });
  check("bad email 400", bad.status === 400);

  const send = await d.post("/api/auth/email", { email: "User@Example.com" });
  check("code sent", send.status === 200);
  check("email went to lowercase address", sent[0]?.to === "user@example.com");
  const code = codeOf(sent[0]?.text ?? "");
  check("code shape", /^[A-Z0-9]{4}$/.test(code), sent[0]?.text);

  const wrong = await d.post("/api/auth/email/verify", { email: "user@example.com", code: "ZZZZ" });
  check("wrong code 403", wrong.status === 403 && wrong.data.error === "wrong_code");

  const ok = await d.post("/api/auth/email/verify", { email: "user@example.com", code });
  check("verify ok", ok.status === 200);
  check("session cookie set", d.cookie.includes("wts_session="));

  const me = await d.get("/api/me");
  const u = me.data.user;
  check("me shows user",
    !!u && typeof u === "object" && "email" in u && u.email === "user@example.com");

  // code is single-use
  const again = await d.post("/api/auth/email/verify", { email: "user@example.com", code });
  check("code single-use", again.status === 400 && again.data.error === "no_code");

  // sign out clears
  await d.post("/api/auth/signout");
  const me2 = await d.get("/api/me");
  check("signout clears user", me2.data.user === null);
}

// ---- rate limit: 3 sends per email per hour ----
{
  const { app } = newApp();
  const d = new Dev(app);
  for (let i = 0; i < 3; i++) await d.post("/api/auth/email", { email: "spam@x.co" });
  const fourth = await d.post("/api/auth/email", { email: "spam@x.co" });
  check("4th send rate-limited", fourth.status === 429 && fourth.data.error === "too_many_codes");
}

// ---- send failure surfaces as 502 ----
{
  openDb(":memory:");
  const app = createApp({
    mailer: async () => { throw new Error("resend_403 unverified domain"); },
    baseUrl: "http://test", dist: DIST,
  });
  const d = new Dev(app);
  const r = await d.post("/api/auth/email", { email: "x@y.co" });
  check("mailer failure → 502 send_failed", r.status === 502 && r.data.error === "send_failed");
  // nothing stored: verify reports no_code, not expired/wrong
  const v = await d.post("/api/auth/email/verify", { email: "x@y.co", code: "AAAA" });
  check("no code stored on failure", v.status === 400 && v.data.error === "no_code");
}

// ---- sign-in promotes claimed members to Linked Members ----
{
  const { app, sent } = newApp();
  const d = new Dev(app);
  const trip = await d.post("/api/trips", {
    name: "T", trip_currency: "USD", settle_currency: "USD", password: "pw",
  });
  check("trip created", trip.status === 200, trip.data);
  const token = str(trip.data.token);

  // claim a placeholder member on this device
  const claim = await d.post(`/api/trips/${token}/claim`, { name: "Alice" });
  check("claimed member", claim.status === 200, claim.data);
  const memberId = str(claim.data.member_id);

  // sign in on the same device
  await d.post("/api/auth/email", { email: "alice@x.co" });
  const code = codeOf(sent.at(-1)?.text ?? "");
  const v = await d.post("/api/auth/email/verify", { email: "alice@x.co", code });
  check("signed in", v.status === 200);

  // the claimed member is now linked to the account
  const view = await d.get(`/api/trips/${token}`);
  const members = Array.isArray(view.data.members) ? view.data.members : [];
  const linked = members.find((m) =>
    typeof m === "object" && m !== null && "id" in m && m.id === memberId);
  check("claim promoted to linked",
    !!linked && typeof linked === "object" && "linked" in linked && linked.linked === true,
    view.data.members);
}

// ---- ADR-0004 access matrix: journey link → view member trips → claim upgrades ----
{
  const { app } = newApp();
  const owner = new Dev(app);
  const viewer = new Dev(app);

  const tr = await owner.post("/api/trips", {
    name: "T1", trip_currency: "USD", settle_currency: "USD", password: "pw", members: "Alice,Bob",
  });
  const token = str(tr.data.token);
  const jr = await owner.post("/api/journeys", { name: "J", trip_tokens: [token] });
  check("journey created", jr.status === 200, jr.data);
  const jToken = str(jr.data.token);

  // expense + photo under owner, so we can test viewer photo access
  const tr2 = await owner.get(`/api/trips/${token}`);
  const members = Array.isArray(tr2.data.members) ? tr2.data.members : [];
  const payer = members.find((m) => typeof m === "object" && m !== null && "name" in m && m.name === "Alice");
  const payerId = payer && typeof payer === "object" && "id" in payer ? str(payer.id) : "";
  const ex = await owner.post(`/api/trips/${token}/expenses`, {
    name: "Dinner", currency: "USD", total_minor: 1000, payer_member_id: payerId,
  });
  check("expense created", ex.status === 200, ex.data);
  const expenseId = str(ex.data.id);
  const ph = await owner.postRaw(`/api/expenses/${expenseId}/photos`, new Uint8Array([1, 2, 3]), "image/png");
  check("photo uploaded", ph.status === 200, ph.data);
  const photoId = str(ph.data.id);

  // before join: viewer has no access anywhere
  const v0 = await viewer.get(`/api/trips/${token}`);
  check("viewer blocked before join", v0.status === 401);

  // open the journey link → read access to member trips
  const join = await viewer.post(`/api/journeys/${jToken}/join`);
  check("join ok", join.status === 200);
  const vj = await viewer.get(`/api/journeys/${jToken}`);
  check("viewer reads journey", vj.status === 200);
  const v1 = await viewer.get(`/api/trips/${token}`);
  check("viewer reads member trip", v1.status === 200 && v1.data.access === "view");

  // viewer reads expense + photo (was 401 — photo GET used edit tier)
  const ve = await viewer.get(`/api/expenses/${expenseId}`);
  check("viewer reads expense", ve.status === 200 && ve.data.access === "view");
  const vp = await viewer.raw(`/api/photos/${photoId}`);
  check("viewer reads photo", vp.status === 200 && vp.headers.get("content-type") === "image/png");

  // viewer gets the SSE stream (was 401 — events used edit tier)
  const vsse = await viewer.raw(`/api/trips/${token}/events`);
  check("viewer SSE streams", vsse.status === 200 && vsse.headers.get("content-type") === "text/event-stream");
  vsse.body?.cancel();

  // but cannot mutate
  const vm = await viewer.post(`/api/trips/${token}/expenses`, { name: "x", currency: "USD", total_minor: 1 });
  check("viewer cannot mutate", vm.status === 401);

  // claim upgrades the viewer to edit on that trip
  const vc = await viewer.post(`/api/trips/${token}/claim`, { name: "Carol" });
  check("viewer claims member", vc.status === 200, vc.data);
  const vm2 = await viewer.post(`/api/trips/${token}/expenses`, { name: "x", currency: "USD", total_minor: 1 });
  check("claimed viewer can mutate", vm2.status === 200);

  // password rotation revokes consents; stale-consent trips must not list journeys
  await owner.patch(`/api/trips/${token}/settings`, { password: "pw2" });
  const mj = await viewer.get("/api/my-journeys");
  const stillViewer = Array.isArray(mj.data.journeys) ? mj.data.journeys : [];
  check("viewer keeps journey via grant", stillViewer.length === 1, mj.data);

  // stranger with only a stale consent sees nothing
  const stranger = new Dev(app);
  await stranger.post(`/api/trips/${token}/password`, { password: "pw" }); // fails: wrong password now
  const sj = await stranger.get("/api/my-journeys");
  check("stranger sees no journeys", Array.isArray(sj.data.journeys) && sj.data.journeys.length === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

