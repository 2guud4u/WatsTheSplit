// Photo routes: upload + read + delete expense photos.
import { db } from "../db.ts";
import { mutateTrip, logChange, edited } from "../mutate.ts";
import { resolveTrip } from "../access.ts";
import type { Route, RouteCtx } from "../routes.ts";

export function routes(ctx: RouteCtx): Route[] {
  const { json, err, now, qExpense, qPhoto } = ctx;
  return [
    [/^\/api\/expenses\/([A-Za-z0-9-]+)\/photos$/, "POST", async (req, m, body, s) => {
      const e = qExpense.get(m[1] ?? "");
      if (!e) return err(404, "expense_not_found");
      const o = resolveTrip(s, { expense: e.id }, "edit");
      if (o instanceof Response) return o;
      const me = o.me;
      const mime = req.headers.get("content-type") ?? "application/octet-stream";
      if (!mime.startsWith("image/")) return err(400, "not_image");
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.byteLength === 0) return err(400, "empty");
      if (buf.byteLength > 10 * 1024 * 1024) return err(413, "too_large");
      const id = crypto.randomUUID();
      return mutateTrip(o.trip.token, () => {
        db.run("INSERT INTO expense_photos (id, expense_id, mime, data, created_at) VALUES (?,?,?,?,?)",
          [id, e.id, mime, buf, now()]);
        const entity = { type: "expense" as const, id: e.id, name: e.name };
        logChange(o.trip.token, entity, "changed", "photos", null, { kind: "text", text: "photo added" }, me?.name ?? null);
        edited(e, me?.name ?? null);
        return json({ id });
      });
    }],
    // Viewers can read photos: they already see the expense payload that lists them.
    [/^\/api\/photos\/([A-Za-z0-9-]+)$/, "GET", async (_req, m, _body, s) => {
      const p = qPhoto.get(m[1] ?? "");
      if (!p) return err(404, "photo_not_found");
      const o = resolveTrip(s, { expense: p.expense_id }, "view");
      if (o instanceof Response) return o;
      return new Response(Buffer.from(p.data), { headers: { "content-type": p.mime, "cache-control": "private, max-age=3600" } });
    }],
    [/^\/api\/photos\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
      const o = resolveTrip(s, { photo: m[1] ?? "" }, "edit");
      if (o instanceof Response) return o;
      const p = qPhoto.get(m[1] ?? "")!;
      const e = qExpense.get(p.expense_id)!;
      return mutateTrip(o.trip.token, () => {
        db.run("DELETE FROM expense_photos WHERE id = ?", [p.id]);
        const entity = { type: "expense" as const, id: e.id, name: e.name };
        logChange(o.trip.token, entity, "changed", "photos", null, { kind: "text", text: "photo removed" }, o.me?.name ?? null);
        edited(e, o.me?.name ?? null);
        return json({ ok: true });
      });
    }],
  ];
}
