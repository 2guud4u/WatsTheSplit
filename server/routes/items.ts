// Item routes: CRUD on itemized expenses.
import { db } from "../db.ts";
import { mutateTrip, logChange, edited } from "../mutate.ts";
import { resolveTrip } from "../access.ts";
import type { Route, RouteCtx } from "../routes.ts";

export function routes(ctx: RouteCtx): Route[] {
  const { json, err, qMember, qExpense, qItem } = ctx;
  return [
    [/^\/api\/expenses\/([A-Za-z0-9-]+)\/items$/, "POST", async (_req, m, body, s) => {
      const e = qExpense.get(m[1] ?? "");
      if (!e) return err(404, "expense_not_found");
      const g = resolveTrip(s, { expense: e.id }, "edit");
      if (g instanceof Response) return g;
      const { trip: t, me } = g;
      const name = String(body.name ?? "").trim() || "Item";
      const price = Number(body.price_minor ?? 0);
      const sharers: string[] = Array.isArray(body.sharers) ? body.sharers.map(String) : [];
      for (const mid of sharers) {
        const mm = qMember.get(mid);
        if (!mm || mm.trip_token !== t.token) return err(404, "member_not_found");
      }
      const itemId = crypto.randomUUID();
      return mutateTrip(t.token, () => {
        db.run("INSERT INTO items (id, expense_id, name, price_minor) VALUES (?,?,?,?)",
          [itemId, e.id, name, price]);
        for (const mid of sharers) {
          db.run("INSERT OR IGNORE INTO item_sharers (item_id, member_id) VALUES (?,?)", [itemId, mid]);
          db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, mid]);
        }
        const entity = { type: "expense" as const, id: e.id, name: e.name };
        logChange(t.token, entity, "changed", "items", null, { kind: "text", text: `item ${name}` }, me?.name ?? null);
        edited(e, me?.name ?? null);
        return json({ id: itemId });
      });
    }],
    [/^\/api\/items\/([A-Za-z0-9-]+)$/, "PATCH", async (_req, m, body, s) => {
      const o = resolveTrip(s, { item: m[1] ?? "" }, "edit");
      if (o instanceof Response) return o;
      const item = qItem.get(m[1] ?? "")!;
      const e = qExpense.get(item.expense_id)!;
      if (Array.isArray(body.sharers)) {
        for (const mid of body.sharers.map(String)) {
          const mm = qMember.get(mid);
          if (!mm || mm.trip_token !== o.trip.token) return err(404, "member_not_found");
        }
      }
      return mutateTrip(o.trip.token, () => {
        if (body.name !== undefined) db.run("UPDATE items SET name = ? WHERE id = ?", [String(body.name), item.id]);
        if (body.price_minor !== undefined) db.run("UPDATE items SET price_minor = ? WHERE id = ?", [Number(body.price_minor), item.id]);
        if (Array.isArray(body.sharers)) {
          db.run("DELETE FROM item_sharers WHERE item_id = ?", [item.id]);
          for (const mid of body.sharers.map(String)) {
            db.run("INSERT OR IGNORE INTO item_sharers (item_id, member_id) VALUES (?,?)", [item.id, mid]);
            db.run("INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [e.id, mid]);
          }
        }
        const entity = { type: "expense" as const, id: e.id, name: e.name };
        logChange(o.trip.token, entity, "changed", "items", { kind: "text", text: "edited" }, { kind: "text", text: `item ${item.name}` }, o.me?.name ?? null);
        edited(e, o.me?.name ?? null);
        return json({ ok: true });
      });
    }],
    [/^\/api\/items\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
      const o = resolveTrip(s, { item: m[1] ?? "" }, "edit");
      if (o instanceof Response) return o;
      const item = qItem.get(m[1] ?? "")!;
      const e = qExpense.get(item.expense_id)!;
      return mutateTrip(o.trip.token, () => {
        db.run("DELETE FROM items WHERE id = ?", [m[1] ?? ""]);
        const entity = { type: "expense" as const, id: e.id, name: e.name };
        logChange(o.trip.token, entity, "changed", "items", null, { kind: "text", text: `item ${item.name}` }, o.me?.name ?? null);
        return json({ ok: true });
      });
    }],
  ];
}
