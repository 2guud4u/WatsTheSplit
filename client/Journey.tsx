import React, { useEffect, useState, useCallback } from "react";
import { api, BASE, fmtUnits, flag } from "./api.ts";
import { useTripEvents } from "./hooks.ts";
import { CopyButton } from "./CopyButton.tsx";

type TripRef = { token: string; name: string; settle_currency?: string };
type Person = { key: string; name: string; memberIds: string[]; linked: boolean };
type JMember = { id: string; name: string; trip_name: string; key: string; linked: boolean };
type JourneyData = {
  journey: { token: string; name: string; settle_currency: string };
  trips: TripRef[];
  persons: Person[];
  members: JMember[];
  mergeHints: { name: string; member_ids: string[]; trips: string[] }[];
  transfers: { from: string; to: string; amount: number }[];
  positions: { person: string; net: number }[];
  perTrip: { token: string; name: string; settle_currency: string; converted: boolean; balances: { person: string; net: number }[] }[];
  mergeableTrips: TripRef[];
};

export default function JourneyView({ token }: { token: string }) {
  const [data, setData] = useState<JourneyData | null>(null);
  const [err, setErr] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api.get(`/api/journeys/${token}`)); setErr(""); }
    catch (e) { setErr(e instanceof Error ? e.message : "error"); }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  // live-refresh off every member trip's event stream
  useTripEvents(data?.trips.map((t) => t.token) ?? null, load);

  if (err) return <p className="error">{err === "no_access" ? "You need access to at least one trip in this journey — open it through a trip link." : err}</p>;
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

  // members grouped by person key for the People card
  const grouped = new Map<string, JMember[]>();
  for (const m of data.members) grouped.set(m.key, [...(grouped.get(m.key) ?? []), m]);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ marginBottom: 0 }}>{j.name}</h1>
        <a href="#/" className="muted">← home</a>
      </div>
      <p className="muted">Shared balance in {flag(cur)} {cur} · read-only — settle up inside trips</p>

      <div className="card">
        <div className="row">
          <input className="wide" readOnly value={link} onFocus={(e) => e.target.select()} />
          <CopyButton text={link} />
        </div>
        <p className="muted">Opens for anyone who can open a member trip — no extra password.</p>
      </div>

      <h2>Who owes who</h2>
      <div className="card">
        {data.transfers.length === 0 && <p className="muted">All squared up.</p>}
        {data.transfers.map((tr, i) => (
          <div key={i} className="expense-row">
            <span><b>{tr.from}</b> pays <b>{tr.to}</b></span>
            <b>{fmtUnits(tr.amount, cur)}</b>
          </div>
        ))}
      </div>

      <h2>Net positions</h2>
      <div className="card">
        {data.positions.map((p) => (
          <div key={p.person} className="expense-row">
            <span>{p.person}</span>
            <b style={{ color: p.net < -0.004 ? "var(--error)" : p.net > 0.004 ? "var(--success, #4a7c4e)" : undefined }}>
              {p.net > 0 ? `+${fmtUnits(p.net, cur)}` : fmtUnits(p.net, cur)}
            </b>
          </div>
        ))}
      </div>

      <details className="more">
        <summary>Per-trip breakdown</summary>
        {data.perTrip.map((t) => (
          <div key={t.token} className="card" style={{ marginTop: 8 }}>
            <b>{t.name}</b> <span className="muted">({t.settle_currency}{!t.converted ? " — can't convert" : ""})</span>
            {t.balances.length === 0 && <p className="muted">No balances.</p>}
            {t.balances.map((b) => (
              <div key={b.person} className="expense-row">
                <span>{b.person}</span>
                <span className="muted">{b.net > 0 ? "+" : ""}{fmtUnits(b.net, t.settle_currency)}</span>
              </div>
            ))}
          </div>
        ))}
      </details>

      <h2>Trips</h2>
      <div className="card">
        {data.trips.map((t) => (
          <div key={t.token} className="expense-row">
            <a href={`#/t/${t.token}`}>{t.name}</a>
            <button className="link" onClick={() => removeTrip(t.token)}>remove</button>
          </div>
        ))}
        <button className="link" onClick={() => setAddOpen(!addOpen)}>+ Add a trip</button>
        {addOpen && (
          <div style={{ marginTop: 8 }}>
            {data.mergeableTrips.length === 0 && <p className="muted">No other trips available.</p>}
            {data.mergeableTrips.map((t) => (
              <div key={t.token} className="expense-row">
                <span>{t.name}</span>
                <button className="link" onClick={() => addTrip(t.token)}>add</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2>People</h2>
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
  );
}
