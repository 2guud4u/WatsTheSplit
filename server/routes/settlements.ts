// Settlement routes: create + delete.
import { db } from "../db.ts";
import { mutateTrip, logChange } from "../mutate.ts";
import { resolveTrip } from "../access.ts";
import type { Route, RouteCtx } from "../routes.ts";

export function routes(ctx: RouteCtx): Route[] {
  const { json, err, now, qMember } = ctx;
  return [
    [/^\/api\/trips\/([A-Za-z0-9]+)\/settlements$/, "POST", async (_req, m, body, s) => {
      const g = resolveTrip(s, { trip: m[1] }, "edit");
      if (g instanceof Response) return g;
      const { trip: t, me } = g;
      const from = qMember.get(String(body.from_member ?? ""));
      const to = qMember.get(String(body.to_member ?? ""));
      if (!from || !to || from.trip_token !== t.token || to.trip_token !== t.token || from.id === to.id)
        return err(400, "bad_members");
      const amount = Number(body.amount_minor);
      if (!Number.isFinite(amount) || amount <= 0) return err(400, "bad_amount");
      const id = crypto.randomUUID();
      const sName = `${from.name} paid ${to.name}`;
      return mutateTrip(t.token, () => {
        db.run("INSERT INTO settlements (id, trip_token, from_member, to_member, amount_minor, created_at, created_by) VALUES (?,?,?,?,?,?,?)",
          [id, t.token, from.id, to.id, amount, now(), me?.name ?? null]);
        logChange(t.token, { type: "settlement", id, name: sName }, "created", null, null, null, me?.name ?? null);
        return json({ id });
      });
    }],
    [/^\/api\/settlements\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
      const o = resolveTrip(s, { settlement: m[1] }, "edit");
      if (o instanceof Response) return o;
      const st = db.query<{ id: string; from_member: string; to_member: string }, [string]>("SELECT id, from_member, to_member FROM settlements WHERE id = ?").get(m[1])!;
      const from = qMember.get(st.from_member);
      const to = qMember.get(st.to_member);
      const sName = `${from?.name ?? "?"} paid ${to?.name ?? "?"}`;
      return mutateTrip(o.trip.token, () => {
        db.run("DELETE FROM settlements WHERE id = ?", [m[1]]);
        logChange(o.trip.token, { type: "settlement", id: st.id, name: sName }, "deleted", null, null, null, o.me?.name ?? null);
        return json({ ok: true });
      });
    }],
  ];
}
