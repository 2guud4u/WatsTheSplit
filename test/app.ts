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

console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
