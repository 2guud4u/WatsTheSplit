// Expense routes: CRUD, paid toggle, participants, shares, split.

import { resolveTrip } from "../access.ts"
import { decimals, isCurrency } from "../currencies.ts"
import { db } from "../db.ts"
import { effectiveShares, expensePayload, loadTripRows } from "../ledger.ts"
import { abort, edited, lockRate, logChange, logField, mutateTrip } from "../mutate.ts"
import type { Route, RouteCtx } from "../routes.ts"
import type { Member } from "../types.ts"

export function routes(ctx: RouteCtx): Route[] {
  const { json, err, now, qMember, qExpense } = ctx
  return [
    [
      /^\/api\/trips\/([A-Za-z0-9]+)\/expenses$/,
      "POST",
      async (_req, m, body, s) => {
        const g = resolveTrip(s, { trip: m[1] ?? "" }, "edit")
        if (g instanceof Response) return g
        const { trip: t, me } = g
        const name = String(body.name ?? "").trim()
        if (!name) return err(400, "name_required")
        const currency = String(body.currency ?? t.trip_currency).toUpperCase()
        if (!isCurrency(currency)) return err(400, "bad_currency")
        const totalMinor = Number(body.total_minor)
        if (!Number.isFinite(totalMinor) || totalMinor < 0) return err(400, "bad_total")
        const payer = body.payer_member_id ? qMember.get(String(body.payer_member_id)) : null
        if (body.payer_member_id && (!payer || payer.trip_token !== t.token)) return err(400, "bad_payer")
        const id = crypto.randomUUID()
        return mutateTrip(t.token, () => {
          db.run(
            `INSERT INTO expenses (id, trip_token, name, currency, total_minor, payer_member_id,
            rate, rate_provider, rate_timestamp, recorded_at, last_edited_by, last_edited_at, created_at,
            created_by_member_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              id,
              t.token,
              name,
              currency,
              totalMinor,
              payer?.id ?? null,
              null,
              null,
              null,
              now(),
              me?.name ?? null,
              now(),
              now(),
              me?.id ?? null,
            ]
          )
          // everyone is in by default with NULL share = equal split of the total
          for (const mm of db
            .query<{ id: string }, [string]>("SELECT id FROM members WHERE trip_token = ?")
            .all(t.token)) {
            db.run("INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)", [
              id,
              mm.id,
            ])
          }
          lockRate(id, currency, t.settle_currency)
          logChange(t.token, { type: "expense", id, name }, "created", null, null, null, me?.name ?? null)
          return json({ id })
        })
      },
    ],
    [
      /^\/api\/expenses\/([A-Za-z0-9-]+)$/,
      "GET",
      async (_req, m, _body, s) => {
        const e = qExpense.get(m[1] ?? "")
        if (!e) return err(404, "expense_not_found")
        const o = resolveTrip(s, { expense: e.id }, "view")
        if (o instanceof Response) return o
        const t = o.trip
        const members = db
          .query<Member, [string]>("SELECT * FROM members WHERE trip_token = ? ORDER BY name")
          .all(t.token)
        return json({
          expense: expensePayload(loadTripRows(t), e, true),
          trip: { token: t.token, name: t.name, settle_currency: t.settle_currency },
          access: o.edit ? "edit" : "view",
          members: members.map((mm) => ({ id: mm.id, name: mm.name })),
          me: o.me?.id ?? null,
        })
      },
    ],
    [
      /^\/api\/expenses\/([A-Za-z0-9-]+)$/,
      "PATCH",
      async (_req, m, body, s) => {
        const e = qExpense.get(m[1] ?? "")
        if (!e) return err(404, "expense_not_found")
        const g = resolveTrip(s, { expense: e.id }, "edit")
        if (g instanceof Response) return g
        const { trip: t, me } = g
        const before = {
          name: { kind: "text" as const, text: e.name },
          total_minor: { kind: "amount" as const, amount_minor: e.total_minor, currency: e.currency },
          payer_member_id: e.payer_member_id
            ? {
                kind: "member" as const,
                member_id: e.payer_member_id,
                member_name: qMember.get(e.payer_member_id)?.name ?? "",
              }
            : { kind: "none" as const },
          category: { kind: "text" as const, text: e.category ?? "" },
          currency: { kind: "text" as const, text: e.currency },
          paid_out: {
            kind: "boolean" as const,
            value:
              (db
                .query<{ paid: number }, [string]>(
                  "SELECT paid FROM expense_participants WHERE expense_id = ? AND paid = 1 LIMIT 1"
                )
                .get(e.id)?.paid ?? 0) > 0,
          },
        }
        return mutateTrip(t.token, () => {
          const entity = { type: "expense" as const, id: e.id, name: e.name }
          if (body.name !== undefined) db.run("UPDATE expenses SET name = ? WHERE id = ?", [String(body.name), e.id])
          if (body.total_minor !== undefined) {
            const v = Number(body.total_minor)
            if (!Number.isFinite(v) || v < 0) abort(err(400, "bad_total"))
            db.run("UPDATE expenses SET total_minor = ? WHERE id = ?", [v, e.id])
          }
          if (body.payer_member_id !== undefined) {
            const p = body.payer_member_id ? qMember.get(String(body.payer_member_id)) : null
            if (body.payer_member_id && (!p || p.trip_token !== t.token)) abort(err(400, "bad_payer"))
            db.run("UPDATE expenses SET payer_member_id = ? WHERE id = ?", [p?.id ?? null, e.id])
          }
          if (body.category !== undefined) {
            const c = body.category === null || body.category === "" ? null : String(body.category).trim()
            db.run("UPDATE expenses SET category = ? WHERE id = ?", [c, e.id])
          }
          if (body.paid_out !== undefined) {
            // only the member acting as the payer can mark an expense all-paid;
            // implemented as marking every participant's share paid
            if (me?.id !== e.payer_member_id) abort(err(403, "payer_only"))
            db.run("UPDATE expense_participants SET paid = ? WHERE expense_id = ?", [body.paid_out ? 1 : 0, e.id])
          }
          if (body.currency !== undefined) {
            const c = String(body.currency).toUpperCase()
            if (!isCurrency(c)) abort(err(400, "bad_currency"))
            if (c !== e.currency) {
              // the typed number stays the same, but minor units can differ:
              // re-scale total + typed shares + items when decimal places differ
              const factor = 10 ** (decimals(c) - decimals(e.currency))
              if (factor !== 1) {
                db.run("UPDATE expenses SET total_minor = ROUND(total_minor * ?) WHERE id = ?", [factor, e.id])
                db.run(
                  "UPDATE expense_participants SET share_minor = ROUND(share_minor * ?) WHERE expense_id = ? AND share_minor IS NOT NULL",
                  [factor, e.id]
                )
                db.run("UPDATE items SET price_minor = ROUND(price_minor * ?) WHERE expense_id = ?", [factor, e.id])
              }
              lockRate(e.id, c, t.settle_currency) // re-lock rate for the new currency
            }
          }
          const after = db
            .query<
              {
                name: string
                total_minor: number
                payer_member_id: string | null
                category: string | null
                currency: string
              },
              [string]
            >("SELECT name, total_minor, payer_member_id, category, currency FROM expenses WHERE id = ?")
            .get(e.id)!
          const afterSnap = {
            name: { kind: "text" as const, text: after.name },
            total_minor: { kind: "amount" as const, amount_minor: after.total_minor, currency: after.currency },
            payer_member_id: after.payer_member_id
              ? {
                  kind: "member" as const,
                  member_id: after.payer_member_id,
                  member_name: qMember.get(after.payer_member_id)?.name ?? "",
                }
              : { kind: "none" as const },
            category: { kind: "text" as const, text: after.category ?? "" },
            currency: { kind: "text" as const, text: after.currency },
          }
          for (const field of ["name", "total_minor", "payer_member_id", "category", "currency"] as const)
            logField(t.token, entity, before, afterSnap, field, me?.name ?? null)
          if (body.paid_out !== undefined) {
            const afterPaid =
              (db
                .query<{ paid: number }, [string]>(
                  "SELECT paid FROM expense_participants WHERE expense_id = ? AND paid = 1 LIMIT 1"
                )
                .get(e.id)?.paid ?? 0) > 0
            logField(
              t.token,
              entity,
              { paid_out: before.paid_out },
              { paid_out: { kind: "boolean" as const, value: afterPaid } },
              "paid_out",
              me?.name ?? null
            )
          }
          edited(e, me?.name ?? null)
          return json({ ok: true })
        })
      },
    ],
    [
      /^\/api\/expenses\/([A-Za-z0-9-]+)$/,
      "DELETE",
      async (_req, m, _body, s) => {
        const o = resolveTrip(s, { expense: m[1] ?? "" }, "edit")
        if (o instanceof Response) return o
        const e = qExpense.get(m[1] ?? "")!
        return mutateTrip(o.trip.token, () => {
          db.run("DELETE FROM expenses WHERE id = ?", [e.id])
          logChange(
            o.trip.token,
            { type: "expense", id: e.id, name: e.name },
            "deleted",
            null,
            null,
            null,
            o.me?.name ?? null
          )
          return json({ ok: true })
        })
      },
    ],
    // Per-person paid toggle: the payer or the person themself.
    [
      /^\/api\/expenses\/([A-Za-z0-9-]+)\/paid$/,
      "PUT",
      async (_req, m, body, s) => {
        const e = qExpense.get(m[1] ?? "")
        if (!e) return err(404, "expense_not_found")
        const g = resolveTrip(s, { expense: e.id }, "edit")
        if (g instanceof Response) return g
        const { trip: t, me } = g
        const mid = String(body.member_id ?? "")
        const mem = qMember.get(mid)
        if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found")
        if (me?.id !== e.payer_member_id && me?.id !== mid) return err(403, "payer_or_self_only")
        const before =
          db
            .query<{ paid: number }, [string, string]>(
              "SELECT paid FROM expense_participants WHERE expense_id = ? AND member_id = ?"
            )
            .get(e.id, mid)?.paid ?? 0
        return mutateTrip(t.token, () => {
          db.run(
            "INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor, paid) VALUES (?,?,NULL,0)",
            [e.id, mid]
          )
          db.run("UPDATE expense_participants SET paid = ? WHERE expense_id = ? AND member_id = ?", [
            body.paid ? 1 : 0,
            e.id,
            mid,
          ])
          const after =
            db
              .query<{ paid: number }, [string, string]>(
                "SELECT paid FROM expense_participants WHERE expense_id = ? AND member_id = ?"
              )
              .get(e.id, mid)?.paid ?? 0
          const entity = { type: "expense" as const, id: e.id, name: e.name }
          logChange(
            t.token,
            entity,
            "changed",
            "paid",
            {
              kind: "member_flag",
              member_id: mid,
              member_name: mem.name,
              flag: before > 0,
              on_label: "paid",
              off_label: "unpaid",
            },
            {
              kind: "member_flag",
              member_id: mid,
              member_name: mem.name,
              flag: after > 0,
              on_label: "paid",
              off_label: "unpaid",
            },
            me?.name ?? null
          )
          return json({ ok: true })
        })
      },
    ],
    [
      /^\/api\/expenses\/([A-Za-z0-9-]+)\/participants$/,
      "PUT",
      async (_req, m, body, s) => {
        const e = qExpense.get(m[1] ?? "")
        if (!e) return err(404, "expense_not_found")
        const g = resolveTrip(s, { expense: e.id }, "edit")
        if (g instanceof Response) return g
        const { trip: t, me } = g
        const memberId = String(body.member_id ?? "")
        const on = !!body.on
        const mem = qMember.get(memberId)
        if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found")
        return mutateTrip(t.token, () => {
          if (on) {
            db.run(
              "INSERT OR IGNORE INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,NULL)",
              [e.id, memberId]
            )
          } else {
            db.run("DELETE FROM expense_participants WHERE expense_id = ? AND member_id = ?", [e.id, memberId])
            db.run(
              `DELETE FROM item_sharers WHERE member_id = ? AND item_id IN
            (SELECT id FROM items WHERE expense_id = ?)`,
              [memberId, e.id]
            )
          }
          const entity = { type: "expense" as const, id: e.id, name: e.name }
          logChange(
            t.token,
            entity,
            "changed",
            "participants",
            {
              kind: "member_flag",
              member_id: memberId,
              member_name: mem.name,
              flag: !on,
              on_label: "in",
              off_label: "out",
            },
            {
              kind: "member_flag",
              member_id: memberId,
              member_name: mem.name,
              flag: on,
              on_label: "in",
              off_label: "out",
            },
            me?.name ?? null
          )
          edited(e, me?.name ?? null)
          return json({ ok: true })
        })
      },
    ],
    [
      /^\/api\/expenses\/([A-Za-z0-9-]+)\/shares$/,
      "PUT",
      async (_req, m, body, s) => {
        const e = qExpense.get(m[1] ?? "")
        if (!e) return err(404, "expense_not_found")
        const g = resolveTrip(s, { expense: e.id }, "edit")
        if (g instanceof Response) return g
        const { trip: t, me } = g
        const memberId = String(body.member_id ?? "")
        const value = body.share_minor === null ? null : Number(body.share_minor)
        const mem = qMember.get(memberId)
        if (!mem || mem.trip_token !== t.token) return err(404, "member_not_found")
        const before =
          db
            .query<{ share_minor: number | null }, [string, string]>(
              "SELECT share_minor FROM expense_participants WHERE expense_id = ? AND member_id = ?"
            )
            .get(e.id, memberId)?.share_minor ?? null
        return mutateTrip(t.token, () => {
          db.run(
            `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,?)
           ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = excluded.share_minor`,
            [e.id, memberId, value]
          )
          const after =
            db
              .query<{ share_minor: number | null }, [string, string]>(
                "SELECT share_minor FROM expense_participants WHERE expense_id = ? AND member_id = ?"
              )
              .get(e.id, memberId)?.share_minor ?? null
          const entity = { type: "expense" as const, id: e.id, name: e.name }
          logChange(
            t.token,
            entity,
            "changed",
            "share",
            { kind: "share", member_id: memberId, member_name: mem.name, amount_minor: before, currency: e.currency },
            { kind: "share", member_id: memberId, member_name: mem.name, amount_minor: after, currency: e.currency },
            me?.name ?? null
          )
          edited(e, me?.name ?? null)
          return json({ ok: true })
        })
      },
    ],
    [
      /^\/api\/expenses\/([A-Za-z0-9-]+)\/split$/,
      "POST",
      async (_req, m, body, s) => {
        const e = qExpense.get(m[1] ?? "")
        if (!e) return err(404, "expense_not_found")
        const g = resolveTrip(s, { expense: e.id }, "edit")
        if (g instanceof Response) return g
        const { trip: t, me } = g
        const type = String(body.type)
        const eff = effectiveShares(loadTripRows(t), e)
        const assignedEff = eff.reduce((a, s) => a + (s.minor ?? 0), 0)
        const rest = e.total_minor - assignedEff
        return mutateTrip(t.token, () => {
          if (type === "equal_rest") {
            // distribute the unassigned remainder equally across all participants,
            // freezing typed/item shares (so remainder participants no longer absorb it)
            const memberIds = Array.isArray(body.member_ids) ? body.member_ids.map(String) : null
            const target = memberIds?.length
              ? eff.filter((p) => memberIds.includes(p.member_id) && (p.minor ?? 0) > 0)
              : eff.filter((p) => (p.minor ?? 0) > 0)
            const n = target.length
            if (!n || rest <= 0) return json({ ok: true })
            const each = Math.floor(rest / n)
            let leftover = rest - each * n
            const stmt = db.prepare(
              `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,0)
             ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = expense_participants.share_minor + ?`
            )
            for (const p of target) {
              const add = leftover > 0 ? 1 : 0
              stmt.run(e.id, p.member_id, (p.minor ?? 0) + each + add)
              leftover -= add
            }
          } else if (type === "proportional") {
            // spread unassigned proportionally to current effective shares (typed + items)
            const total = eff.reduce((a, s) => a + (s.minor ?? 0), 0)
            if (rest <= 0 || total <= 0) return json({ ok: true })
            let allocated = 0
            const withShare = eff.filter((p) => (p.minor ?? 0) > 0)
            const upd = db.prepare(
              `INSERT INTO expense_participants (expense_id, member_id, share_minor) VALUES (?,?,0)
             ON CONFLICT(expense_id, member_id) DO UPDATE SET share_minor = expense_participants.share_minor + ?`
            )
            withShare.forEach((p, i) => {
              const add = i === withShare.length - 1 ? rest - allocated : Math.floor(((p.minor ?? 0) / total) * rest)
              allocated += add
              upd.run(e.id, p.member_id, add)
            })
          } else return err(400, "bad_split_type")
          const entity = { type: "expense" as const, id: e.id, name: e.name }
          logChange(t.token, entity, "changed", "split", null, { kind: "split", type }, me?.name ?? null)
          edited(e, me?.name ?? null)
          return json({ ok: true })
        })
      },
    ],
  ]
}
