// Trip routes: trip CRUD, history, password, settings, detail-view, and the SSE
// events stream. (The claim / member / member-suggestion routes live in their
// own modules.)
import { db, stmt } from "../db.ts";
import { isCurrency } from "../currencies.ts";
import { crossRate, latestProviderTimestamp } from "../fx.ts";
import { effectiveShares, expensePayload, tripBalances, loadTripRows } from "../ledger.ts";
import * as notify from "../notify.ts";
import { mutate, mutateTrip, abort } from "../mutate.ts";
import { funBoard } from "../wrapped.ts";
import { resolveTrip, grantConsent, revokeConsents } from "../access.ts";
import type { HistoryValue } from "../../shared/wire.ts";
import type { Route, RouteCtx } from "../routes.ts";

export function routes(ctx: RouteCtx): Route[] {
  const { json, err, now, baseUrl, qTrip, qMember, paymentOfMember, memberIsUsed } = ctx;
  return [
    [/^\/api\/trips$/, "POST", async (_req, _m, body, s) => {
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
      const pwHash = await Bun.password.hash(pw);
      return mutate(() => {
        db.run(
          `INSERT INTO trips (token, name, start_date, end_date, trip_currency, settle_currency,
             password_hash, password_text, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [token, name, body.start_date ? String(body.start_date) : null, body.end_date ? String(body.end_date) : null,
           tc, sc, pwHash, pw, now()],
        );
        db.run("UPDATE trips SET created_by_token = ? WHERE token = ?", [s.token, token]);
        // creator's session counts as having entered the password
        grantConsent(s, qTrip.get(token)!);
        for (const n of names) {
          db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
            [crypto.randomUUID(), token, n, now()]);
        }
        return json({ token, url: `${baseUrl}/#/t/${token}` });
      });
    }],

    [/^\/api\/trips\/([A-Za-z0-9]+)$/, "GET", async (_req, m, _body, s) => {
      const o = resolveTrip(s, { trip: m[1] }, "view");
      if (o instanceof Response) return o;
      const t = o.trip;
      const me = o.me;
      const rows = loadTripRows(t);
      const { members, pairs, log } = tripBalances(rows);
      return json({
        trip: {
          token: t.token, name: t.name, start_date: t.start_date, end_date: t.end_date,
          created_at: t.created_at,
          trip_currency: t.trip_currency, settle_currency: t.settle_currency,
          has_password: !!t.password_hash, password: o.edit ? t.password_text : null, fun_leaderboard: !!t.fun_leaderboard,
        },
        me: me ? { id: me.id, name: me.name, linked: !!me.user_sub, opted_out_fun: !!me.opted_out_fun, payment: paymentOfMember(me) } : null,
        access: o.edit ? "edit" : "view",
        signed_in: !!s.user_sub,
        is_creator: t.created_by_token !== null && t.created_by_token === s.token,
        creator_id: t.created_by_member_id,
        members: members.map((mm) => ({
          id: mm.id, name: mm.name, linked: !!mm.user_sub,
          used: memberIsUsed(t.token, mm.id), opted_out_fun: !!mm.opted_out_fun,
          is_me: me?.id === mm.id,
          payment: paymentOfMember(mm),
        })),
        balances: pairs,
        journey: (() => {
          const r = db.query<{ journey_token: string; name: string }, [string]>(
            "SELECT jt.journey_token, j.name FROM journey_trips jt JOIN journeys j ON j.token = jt.journey_token WHERE jt.trip_token = ?",
          ).get(t.token);
          return r ? { token: r.journey_token, name: r.name } : null;
        })(),
        balance_log: log,
        no_rate_count: db.query<{ n: number }, [string]>(
          "SELECT COUNT(*) n FROM expenses WHERE trip_token = ? AND rate IS NULL",
        ).get(t.token)!.n,
        unfinished_count: rows.expenses.filter((e) => {
          const assigned = effectiveShares(rows, e).reduce((a, s) => a + (s.minor ?? 0), 0);
          return e.total_minor - assigned > 0.5;
        }).length,
        expenses: rows.expenses.map((e) => expensePayload(rows, e, false)),
        settlements: db.query<{ id: string; from_member: string; to_member: string; amount_minor: number; created_at: string; created_by: string | null }, [string]>(
          "SELECT * FROM settlements WHERE trip_token = ? ORDER BY created_at DESC",
        ).all(t.token),
        fx_timestamp: latestProviderTimestamp(),
        // current FX snapshot for the trip pair (display only; expenses keep their locked rate)
        current_rate: t.trip_currency === t.settle_currency
          ? { rate: 1, providerTimestamp: null }
          : crossRate(t.trip_currency, t.settle_currency),
        fun: t.fun_leaderboard ? funBoard(rows) : null,
      });
    }],

    [/^\/api\/trips\/([A-Za-z0-9]+)\/history$/, "GET", async (_req, m, _body, s) => {
      const o = resolveTrip(s, { trip: m[1] }, "view");
      if (o instanceof Response) return o;
      const rows = db.query<
        { id: string; entity_type: string; entity_id: string; entity_name: string; kind: string; field: string | null; old_value: string | null; new_value: string | null; by: string | null; created_at: string },
        [string]
      >(
        "SELECT * FROM expense_history WHERE trip_token = ? ORDER BY created_at DESC",
      ).all(m[1]);
      // Legacy rows (pre-structured) hold plain text; treat those as text values.
      const parse = (s: string | null): HistoryValue | null => {
        if (s === null) return null;
        try {
          const v = JSON.parse(s);
          if (v && typeof v === "object" && typeof v.kind === "string") return v as HistoryValue;
          return { kind: "text", text: s };
        } catch {
          return { kind: "text", text: s };
        }
      };
      return json({
        history: rows.map((r) => ({
          ...r,
          old_value: parse(r.old_value),
          new_value: parse(r.new_value),
        })),
      });
    }],

    [/^\/api\/trips\/([A-Za-z0-9]+)\/password$/, "POST", async (_req, m, body, s) => {
      const trip = qTrip.get(m[1]);
      if (!trip) return err(404, "trip_not_found");
      let ok = false;
      try { ok = await Bun.password.verify(String(body.password ?? ""), trip.password_hash ?? "$invalid$"); }
      catch { ok = false; }
      if (!ok) return err(403, "wrong_password");
      grantConsent(s, trip);
      return json({ ok: true });
    }],

    [/^\/api\/trips\/([A-Za-z0-9]+)\/settings$/, "PATCH", async (_req, m, body, s) => {
      const g = resolveTrip(s, { trip: m[1] }, "edit");
      if (g instanceof Response) return g;
      const t = g.trip;
      // hash outside the transaction: db.transaction is synchronous
      const pw = body.password !== undefined ? String(body.password) : null;
      if (pw !== null && pw === "") return err(400, "password_empty");
      const pwHash = pw !== null ? await Bun.password.hash(pw) : null;
      return mutateTrip(t.token, () => {
        if (body.name !== undefined) db.run("UPDATE trips SET name = ? WHERE token = ?", [String(body.name), t.token]);
        if (body.start_date !== undefined) db.run("UPDATE trips SET start_date = ? WHERE token = ?", [body.start_date === null ? null : String(body.start_date), t.token]);
        if (body.end_date !== undefined) db.run("UPDATE trips SET end_date = ? WHERE token = ?", [body.end_date === null ? null : String(body.end_date), t.token]);
        if (body.trip_currency !== undefined || body.settle_currency !== undefined) {
          abort(err(400, "currencies_locked")); // set at creation only
        }
        if (body.fun_leaderboard !== undefined) {
          if (t.created_by_token === null || t.created_by_token !== s.token) {
            abort(err(403, "only_creator"));
          }
          // Wrapped unlocks at end of the end date — enabling requires one.
          const end = body.end_date !== undefined ? body.end_date : t.end_date;
          if (body.fun_leaderboard && !end) abort(err(400, "end_date_required"));
          db.run("UPDATE trips SET fun_leaderboard = ? WHERE token = ?", [body.fun_leaderboard ? 1 : 0, t.token]);
        }
        if (pwHash !== null) {
          db.run("UPDATE trips SET password_hash = ?, password_text = ?, password_ver = password_ver + 1 WHERE token = ?",
            [pwHash, pw, t.token]);
          // revoke all existing consents, then re-grant the acting session at the new version
          revokeConsents(t);
          grantConsent(s, qTrip.get(t.token)!);
        }
        return json({ ok: true });
      });
    }],

    [/^\/api\/trips\/([A-Za-z0-9]+)$/, "DELETE", async (_req, m, body, s) => {
      const g = resolveTrip(s, { trip: m[1] }, "edit");
      if (g instanceof Response) return g;
      const t = g.trip;
      if (body.name !== t.name) return err(400, "name_mismatch");
      return mutateTrip(t.token, () => {
        db.run("DELETE FROM trips WHERE token = ?", [t.token]);
        return json({ ok: true });
      });
    }],

    // counts how often the acting member opens an owe-card details modal
    [/^\/api\/trips\/([A-Za-z0-9]+)\/detail-view$/, "POST", async (_req, m, _body, s) => {
      const o = resolveTrip(s, { trip: m[1] }, "edit");
      if (o instanceof Response) return o;
      if (o.me) return mutateTrip(o.trip.token, () => {
        db.run("UPDATE members SET detail_views = detail_views + 1 WHERE id = ?", [o.me!.id]);
        return json({ ok: true });
      });
      return json({ ok: true });
    }],

    // SSE: live updates for the trip. Viewers get live updates too — they can
    // read the trip, so they can watch it.
    [/^\/api\/trips\/([A-Za-z0-9]+)\/events$/, "GET", async (_req, m, _body, s) => {
      const o = resolveTrip(s, { trip: m[1] }, "view");
      if (o instanceof Response) return o;
      const token = o.trip.token;
      let ctrl!: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          c.enqueue(": connected\n\n");
          notify.addListener(token, c);
        },
        cancel() {
          notify.removeListener(token, ctrl);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }],
  ];
}
