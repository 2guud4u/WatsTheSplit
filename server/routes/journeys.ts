// Journey routes: accessible-trips, member-suggestions, CRUD, join, merge,
// settings, and the live trip access.
import { db, stmt } from "../db.ts";
import { mutate, mutateJourney, abort } from "../mutate.ts";
import { resolveJourney, journeyAccess, grantJourneyAccess, accessibleTrips, hasAccess } from "../access.ts";
import { loadJourneyRows, journeyBalance, journeyTrips, journeyPeople, expensePayload, type JourneyMember } from "../ledger.ts";
import { journeyBoard } from "../wrapped.ts";
import * as notify from "../notify.ts";
import type { Trip, Journey } from "../types.ts";
import type { Route, RouteCtx } from "../routes.ts";

export function routes(ctx: RouteCtx): Route[] {
  const { json, err, now, qTrip, qJourney, paymentOfMember, memberIsUsed } = ctx;
  return [
    [/^\/api\/accessible-trips$/, "GET", async (_req, _m, _body, s) => {
      const jOf = stmt<{ journey_token: string; name: string }, [string]>(
        "SELECT jt.journey_token, j.name FROM journey_trips jt JOIN journeys j ON j.token = jt.journey_token WHERE jt.trip_token = ?");
      return json({
        trips: accessibleTrips(s).map((t) => {
          const j = jOf.get(t.token);
          return { token: t.token, name: t.name, settle_currency: t.settle_currency, journey: j ? { token: j.journey_token, name: j.name } : null };
        }),
      });
    }],
    // distinct member names across this session's accessible trips, most-used first
    [/^\/api\/member-suggestions$/, "GET", async (_req, _m, _body, s) => {
      const trips = accessibleTrips(s);
      if (!trips.length) return json({ suggestions: [] });
      const q = stmt<{ name: string; n: number }, [string]>(
        "SELECT name, COUNT(*) n FROM members WHERE trip_token = ? GROUP BY name COLLATE NOCASE");
      const counts = new Map<string, { name: string; n: number }>();
      for (const t of trips)
        for (const r of q.all(t.token)) {
          const k = r.name.toLowerCase();
          const cur = counts.get(k) ?? { name: r.name, n: 0 };
          cur.n += r.n;
          counts.set(k, cur);
        }
      return json({
        suggestions: [...counts.values()].sort((a, b) => b.n - a.n).map((x) => x.name),
      });
    }],
    [/^\/api\/journeys$/, "POST", async (_req, _m, body, s) => {
      const name = String(body.name ?? "").trim();
      const wanted = Array.isArray(body.trip_tokens) ? body.trip_tokens.map(String) : [];
      const allowed = new Map(accessibleTrips(s).map((t) => [t.token, t]));
      const picked = [...new Set(wanted)].map((t) => allowed.get(t)).filter((t): t is Trip => !!t);
      if (!picked.length) return err(400, "no_trips");
      // A Journey has no currency of its own: every trip must settle in the same one.
      const sc = picked[0]?.settle_currency ?? "";
      if (picked.some((t) => t.settle_currency !== sc)) return err(400, "settle_currency_mismatch");
      const tokens = picked.map((t) => t.token);
      const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      return mutate(() => {
        db.run("INSERT INTO journeys (token, name, settle_currency, created_at) VALUES (?,?,?,?)",
          [token, name, sc, now()]);
        for (const tt of tokens)
          db.run("INSERT OR IGNORE INTO journey_trips (journey_token, trip_token) VALUES (?,?)", [token, tt]);
        return json({ token });
      });
    }],
    [/^\/api\/journeys\/([A-Za-z0-9]+)$/, "GET", async (_req, m, _body, s) => {
      const gj = resolveJourney(s, m[1] ?? "");
      if (gj instanceof Response) return gj;
      const j = gj.j;
      const jr = loadJourneyRows(j);
      const trips = jr.trips;
      // merge hints: same name across different trips, not already one person
      const { persons, keyOf } = journeyPeople(jr);
      const hints: { name: string; member_ids: string[]; trips: string[] }[] = [];
      const allM = trips.flatMap((tr) => tr.members.map((mm) => ({ ...mm, trip_name: tr.trip.name })));
      const byName = new Map<string, JourneyMember[]>();
      for (const mm of allM) {
        const k = mm.name.toLowerCase();
        byName.set(k, [...(byName.get(k) ?? []), mm]);
      }
      for (const [, ms] of byName) {
        const keys = new Set(ms.map((mm) => keyOf(mm)));
        if (keys.size > 1)
          hints.push({ name: ms[0]?.name ?? "", member_ids: ms.map((mm) => mm.id), trips: [...new Set(ms.map((mm) => mm.trip_name!))] });
      }
      const { transfers } = journeyBalance(jr);
      // Trip Wrapped waits for trip end (or 5 days after creation with no end
      // date); the journey unlocks at the latest of all its trips' dates.
      const wrappedAt = trips.length
        ? new Date(Math.max(...trips.map((tr) => Date.parse(
            tr.trip.end_date ? `${tr.trip.end_date}T23:59:59` : new Date(Date.parse(tr.trip.created_at) + 5 * 86400e3).toISOString())))).toISOString()
        : null;
      return json({
        journey: { token: j.token, name: j.name, settle_currency: j.settle_currency, fun_leaderboard: !!j.fun_leaderboard },
        signed_in: !!s.user_sub,
        wrapped_at: wrappedAt,
        fun: j.fun_leaderboard ? journeyBoard(jr) : null,
        trips: trips.map((tr) => ({
          token: tr.trip.token, name: tr.trip.name, settle_currency: tr.trip.settle_currency,
          access: hasAccess(s, tr.trip) ? "edit" : "view",
          members: tr.members.map((mm) => ({ id: mm.id, name: mm.name, linked: !!mm.user_sub, used: memberIsUsed(tr.trip.token, mm.id), opted_out_fun: !!mm.opted_out_fun })),
          expenses: tr.expenses.map((e) => expensePayload(tr, e, false)),
        })),
        persons: [...persons.entries()].map(([k, p]) => ({ key: k, ...p })),
        members: allM.map((mm) => ({ id: mm.id, name: mm.name, trip_name: mm.trip_name, key: keyOf(mm), linked: !!mm.user_sub, opted_out_fun: !!mm.opted_out_fun, payment: paymentOfMember(mm) })),
        mergeHints: hints,
        // member ids belonging to this session, so the client can tell
        // "who owes you" from "who you owe" inside shared transfers
        my_member_ids: allM.filter((mm) => (s.user_sub && mm.user_sub === s.user_sub) ||
          !!db.query("SELECT 1 FROM claims WHERE session_token = ? AND member_id = ?")
            .get(s.token, mm.id)).map((mm) => mm.id),
        transfers,
        // trips this session could add; mismatched currencies listed but blocked
        mergeableTrips: accessibleTrips(s)
          .filter((t) => !db.query("SELECT 1 FROM journey_trips WHERE trip_token = ?").get(t.token))
          .map((t) => ({ token: t.token, name: t.name, settle_currency: t.settle_currency })),
      });
    }],
    // journeys this session can open: via a journey-link grant or a member trip
    [/^\/api\/my-journeys$/, "GET", async (_req, _m, _body, s) => {
      const granted = db.query<{ journey_token: string }, [string]>(
        "SELECT journey_token FROM journey_access WHERE session_token = ?",
      ).all(s.token).map((r) => r.journey_token);
      const viaTrips = db.query<{ journey_token: string }, [string, string | null]>(
        `SELECT DISTINCT jt.journey_token FROM journey_trips jt
       WHERE jt.trip_token IN (
         SELECT trip_token FROM consents WHERE session_token = ?
         UNION SELECT trip_token FROM members WHERE user_sub = ?)`,
      ).all(s.token, s.user_sub).map((r) => r.journey_token);
      // filter through journeyAccess: a consent at a stale password_ver must not list
      const journeys = [...new Set([...granted, ...viaTrips])]
        .map((t) => qJourney.get(t))
        .filter((j): j is Journey => !!j && journeyAccess(s, j))
        .map((j) => ({ token: j.token, name: j.name, settle_currency: j.settle_currency }));
      return json({ journeys });
    }],
    // journey link: opening it (POST join) grants read access to every member trip
    [/^\/api\/journeys\/([A-Za-z0-9]+)\/join$/, "POST", async (_req, m, _body, s) => {
      const j = qJourney.get(m[1] ?? "");
      if (!j) return err(404, "journey_not_found");
      grantJourneyAccess(s, j);
      notify.journey(j.token);
      return json({ ok: true });
    }],
    [/^\/api\/journeys\/([A-Za-z0-9]+)\/trips$/, "POST", async (_req, m, body, s) => {
      const g = resolveJourney(s, m[1] ?? "");
      if (g instanceof Response) return g;
      const { j } = g;
      const tt = String(body.trip_token ?? "");
      const t = qTrip.get(tt);
      if (!t) return err(404, "trip_not_found");
      if (!hasAccess(s, t)) return err(403, "no_trip_access");
      if (db.query("SELECT 1 FROM journey_trips WHERE trip_token = ?").get(tt))
        return err(409, "already_in_journey");
      if (t.settle_currency !== j.settle_currency) return err(400, "settle_currency_mismatch");
      return mutateJourney(j.token, () => {
        db.run("INSERT INTO journey_trips (journey_token, trip_token) VALUES (?,?)", [j.token, tt]);
        return json({ ok: true });
      });
    }],
    [/^\/api\/journeys\/([A-Za-z0-9]+)\/trips\/([A-Za-z0-9]+)$/, "DELETE", async (_req, m, _body, s) => {
      const g = resolveJourney(s, m[1] ?? "");
      if (g instanceof Response) return g;
      const { j } = g;
      const r = mutateJourney(j.token, () => {
        db.run("DELETE FROM journey_trips WHERE journey_token = ? AND trip_token = ?", [j.token, m[2] ?? ""]);
        db.run("DELETE FROM journey_merges WHERE journey_token = ? AND member_id IN (SELECT id FROM members WHERE trip_token = ?)", [j.token, m[2] ?? ""]);
        return json({ ok: true });
      });
      if (!(r instanceof Response) || r.status < 400) notify.trip(m[2] ?? "");
      return r;
    }],
    [/^\/api\/journeys\/([A-Za-z0-9]+)\/merge$/, "POST", async (_req, m, body, s) => {
      const g = resolveJourney(s, m[1] ?? "");
      if (g instanceof Response) return g;
      const { j } = g;
      const ids = (Array.isArray(body.member_ids) ? body.member_ids : []).map(String);
      const inJourney = new Set(journeyTrips(j).flatMap((t) =>
        db.query<{ id: string }, [string]>("SELECT id FROM members WHERE trip_token = ?").all(t.token).map((r) => r.id)));
      const valid = ids.filter((id) => inJourney.has(id));
      if (valid.length < 2) return err(400, "need_two_members");
      // merge into the group of the first already-grouped member, else new group
      const existing = stmt<{ group_id: string }, [string, string]>(
        "SELECT group_id FROM journey_merges WHERE journey_token = ? AND member_id = ? LIMIT 1");
      let gid: string | null = null;
      for (const id of valid) { const r = existing.get(j.token, id); if (r) { gid = r.group_id; break; } }
      gid ??= crypto.randomUUID();
      return mutateJourney(j.token, () => {
        for (const id of valid)
          db.run("INSERT OR REPLACE INTO journey_merges (journey_token, member_id, group_id) VALUES (?,?,?)", [j.token, id, gid]);
        return json({ ok: true, group_id: gid });
      });
    }],
    // journey settings: rename + Journey Wrapped toggle. Dissolving a journey
    // only removes the grouping — its trips are untouched.
    [/^\/api\/journeys\/([A-Za-z0-9]+)\/settings$/, "PATCH", async (_req, m, body, s) => {
      const g = resolveJourney(s, m[1] ?? "");
      if (g instanceof Response) return g;
      const { j } = g;
      const name = body.name !== undefined ? String(body.name ?? "").trim() : null;
      if (body.name !== undefined && !name) return err(400, "bad_name");
      return mutateJourney(j.token, () => {
        if (name !== null) db.run("UPDATE journeys SET name = ? WHERE token = ?", [name, j.token]);
        if (body.fun_leaderboard) {
          // Journey Wrapped unlocks at the last member trip's end — every trip
          // needs a date or there's no end to unlock at.
          const undated = db.query<{ name: string }, [string]>(
            `SELECT t.name FROM journey_trips jt JOIN trips t ON t.token = jt.trip_token
           WHERE jt.journey_token = ? AND t.end_date IS NULL`).all(j.token);
          if (undated.length) abort(err(400, "end_date_required"));
        }
        if (body.fun_leaderboard !== undefined)
          db.run("UPDATE journeys SET fun_leaderboard = ? WHERE token = ?", [body.fun_leaderboard ? 1 : 0, j.token]);
        return json({ ok: true });
      });
    }],
    [/^\/api\/journeys\/([A-Za-z0-9]+)$/, "DELETE", async (_req, m, body, s) => {
      const g = resolveJourney(s, m[1] ?? "");
      if (g instanceof Response) return g;
      const { j } = g;
      if (String(body.name ?? "") !== j.name) return err(400, "name_mismatch");
      const trips = journeyTrips(j);
      const r = mutateJourney(j.token, () => {
        db.run("DELETE FROM journey_merges WHERE journey_token = ?", [j.token]);
        db.run("DELETE FROM journey_access WHERE journey_token = ?", [j.token]);
        db.run("DELETE FROM journey_trips WHERE journey_token = ?", [j.token]);
        db.run("DELETE FROM journeys WHERE token = ?", [j.token]);
        return json({ ok: true });
      });
      // journey fan-out pings member trips already; the removed trips are gone
      // from journey_trips, so ping them explicitly too
      for (const t of trips) notify.trip(t.token);
      return r;
    }],
    [/^\/api\/journeys\/([A-Za-z0-9]+)\/merge\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
      const g = resolveJourney(s, m[1] ?? "");
      if (g instanceof Response) return g;
      const { j } = g;
      return mutateJourney(j.token, () => {
        db.run("DELETE FROM journey_merges WHERE journey_token = ? AND member_id = ?", [j.token, m[2] ?? ""]);
        return json({ ok: true });
      });
    }],
  ];
}
