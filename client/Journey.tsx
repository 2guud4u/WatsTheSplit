import React, { useEffect, useState, useCallback } from "react";
import { api, BASE, fmtUnits, fmt, flag } from "./api.ts";
import { useTripEvents } from "./hooks.ts";
import { CopyButton } from "./CopyButton.tsx";

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
  transfers: { from: string; to: string; amount: number }[];
  mergeableTrips: TripRef[];
};

export default function JourneyView({ token }: { token: string }) {
  const [data, setData] = useState<JourneyData | null>(null);
  const [err, setErr] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [tab, setTab] = useState<"trips" | "owed" | "people">("trips");

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
        <button className={tab === "owed" ? "active" : ""} onClick={() => setTab("owed")}>Who owes who</button>
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
              {data.mergeableTrips.map((t) => (
                <div key={t.token} className="expense-row">
                  <span>{t.name}</span>
                  <button className="link" onClick={() => addTrip(t.token)}>add</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "owed" && (
        <div className="card">
          {data.transfers.length === 0 && <p className="muted">All squared up.</p>}
          {data.transfers.map((tr, i) => (
            <div key={i} className="expense-row">
              <span><b>{tr.from}</b> pays <b>{tr.to}</b></span>
              <b>{fmtUnits(tr.amount, cur)}</b>
            </div>
          ))}
        </div>
      )}

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
