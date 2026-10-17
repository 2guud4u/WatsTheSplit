import React, { useEffect, useState, useCallback } from "react";
import { api, BASE, fmtUnits, fmt, flag, decimals } from "./api.ts";
import { useTripEvents } from "./hooks.ts";
import { CopyButton } from "./CopyButton.tsx";
import { OweCard } from "./OweCard.tsx";

type TripRef = { token: string; name: string; settle_currency?: string };
type ExpenseSum = {
  id: string; name: string; currency: string; total_minor: number;
  unassigned_minor: number; over: boolean; paid_out: number; category: string | null;
};
type JTrip = TripRef & {
  access: "edit" | "view";
  members: { id: string; name: string; linked: boolean }[];
  expenses: ExpenseSum[];
};
type Person = { key: string; name: string; memberIds: string[]; linked: boolean };
type JMember = { id: string; name: string; trip_name: string; key: string; linked: boolean };
type JourneyData = {
  journey: { token: string; name: string; settle_currency: string };
  trips: JTrip[];
  persons: Person[];
  members: JMember[];
  mergeHints: { name: string; member_ids: string[]; trips: string[] }[];
  transfers: Transfer[];
  my_member_ids: string[];
  mergeableTrips: (TripRef & { settle_currency: string })[];
};
type TransferPart = {
  trip_token: string; trip_name: string; from_member: string; to_member: string;
  amount: number; against: boolean;
};
type Transfer = { from: string; to: string; amount: number; from_key: string; to_key: string; parts: TransferPart[] };

export default function JourneyView({ token }: { token: string }) {
  const [data, setData] = useState<JourneyData | null>(null);
  const [err, setErr] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [tab, setTab] = useState<"trips" | "owed" | "youowe" | "people">("trips");
  const [paying, setPaying] = useState<Transfer | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.get(`/api/journeys/${token}`)); setErr(""); }
    catch (e) { setErr(e instanceof Error ? e.message : "error"); }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  // live-refresh off every member trip's event stream
  useTripEvents(data?.trips.map((t) => t.token) ?? null, load);

  if (err) {
    if (err !== "no_access") return <p className="error">{err}</p>;
    // Journey link open but no trip access yet: the join button records
    // the grant, then the page reloads with trips + claim chips.
    return (
      <>
        <h1>Shared journey</h1>
        <div className="card">
          <p className="muted">This journey link lets you view every trip in it and add yourself to the ones you joined.</p>
          <button className="primary" onClick={async () => {
            await api.post(`/api/journeys/${token}/join`);
            load();
          }}>Open journey</button>
        </div>
      </>
    );
  }
  if (!data) return <p className="muted">Loading…</p>;
  const j = data.journey;
  const cur = j.settle_currency;
  const link = `${location.origin}${BASE}/#/j/${j.token}`;

  const merge = async (ids: string[]) => {
    try { await api.post(`/api/journeys/${j.token}/merge`, { member_ids: ids }); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "error"); }
  };
  const unmerge = async (memberId: string) => {
    await api.del(`/api/journeys/${j.token}/merge/${memberId}`); load();
  };
  const removeTrip = async (tt: string) => {
    await api.del(`/api/journeys/${j.token}/trips/${tt}`); load();
  };
  const addTrip = async (tt: string) => {
    await api.post(`/api/journeys/${j.token}/trips`, { trip_token: tt }); setAddOpen(false); load();
  };
  const claimIn = async (tripToken: string, memberId: string) => {
    await api.post(`/api/trips/${tripToken}/claim`, { member_id: memberId }); load();
  };

  // group members by merge key for the people panel
  const grouped = new Map<string, JMember[]>();
  for (const m of data.members) grouped.set(m.key, [...(grouped.get(m.key) ?? []), m]);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ marginBottom: 4 }}>{j.name}</h1>
        <a href="#/" className="muted">← home</a>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Shared balance in {flag(cur)} {cur} · settle up inside trips
      </p>

      <div className="card">
        <div className="row">
          <input className="wide" readOnly value={link} onFocus={(e) => e.target.select()} />
          <CopyButton text={link} />
        </div>
        <p className="muted">Anyone with this link can view the trips and add themselves — keep it private.</p>
      </div>

      <div className="tabs">
        <button className={tab === "trips" ? "active" : ""} onClick={() => setTab("trips")}>Trips</button>
        <button className={tab === "owed" ? "active" : ""} onClick={() => setTab("owed")}>Who owes you</button>
        <button className={tab === "youowe" ? "active" : ""} onClick={() => setTab("youowe")}>Who you owe</button>
        <button className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>People</button>
      </div>

      {tab === "trips" && (
        <>
          {data.trips.map((t) => (
            <div key={t.token} className="card" style={{ marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}><a href={`#/t/${t.token}`}>{t.name}</a></h2>
                <span className="muted">{t.access === "view" ? "view only" : flag(t.settle_currency ?? "") + " " + t.settle_currency}</span>
              </div>
              {t.access === "view" && (
                <div className="row" style={{ flexWrap: "wrap", margin: "8px 0" }}>
                  {t.members.map((mm) => (
                    <button key={mm.id} className="member-chip" disabled={mm.linked}
                      onClick={() => claimIn(t.token, mm.id)}>
                      {mm.name}{mm.linked && <span className="pill">🔒</span>}
                    </button>
                  ))}
                  <button className="link" onClick={async () => {
                    const name = prompt("Your name for this trip:");
                    if (!name?.trim()) return;
                    try { await api.post(`/api/trips/${t.token}/claim`, { name: name.trim() }); load(); }
                    catch { alert("Name taken — pick another."); }
                  }}>+ new name</button>
                </div>
              )}
              {t.expenses.length === 0 && <p className="muted">No expenses yet.</p>}
              {t.expenses.map((e) => (
                <div key={e.id} className="expense-row">
                  <a href={`#/t/${t.token}/e/${e.id}`}>{e.name}</a>
                  <span>
                    {fmt(e.total_minor, e.currency)}
                    {e.unassigned_minor > 0 && !e.over &&
                      <span className="badge badge-unassigned"> {fmt(e.unassigned_minor, e.currency)} unassigned</span>}
                  </span>
                </div>
              ))}
              {t.access === "edit" && (
                <button className="link" onClick={() => removeTrip(t.token)}>remove from journey</button>
              )}
            </div>
          ))}
          <button className="link" onClick={() => setAddOpen(!addOpen)}>+ Add a trip</button>
          {addOpen && (
            <div className="card" style={{ marginTop: 8 }}>
              {data.mergeableTrips.length === 0 && <p className="muted">No other trips available.</p>}
              {data.mergeableTrips.map((t) => {
                const ok = t.settle_currency === cur;
                return (
                  <div key={t.token} className="expense-row">
                    <span className={ok ? "" : "muted"}>{t.name}</span>
                    {ok
                      ? <button className="link" onClick={() => addTrip(t.token)}>add</button>
                      : <span className="muted">settles in {t.settle_currency} — journey is {cur}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {(tab === "owed" || tab === "youowe") && (() => {
        // viewer's person keys: persons containing any of my_member_ids
        const mine = new Set(data.members.filter((m) => data.my_member_ids.includes(m.id)).map((m) => m.key));
        const rows = data.transfers.filter((tr) =>
          mine.size === 0 ? tab === "owed" : tab === "owed" ? mine.has(tr.to_key) : mine.has(tr.from_key));
        return (
          <div className="card">
            {mine.size === 0 && <p className="muted">You haven't joined a trip yet — showing everything.</p>}
            {rows.length === 0 && mine.size > 0 && (
              <p className="muted">{tab === "owed" ? "Nobody owes you." : "You owe nobody."}</p>
            )}
            {rows.length > 0 && (
              <div className="owe-grid">
                {rows.map((tr) => (
                  <OweCard key={tr.from_key + tr.to_key}
                    name={tab === "owed" ? tr.from : tr.to}
                    amount={tr.amount} currency={cur}
                    dir={tab === "owed" ? "in" : "out"}
                    onConfirm={mine.size > 0 ? () => setPaying(tr) : undefined} />
                ))}
              </div>
            )}
            {paying && (
              <MarkPaidModal transfer={paying} currency={cur} trips={data.trips}
                onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />
            )}
          </div>
        );
      })()}

      {tab === "people" && (
        <>
          {data.mergeHints.length > 0 && (
            <div className="card">
              {data.mergeHints.map((h) => (
                <div key={h.name} className="expense-row">
                  <span><b>{h.name}</b> appears in {h.trips.join(" and ")} — same person?</span>
                  <button className="link" onClick={() => merge(h.member_ids)}>merge</button>
                </div>
              ))}
            </div>
          )}
          <div className="card">
            {[...grouped.entries()].map(([key, ms]) => {
              const person = data.persons.find((p) => p.key === key);
              const merged = ms.length > 1;
              return (
                <div key={key} className="expense-row">
                  <span>
                    {person?.name ?? ms[0].name}
                    {merged && <span className="muted"> ({ms.map((m) => m.trip_name).join(" + ")})</span>}
                    {ms.some((m) => m.linked) && " ✓"}
                  </span>
                  {merged && ms.length > 1 && (
                    <span className="muted">
                      {ms.map((m) => (
                        <button key={m.id} className="link" style={{ fontSize: 11 }}
                          onClick={() => unmerge(m.id)}>unmerge {m.trip_name}</button>
                      ))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

// Mark a journey card paid: pick all trips or some, then record one Settlement
// per picked trip, for that trip's full debt, between that trip's own Members.
// Pieces running the other way (the payee owes the payer in that trip) are
// already netted into the card total, so they can only be settled together
// with the rest via "all".
function MarkPaidModal({ transfer, currency, trips, onClose, onDone }: {
  transfer: Transfer; currency: string; trips: JTrip[];
  onClose: () => void; onDone: () => void;
}) {
  const payable = transfer.parts.filter((p) => !p.against);
  const against = transfer.parts.filter((p) => p.against);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(payable.map((p) => p.trip_token)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const all = picked.size === payable.length;
  const total = (all ? transfer.parts : payable.filter((p) => picked.has(p.trip_token)))
    .reduce((s, p) => s + (p.against ? -p.amount : p.amount), 0);
  const canEdit = (tt: string) => trips.find((t) => t.token === tt)?.access === "edit";
  const blocked = transfer.parts.filter((p) => (all || picked.has(p.trip_token)) && !canEdit(p.trip_token));

  const submit = async () => {
    setBusy(true); setError("");
    try {
      const settle = all ? transfer.parts : payable.filter((p) => picked.has(p.trip_token));
      for (const p of settle) {
        const minor = Math.round(p.amount * 10 ** decimals(currency));
        if (minor <= 0) continue;
        await api.post(`/api/trips/${p.trip_token}/settlements`, {
          from_member: p.from_member, to_member: p.to_member, amount_minor: minor,
        });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{transfer.from} paid {transfer.to}</h3>
        <label className="expense-row">
          <span><input type="checkbox" checked={all}
            onChange={(e) => setPicked(new Set(e.target.checked ? payable.map((p) => p.trip_token) : []))} /> All trips</span>
          <b>{fmtUnits(transfer.amount, currency)}</b>
        </label>
        {payable.map((p) => (
          <label key={p.trip_token} className="expense-row" style={{ paddingLeft: 22 }}>
            <span><input type="checkbox" checked={picked.has(p.trip_token)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(p.trip_token); else next.delete(p.trip_token);
                setPicked(next);
              }} /> {p.trip_name}</span>
            <span>{fmtUnits(p.amount, currency)}</span>
          </label>
        ))}
        {against.map((p) => (
          <div key={p.trip_token} className="expense-row muted" style={{ paddingLeft: 22 }}>
            <span>{p.trip_name} — {transfer.to} owes {transfer.from}, netted in</span>
            <span>−{fmtUnits(p.amount, currency)}</span>
          </div>
        ))}
        {against.length > 0 && !all && (
          <p className="muted">Trips where {transfer.to} owes {transfer.from} are only settled with "All trips".</p>
        )}
        {blocked.length > 0 && (
          <p className="warn">Pick your name in {blocked.map((p) => p.trip_name).join(", ")} first — you can only record payments in trips you've joined.</p>
        )}
        {error && <div className="error">{error}</div>}
        <div className="modal-btns">
          <button className="link" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || picked.size === 0 || blocked.length > 0} onClick={submit}>
            Record {fmtUnits(total, currency)}
          </button>
        </div>
      </div>
    </div>
  );
}
