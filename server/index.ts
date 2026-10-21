// Boot: open the db, wire adapters, serve. All app behaviour lives in app.ts —
// createApp(deps) is importable by tests with a :memory: db and a captured mailer.
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { resendMailer, consoleMailer } from "./auth.ts";
import { startFxLoop } from "./fx.ts";
import { seedDemo, DEMO_TOKEN } from "./demo.ts";

const PORT = Number(process.env.PORT ?? 8081);
const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const DIST = new URL("../dist", import.meta.url).pathname;

openDb();
startFxLoop();

const resendKey = process.env.RESEND_API_KEY ?? "";
const app = createApp({
  mailer: resendKey
    ? resendMailer(resendKey, process.env.EMAIL_FROM ?? "WatsTheSplit <onboarding@resend.dev>")
    : consoleMailer,
  baseUrl: BASE_URL,
  basePath: process.env.BASE_PATH ?? "",
  dist: DIST,
});

Bun.serve({ port: PORT, fetch: app });
try { if (seedDemo()) console.log(`demo trip: http://localhost:${PORT}/#/t/${DEMO_TOKEN}`); }
catch (e) { console.error("demo seed failed:", e); }
console.log(`WatsTheSplit on http://localhost:${PORT}`);
