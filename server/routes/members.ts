// Member routes: claim, add member, patch, delete.
import { db } from "../db.ts";
import { mutateTrip, abort } from "../mutate.ts";
import { resolveTrip, linkedMember, grantConsent } from "../access.ts";
import type { Member } from "../types.ts";
import type { Route, RouteCtx } from "../routes.ts";

export function routes(ctx: RouteCtx): Route[] {
  const { json, err, now, qMember, memberIsUsed, nameTaken } = ctx;
  return [
    [/^\/api\/trips\/([A-Za-z0-9]+)\/claim$/, "POST", async (_req, m, body, s) => {
      const o = resolveTrip(s, { trip: m[1] }, "view");
      if (o instanceof Response) return o;
      const t = o.trip;
      const memberId = String(body.member_id ?? "");
      const newName = String(body.name ?? "").trim();
      return mutateTrip(t.token, () => {
        let member: Member | null = null;
        if (memberId) {
          member = qMember.get(memberId);
          if (!member || member.trip_token !== t.token) return err(404, "member_not_found");
          if (member.user_sub && member.user_sub !== s.user_sub)
            abort(err(403, "member_linked"));
        } else if (newName) {
          if (nameTaken(t.token, newName)) return err(409, "name_taken");
          member = {
            id: crypto.randomUUID(), trip_token: t.token, name: newName,
            user_sub: s.user_sub,
          } as Member;
          db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,?,?)",
            [member.id, t.token, newName, s.user_sub, now()]);
        } else return err(400, "member_or_name_required");
        if (s.user_sub && member.user_sub && member.user_sub !== s.user_sub)
          abort(err(403, "member_linked"));
        // signed-in user claiming a different member: reselect moves the account
        // link — the old member unlinks, the new one links.
        if (s.user_sub) {
          const existing = linkedMember(s, t.token);
          if (existing && existing.id !== member.id)
            db.run("UPDATE members SET user_sub = NULL WHERE id = ?", [existing.id]);
          if (member.user_sub !== s.user_sub)
            db.run("UPDATE members SET user_sub = ? WHERE id = ?", [s.user_sub, member.id]);
        }
        db.run("INSERT OR REPLACE INTO claims (session_token, trip_token, member_id) VALUES (?,?,?)",
          [s.token, t.token, member.id]);
        // the creator's claim (or first re-claim after the creator is gone) fixes the owner's Member
        if (t.created_by_token === s.token && t.created_by_member_id !== member.id) {
          db.run("UPDATE trips SET created_by_member_id = ? WHERE token = ?", [member.id, t.token]);
        }
        // claiming grants edit access even for journey viewers (they never typed the password)
        grantConsent(s, t);
        return json({ ok: true, member_id: member.id });
      });
    }],
    [/^\/api\/trips\/([A-Za-z0-9]+)\/members$/, "POST", async (_req, m, body, s) => {
      const o = resolveTrip(s, { trip: m[1] }, "edit");
      if (o instanceof Response) return o;
      const name = String(body.name ?? "").trim();
      if (!name) return err(400, "name_required");
      if (nameTaken(o.trip.token, name)) return err(409, "name_taken");
      const id = crypto.randomUUID();
      return mutateTrip(o.trip.token, () => {
        db.run("INSERT INTO members (id, trip_token, name, user_sub, created_at) VALUES (?,?,?,NULL,?)",
          [id, o.trip.token, name, now()]);
        return json({ id });
      });
    }],
    [/^\/api\/members\/([A-Za-z0-9-]+)$/, "PATCH", async (_req, m, body, s) => {
      const mem = qMember.get(m[1]);
      if (!mem) return err(404, "member_not_found");
      const o = resolveTrip(s, { trip: mem.trip_token }, "edit");
      if (o instanceof Response) return o;
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return err(400, "name_required");
        if (nameTaken(mem.trip_token, name, mem.id)) return err(409, "name_taken");
      }
      if (body.opted_out_fun !== undefined) {
        const me = o.me;
        if (!me || me.id !== mem.id) return err(403, "not_your_member");
      }
      const p = body.payment as { phone?: unknown; venmo?: unknown; cash_app?: unknown } | undefined;
      if (p) {
        const me = o.me;
        if (!me || me.id !== mem.id) return err(403, "not_your_member");
      }
      return mutateTrip(mem.trip_token, () => {
        if (body.name !== undefined)
          db.run("UPDATE members SET name = ? WHERE id = ?", [String(body.name).trim(), mem.id]);
        if (body.opted_out_fun !== undefined)
          db.run("UPDATE members SET opted_out_fun = ? WHERE id = ?", [body.opted_out_fun ? 1 : 0, mem.id]);
        if (p) {
          const pairs: string[] = [], vals: (string | null)[] = [];
          for (const [col, v] of [["phone", p.phone], ["venmo", p.venmo], ["cash_app", p.cash_app]] as const) {
            if (v === undefined) continue;
            const val = v === null ? null : String(v).trim() || null;
            pairs.push(`${col} = ?`); vals.push(val);
          }
          if (pairs.length) {
            // Linked member: write to the account (shared across trips). Unlinked:
            // write to their own row (per trip).
            if (mem.user_sub) {
              db.run(`UPDATE users SET ${pairs.join(", ")} WHERE email = ?`, [...vals, mem.user_sub]);
            } else {
              db.run(`UPDATE members SET ${pairs.join(", ")} WHERE id = ?`, [...vals, mem.id]);
            }
          }
        }
        return json({ ok: true });
      });
    }],
    [/^\/api\/members\/([A-Za-z0-9-]+)$/, "DELETE", async (_req, m, _body, s) => {
      const o = resolveTrip(s, { member: m[1] }, "edit");
      if (o instanceof Response) return o;
      const mem = qMember.get(m[1])!;
      if (memberIsUsed(mem.trip_token, mem.id)) return err(400, "member_in_use");
      if (mem.id === o.me?.id) return err(400, "cannot_remove_self");
      return mutateTrip(mem.trip_token, () => {
        db.run("DELETE FROM claims WHERE member_id = ?", [mem.id]);
        db.run("DELETE FROM members WHERE id = ?", [mem.id]);
        return json({ ok: true });
      });
    }],
  ];
}
