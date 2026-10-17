import React, { useEffect, useState, useCallback } from "react";
import { api, BASE, toMinor, fmt, decimals, CATEGORIES, CURRENCY_COUNTRIES } from "./api.ts";
import { CurrencyPicker } from "./CurrencyPicker.tsx";
import { useTripEvents } from "./hooks.ts";

type Member = { id: string; name: string };
type Item = { id: string; name: string; price_minor: number; sharers: string[] };
type Expense = {
  id: string; name: string; currency: string; total_minor: number;
  payer_member_id: string | null; category: string | null;
  rate: number | null; rate_provider: string | null; rate_timestamp: string | null;
  recorded_at: string; last_edited_by: string | null; last_edited_at: string;
  assigned_minor: number; unassigned_minor: number; over: boolean; paid_out?: boolean;
  participants?: { member_id: string; share_minor: number | null; name: string; paid?: number }[];
  items?: Item[];
  effective_shares?: { member_id: string; minor: number | null }[];
  photos?: string[];
};
type Data = {
  expense: Expense;
  trip: { token: string; name: string; settle_currency: string };
  access: "edit" | "view";
  members: Member[];
  me: string | null;
};

const COLORS = ["#b56a4c","#7a9b6d","#c9a25e","#8f7fae","#b07575","#7d9aa8","#c9b458","#a08a6e"];
function Pie({ slices, total }: { slices: { label: string; value: number; i: number }[]; total: number }) {
  const R = 60, C = 70;
  let angle = -Math.PI / 2;
  const unassigned = Math.max(0, total - slices.reduce((a, s) => a + s.value, 0));
  const all = [...slices, { label: "Unassigned", value: unassigned, i: -1 }];
  const sum = all.reduce((a, s) => a + s.value, 0);
  if (sum <= 0) return null;
  return (
    <svg className="pie" viewBox="0 0 140 140" width="140" height="140">
      {all.map((s) => {
        const frac = s.value / sum;
        const a2 = angle + frac * Math.PI * 2;
        const large = frac > 0.5 ? 1 : 0;
        const x1 = C + R * Math.cos(angle), y1 = C + R * Math.sin(angle);
        const x2 = C + R * Math.cos(a2), y2 = C + R * Math.sin(a2);
        const fill = s.i === -1 ? "#d8d8dc" : COLORS[s.i % COLORS.length];
        const d = frac >= 0.9999
          ? `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R}`
          : `M ${C} ${C} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
        angle = a2;
        return <path key={s.label + s.i} d={d} fill={fill}><title>{s.label}</title></path>;
      })}
    </svg>
  );
}

function PieLegend({ slices, unassigned, currency, members }: {
  slices: { label: string; value: number; i: number }[];
  unassigned: number; currency: string;
  members: { id: string; name: string }[];
}) {
  return (
    <div className="pie-legend">
      {slices.map((s) => (
        <React.Fragment key={s.label + s.i}>
          <span><span className="swatch" style={{ background: COLORS[s.i % COLORS.length] }} />{s.label}</span>
          <span className="amt">{fmt(s.value, currency)}</span>
        </React.Fragment>
      ))}
      {unassigned > 0 && (
        <>
          <span><span className="swatch" style={{ background: "#d8d8dc" }} />Unassigned</span>
          <span className="amt warn">{fmt(unassigned, currency)}</span>
        </>
      )}
    </div>
  );
}

export default function ExpenseView({ token, expenseId }: { token: string; expenseId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [itemDraft, setItemDraft] = useState({ name: "", price: "", sharers: [] as string[] });

  const load = useCallback(async () => {
    try { setData(await api.get(`/api/expenses/${expenseId}`)); }
    catch { location.hash = `#/t/${token}`; }
  }, [expenseId, token]);

  useEffect(() => { load(); }, [load]);
  useTripEvents([token], load);

  if (!data) return <p className="muted">Loading…</p>;
  const e = data.expense;
  const t = data.trip;
  const dec = decimals(e.currency);
  const partIds = new Set((e.participants ?? []).map((p) => p.member_id));
  const readOnly = data.access === "view";
  const patch = (b: object) => api.patch(`/api/expenses/${e.id}`, b).then(load);
  const slices = (e.effective_shares ?? [])
    .filter((s) => (s.minor ?? 0) > 0)
    .map((s, i) => ({
      label: data.members.find((m) => m.id === s.member_id)?.name ?? "?",
      value: s.minor!, i,
    }));

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ marginBottom: 0 }}>{e.category && `${CATEGORIES[e.category] ?? ""} `}{e.name}</h1>
        <a href={`#/t/${token}`} className="muted">← {t.name}</a>
      </div>
      {e.last_edited_by && <p className="muted">last edited by {e.last_edited_by}</p>}
      {data.access === "view" && (
        <div className="card"><p className="muted">View only — <a href={`#/t/${token}`}>pick your name on the trip</a> to edit.</p></div>
      )}
      <div className="row" style={{ margin: "4px 0 12px" }}>
        {e.paid_out
          ? <span className="badge badge-done">✓ paid out — shares don't count toward balances</span>
          : null}
        {data.me && data.me === e.payer_member_id && (
          <button className="link" onClick={async () => {
            try { await patch({ paid_out: !e.paid_out }); }
            catch { /* payer_only shouldn't happen — button is gated */ }
          }}>{e.paid_out ? "Unmark" : "Mark all paid"}</button>
        )}
      </div>

      <fieldset className="plain-fieldset" disabled={readOnly}>
      <div className="card">
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label className="field-label">Name</label>
            <input className="wide" defaultValue={e.name} key={e.name}
              onBlur={(ev) => ev.target.value !== e.name && patch({ name: ev.target.value })} />
          </div>
        </div>
        <div className="row">
          <div className="field"><label className="field-label">Total</label>
            <MoneyField code={e.currency} minor={e.total_minor}
              onCommit={(v) => patch({ total_minor: v })} /></div>
          <div className="field"><label className="field-label">Currency</label>
            <CurrencyField value={e.currency} onCommit={(c) => patch({ currency: c })} /></div>
          <div className="field"><label className="field-label">Paid by</label>
            <select value={e.payer_member_id ?? ""} onChange={(ev) => patch({ payer_member_id: ev.target.value || null })}>
              <option value="">—</option>
              {data.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select></div>
          <div className="field"><label className="field-label">Category</label>
            <select value={e.category ?? ""} onChange={(ev) => patch({ category: ev.target.value || null })}>
              <option value="">—</option>
              {Object.entries(CATEGORIES).map(([c, emoji]) =>
                <option key={c} value={c}>{emoji} {c}</option>)}
            </select></div>
        </div>
        <p className="muted">
          Rate locked at creation: {e.currency === t.settle_currency ? `1 ${e.currency} = 1 ${t.settle_currency}` : e.rate ? `1 ${e.currency} = ${e.rate} ${t.settle_currency}` : "unavailable"}
          {e.rate_timestamp && ` · rate as of ${new Date(e.rate_timestamp).toLocaleString()}`}
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Who's in</h2>
        <div className="row">
          {data.members.map((m) => (
            <label key={m.id} className="member-chip" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={partIds.has(m.id)}
                onChange={async (ev) => {
                  await api.put(`/api/expenses/${e.id}/participants`, { member_id: m.id, on: ev.target.checked });
                  load();
                }} />
              {m.name}
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Split</h2>
          <div className="split-side">
            <Pie slices={slices} total={e.total_minor} />
            <PieLegend slices={slices} unassigned={Math.max(0, e.unassigned_minor)} currency={e.currency} members={data.members} />
          </div>
        </div>
        <p>
          Total {fmt(e.total_minor, e.currency)} · assigned {fmt(e.assigned_minor, e.currency)} ·{" "}
          {Math.abs(e.unassigned_minor) < 1
            ? <b style={{ color: "var(--success)" }}>fully assigned ✓</b>
            : e.over
            ? <b className="error">over by {fmt(-e.unassigned_minor, e.currency)}</b>
            : <b className="error">{fmt(e.unassigned_minor, e.currency)} unassigned</b>}
        </p>

        <h3 style={{ margin: "8px 0" }}>Amounts</h3>
        {(e.participants ?? []).map((p, i) => {
          const canToggle = data.me === e.payer_member_id || data.me === p.member_id;
          const isPayer = p.member_id === e.payer_member_id;
          return (
            <div key={p.member_id} className="item-row">
              <span style={{ flex: 1 }}>
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5,
                  background: COLORS[i % COLORS.length], marginRight: 6 }} />
                {p.name}
                {isPayer && <span className="pill"> (payer)</span>}
              </span>
              <input className="money" inputMode="decimal"
                defaultValue={p.share_minor === null ? "" : String(p.share_minor / 10 ** dec)}
                key={String(p.share_minor)}
                placeholder={p.share_minor === null
                  ? ((e.effective_shares?.find((s) => s.member_id === p.member_id)?.minor ?? 0) / 10 ** dec).toFixed(dec)
                  : "0"}
                onBlur={async (ev) => {
                  const v = ev.target.value;
                  await api.put(`/api/expenses/${e.id}/shares`, {
                    member_id: p.member_id,
                    share_minor: v === "" ? null : toMinor(v, e.currency),
                  });
                  load();
                }} />
              {!isPayer && (
                <button
                  className={`pill paid-chip${p.paid ? " on" : ""}`}
                  disabled={!canToggle}
                  title={canToggle ? (p.paid ? "mark unpaid" : "mark paid") : "only the payer or this person can toggle"}
                  onClick={async () => {
                    await api.put(`/api/expenses/${e.id}/paid`, { member_id: p.member_id, paid: !p.paid });
                    load();
                  }}>
                  {p.paid ? "✓ paid" : "paid"}
                </button>
              )}
            </div>
          );
        })}
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={async () => { await api.post(`/api/expenses/${e.id}/split`, { type: "equal_rest" }); load(); }}>
            Split unassigned equally
          </button>
          <button onClick={async () => { await api.post(`/api/expenses/${e.id}/split`, { type: "proportional" }); load(); }}>
            Spread unassigned proportionally
          </button>
        </div>

        <h3>Items</h3>
        {(e.items ?? []).map((it) => (
          <div key={it.id} className="item-row" style={{ alignItems: "flex-start" }}>
            <input className="wide" defaultValue={it.name} key={it.id + "n"}
              onBlur={async (ev) => ev.target.value !== it.name &&
                (await api.patch(`/api/items/${it.id}`, { name: ev.target.value }), load())} />
            <input className="money" inputMode="decimal" defaultValue={String(it.price_minor / 10 ** dec)} key={it.id + "p"}
              onBlur={async (ev) => {
                await api.patch(`/api/items/${it.id}`, { price_minor: toMinor(ev.target.value, e.currency) });
                load();
              }} />
            <span className="sharer-checks">
              {data.members.map((m) => (
                <label key={m.id} className="pill" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={it.sharers.includes(m.id)}
                    onChange={async (ev) => {
                      const sharers = ev.target.checked
                        ? [...it.sharers, m.id]
                        : it.sharers.filter((x) => x !== m.id);
                      await api.patch(`/api/items/${it.id}`, { sharers });
                      load();
                    }} /> {m.name}
                </label>
              ))}
            </span>
            <button className="link danger" onClick={async () => { await api.del(`/api/items/${it.id}`); load(); }}>✕</button>
          </div>
        ))}
        <div className="item-row">
          <input className="wide" placeholder="Item name" value={itemDraft.name}
            onChange={(ev) => setItemDraft({ ...itemDraft, name: ev.target.value })} />
          <input className="money" inputMode="decimal" placeholder="Price" value={itemDraft.price}
            onChange={(ev) => setItemDraft({ ...itemDraft, price: ev.target.value })} />
          <button className="primary" disabled={!itemDraft.name.trim() || !itemDraft.price}
            onClick={async () => {
              await api.post(`/api/expenses/${e.id}/items`, {
                name: itemDraft.name.trim(),
                price_minor: toMinor(itemDraft.price, e.currency),
                sharers: itemDraft.sharers,
              });
              setItemDraft({ name: "", price: "", sharers: [] });
              load();
            }}>Add item</button>
        </div>
        <div className="sharer-checks" style={{ marginTop: 4 }}>
          {data.members.map((m) => (
            <label key={m.id} className="pill" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={itemDraft.sharers.includes(m.id)}
                onChange={(ev) => setItemDraft({
                  ...itemDraft,
                  sharers: ev.target.checked
                    ? [...itemDraft.sharers, m.id]
                    : itemDraft.sharers.filter((x) => x !== m.id),
                })} /> {m.name}
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Photos</h2>
          <label className="photo-add">
            + photo
            <input type="file" accept="image/*" hidden
              onChange={async (ev) => {
                const f = ev.target.files?.[0];
                ev.target.value = "";
                if (!f) return;
                await api.upload(`/api/expenses/${e.id}/photos`, f);
                load();
              }} />
          </label>
        </div>
        {(e.photos ?? []).length === 0 && <p className="muted">No photos yet.</p>}
        <div className="photo-grid">
          {(e.photos ?? []).map((id) => (
            <div key={id} className="photo-cell">
              <a href={`${BASE}/api/photos/${id}`} target="_blank" rel="noreferrer">
                <img src={`${BASE}/api/photos/${id}`} alt="expense photo" />
              </a>
              <button className="link danger photo-del"
                onClick={async () => { await api.del(`/api/photos/${id}`); load(); }}>✕</button>
            </div>
          ))}
        </div>
      </div>
      </fieldset>

      {data.access === "edit" && (
        <button className="danger" onClick={async () => {
          if (!confirm(`Delete "${e.name}"? This cannot be undone.`)) return;
          await api.del(`/api/expenses/${e.id}`);
          location.hash = `#/t/${token}`;
        }}>Delete expense</button>
      )}
    </>
  );
}

function MoneyField({ code, minor, onCommit }: { code: string; minor: number; onCommit: (v: number) => void }) {
  const d = decimals(code);
  const [v, setV] = useState(String(minor / 10 ** d));
  useEffect(() => setV(String(minor / 10 ** d)), [minor, d]);
  return (
    <input className="money" inputMode="decimal" value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(Math.round(parseFloat(v || "0") * 10 ** d))} />
  );
}

const ALL_CURRENCIES = Object.keys(CURRENCY_COUNTRIES).sort();
function CurrencyField({ value, onCommit }: { value: string; onCommit: (c: string) => void }) {
  return <CurrencyPicker value={value} options={ALL_CURRENCIES} onChange={onCommit} />;
}
