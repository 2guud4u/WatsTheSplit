// Auth routes: config, me, email-code sign-in, signout, my-trips.
import { db, stmt } from "../db.ts";
import { CURRENCIES } from "../currencies.ts";
import { mutate } from "../mutate.ts";
import * as notify from "../notify.ts";
import type { Route, RouteCtx } from "../routes.ts";

export function routes(ctx: RouteCtx): Route[] {
  const { json, err, baseUrl, auth } = ctx;
  return [
    [/^\/api\/config$/, "GET", async () =>
      json({ baseUrl, currencies: CURRENCIES })],

    [/^\/api\/me$/, "GET", async (_req, _m, _body, s) => {
      const user = s.user_sub
        ? stmt<{ email: string; name: string | null; phone: string | null; venmo: string | null; cash_app: string | null }, [string]>(
            "SELECT email, name, phone, venmo, cash_app FROM users WHERE email = ?").get(s.user_sub)
        : null;
      return json({ user: user ? {
        email: user.email, name: user.name,
        payment: { phone: user.phone, venmo: user.venmo, cash_app: user.cash_app },
      } : null });
    }],

    [/^\/api\/me$/, "PUT", async (_req, _m, body, s) => {
      if (!s.user_sub) return err(401, "not_signed_in");
      // undefined = don't change; null = clear (set NULL); string = set (trim).
      const p = body.payment as { phone?: unknown; venmo?: unknown; cash_app?: unknown } | undefined;
      if (p) {
        const pairs: string[] = [], vals: (string | null)[] = [];
        for (const [col, v] of [["phone", p.phone], ["venmo", p.venmo], ["cash_app", p.cash_app]] as const) {
          if (v === undefined) continue;
          const val = v === null ? null : String(v).trim() || null;
          pairs.push(`${col} = ?`); vals.push(val);
        }
        if (pairs.length) db.run(`UPDATE users SET ${pairs.join(", ")} WHERE email = ?`, [...vals, s.user_sub]);
      }
      const user = stmt<{ email: string; name: string | null; phone: string | null; venmo: string | null; cash_app: string | null }, [string]>(
        "SELECT email, name, phone, venmo, cash_app FROM users WHERE email = ?").get(s.user_sub)!;
      return json({ user: {
        email: user.email, name: user.name,
        payment: { phone: user.phone, venmo: user.venmo, cash_app: user.cash_app },
      } });
    }],

    [/^\/api\/auth\/email$/, "POST", async (_req, _m, body) => {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "bad_email");
      const r = await auth.sendCode(email);
      if (r === "rate_limited") return err(429, "too_many_codes");
      if (r === "send_failed") return err(502, "send_failed");
      return json({ ok: true });
    }],

    [/^\/api\/auth\/email\/verify$/, "POST", async (_req, _m, body, s) => {
      const email = String(body.email ?? "").trim().toLowerCase();
      const r = await auth.checkCode(email, String(body.code ?? ""));
      if (r === "no_code") return err(400, "no_code");
      if (r === "code_expired") return err(400, "code_expired");
      if (r === "too_many_attempts") return err(429, "too_many_attempts");
      if (r === "wrong_code") return err(403, "wrong_code");
      const linked = mutate(() => {
        db.run("INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING", [email]);
        db.run("UPDATE sessions SET user_sub = ? WHERE token = ?", [email, s.token]);
        // Signing in locks the names this device already picked: each unlinked
        // claimed Member becomes a Linked Member, unless the account already has
        // a different Linked Member in that trip.
        db.run(
          `UPDATE members SET user_sub = ?
           WHERE user_sub IS NULL
             AND id IN (SELECT member_id FROM claims WHERE session_token = ?)
             AND trip_token NOT IN (SELECT trip_token FROM members WHERE user_sub = ?)`,
          [email, s.token, email],
        );
        // Promote: this device's member rows' payment (set while unlinked) now
        // becomes the account's payment, filling only empty fields.
        const m = stmt<{ phone: string | null; venmo: string | null; cash_app: string | null }, [string]>(
          `SELECT m.phone, m.venmo, m.cash_app FROM members m
           JOIN claims c ON c.member_id = m.id
           WHERE c.session_token = ?
             AND (m.phone IS NOT NULL OR m.venmo IS NOT NULL OR m.cash_app IS NOT NULL)
           ORDER BY (m.phone IS NOT NULL) + (m.venmo IS NOT NULL) + (m.cash_app IS NOT NULL) DESC
           LIMIT 1`
        ).get(s.token);
        const u = stmt<{ phone: string | null; venmo: string | null; cash_app: string | null }, [string]>(
          "SELECT phone, venmo, cash_app FROM users WHERE email = ?"
        ).get(email);
        const pairs: string[] = [], vals: (string | null)[] = [];
        if (m) {
          if (!u?.phone && m.phone) { pairs.push("phone = ?"); vals.push(m.phone); }
          if (!u?.venmo && m.venmo) { pairs.push("venmo = ?"); vals.push(m.venmo); }
          if (!u?.cash_app && m.cash_app) { pairs.push("cash_app = ?"); vals.push(m.cash_app); }
        }
        if (pairs.length)
          db.run(`UPDATE users SET ${pairs.join(", ")} WHERE email = ?`, [...vals, email]);
        return db.query<{ trip_token: string }, [string]>(
          "SELECT trip_token FROM claims WHERE session_token = ?",
        ).all(s.token);
      });
      if (linked instanceof Response) return linked;
      for (const { trip_token } of linked) notify.trip(trip_token);
      return json({ ok: true });
    }],

    [/^\/api\/auth\/signout$/, "POST", async (_req, _m, _body, s) => {
      db.run("UPDATE sessions SET user_sub = NULL WHERE token = ?", [s.token]);
      return json({ ok: true });
    }],

    [/^\/api\/my-trips$/, "GET", async (_req, _m, _body, s) => {
      if (!s.user_sub) return json({ trips: [] });
      return json({
        trips: db.query(
          `SELECT t.token, t.name, t.trip_currency, t.settle_currency FROM trips t
           JOIN members m ON m.trip_token = t.token WHERE m.user_sub = ?`,
        ).all(s.user_sub),
      });
    }],
  ];
}
