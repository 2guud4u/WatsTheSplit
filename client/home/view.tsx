import React, { useEffect, useState } from "react";
import { Config, Me } from "../api.ts";
import type { AccessibleTrip, TripSummary, JourneySummary } from "../api.ts";
import { getRecent } from "../types.ts";
import { CurrencyPicker } from "../ui/CurrencyPicker.tsx";
import { SignInButton } from "../ui/SignIn.tsx";
import { RangePicker } from "../ui/RangePicker.tsx";
import type { DateRange } from "react-day-picker";
import { homeActions } from "./model.ts";

export default function Home({ config, me, reloadMe }: { config: Config | null; me: Me; reloadMe: () => void }) {
  const [name, setName] = useState("");
  const [range, setRange] = useState<DateRange | undefined>();
  const [tripCur, setTripCur] = useState("");
  const [settleCur, setSettleCur] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [memberInput, setMemberInput] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showJourney, setShowJourney] = useState(false);
  const [jName, setJName] = useState("");
  const [jPicked, setJPicked] = useState<Set<string>>(new Set());
  const [jTrips, setJTrips] = useState<AccessibleTrip[]>([]);
  // a journey takes the currency of its first picked trip; others must match
  const jCur = jTrips.find((t) => jPicked.has(t.token))?.settle_currency ?? "";

  const openJourneyModal = async () => {
    setShowJourney(true);
    const r = await homeActions.accessibleTrips();
    setJTrips(r.trips.filter((t) => !t.journey));
  };
  const createJourney = async () => {
    try {
      const r = await homeActions.createJourney({
        name: jName, trip_tokens: [...jPicked],
      });
      location.hash = `#/j/${r.token}`;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const openCreateModal = () => {
    setShowCreate(true);
    homeActions.memberSuggestions().then((r) => setSuggestions(r.suggestions)).catch(() => {});
  };
  const currencies = config?.currencies ?? [];

  const create = async () => {
    try {
      const r = await homeActions.createTrip({
        name,
        start_date: range?.from ? range.from.toISOString().slice(0, 10) : null,
        end_date: range?.to ? range.to.toISOString().slice(0, 10) : null,
        trip_currency: tripCur, settle_currency: settleCur,
        password: pw, members,
      });
      location.hash = `#/t/${r.token}`;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const addMember = () => {
    const n = memberInput.trim();
    if (!n) return;
    if (!members.some((m) => m.toLowerCase() === n.toLowerCase())) setMembers([...members, n]);
    setMemberInput("");
  };

  return (
    <>
      <h1>WatsTheSplit</h1>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          {me.user ? (
            <>
              <span>Signed in as <b>{me.user.name || me.user.email}</b></span>
              <button className="link" onClick={async () => { await homeActions.signOut(); reloadMe(); }}>Sign out</button>
            </>
          ) : (
            <>
              <span className="muted">Keep your identity across devices</span>
              <SignInButton onSignedIn={reloadMe} />
            </>
          )}
        </div>
      </div>

      <div className="row">
        <button className="primary" onClick={openCreateModal}>Create a trip</button>
        <button onClick={openJourneyModal}>Create a journey</button>
      </div>

      {showJourney && (
        <div className="modal-bg" onClick={() => setShowJourney(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create a journey</h3>
            <p className="muted">A journey shares one "who owes who" balance across trips that settle in the same currency.</p>
            <div className="field"><label className="field-label">Name</label>
              <input className="wide" autoFocus value={jName} onChange={(e) => setJName(e.target.value)}
                placeholder="e.g. Asia 2026" /></div>
            <div className="field"><label className="field-label">Trips to include — tap to select</label>
              {jTrips.length === 0
                ? <p className="muted">No trips available — create trips first, or open them on this device.</p>
                : (
                  <div className="pills" style={{ flexDirection: "column", alignItems: "stretch" }}>
                    {jTrips.map((t) => {
                      const blocked = !!jCur && t.settle_currency !== jCur;
                      return (
                        <button key={t.token} disabled={blocked}
                          className={`member-pill${jPicked.has(t.token) ? " picked" : ""}`}
                          style={{ textAlign: "left", padding: "10px 14px", cursor: blocked ? "not-allowed" : "pointer" }}
                          onClick={() => setJPicked((s) => { const n = new Set(s); n.has(t.token) ? n.delete(t.token) : n.add(t.token); return n; })}>
                          {jPicked.has(t.token) ? "✓ " : ""}{t.name}
                          <span className="muted"> · {t.settle_currency}{blocked ? ` — journey is ${jCur}` : ""}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
            </div>
            {err && <div className="error">{err}</div>}
            <div className="modal-btns">
              <button className="link" onClick={() => setShowJourney(false)}>Cancel</button>
              <button className="primary" onClick={createJourney}
                disabled={!jName.trim() || jPicked.size === 0}>Create journey</button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="modal-bg" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create a trip</h3>
            <div className="field"><label className="field-label">Name</label>
              <input className="wide" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Japan 2026" onKeyDown={(e) => e.key === "Enter" && create()} /></div>
            <div className="field"><label className="field-label">Password (required)</label>
              <input className="wide" type="text" value={pw} onChange={(e) => setPw(e.target.value)}
                placeholder="Friends need it — the share link carries it"
                onKeyDown={(e) => e.key === "Enter" && create()} /></div>
            <div className="row">
              <div className="field"><label className="field-label">Trip currency</label>
                <CurrencyPicker value={tripCur} options={currencies} onChange={setTripCur} /></div>
              <div className="field"><label className="field-label">Settlement currency</label>
                <CurrencyPicker value={settleCur} options={currencies} onChange={setSettleCur} /></div>
            </div>
            <div className="field"><label className="field-label">Members (optional)</label>
              {members.length > 0 && (
                <div className="pills">
                  {members.map((m) => (
                    <span key={m} className="member-pill">
                      {m}
                      <button className="pill-x" onClick={() => setMembers(members.filter((x) => x !== m))}
                        aria-label={`Remove ${m}`}>✕</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="row">
                <input className="wide" value={memberInput}
                  placeholder="Add a name — they'll pick it when they join"
                  onChange={(e) => setMemberInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addMember(); } }} />
                <button onClick={addMember} disabled={!memberInput.trim()}>Add</button>
              </div>
              {(() => {
                const q = memberInput.trim().toLowerCase();
                const opts = suggestions.filter((s) =>
                  !members.some((m) => m.toLowerCase() === s.toLowerCase())
                  && (!q || s.toLowerCase().includes(q)));
                return opts.length > 0 && (
                  <div className="pills">
                    {opts.slice(0, 8).map((s) => (
                      <button key={s} className="member-pill" style={{ cursor: "pointer" }}
                        onClick={() => { setMembers([...members, s]); setMemberInput(""); }}>
                        + {s}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            <details className="more">
              <summary>Dates (optional){range?.from ? ` — ${range.from.toISOString().slice(0,10)}${range.to ? " → " + range.to.toISOString().slice(0,10) : " → …"}` : ""}</summary>
              <RangePicker value={range} onChange={setRange} />
            </details>
            {err && <div className="error">{err}</div>}
            <div className="modal-btns">
              <button className="link" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="primary" onClick={create}
                disabled={!name.trim() || !tripCur || !settleCur || !pw.trim()}>Create trip</button>
            </div>

          </div>
        </div>
      )}

      <RecentTrips me={me} />
    </>
  );
}

function RecentTrips({ me }: { me: Me }) {
  const [myTrips, setMyTrips] = useState<TripSummary[]>([]);
  const [myJourneys, setMyJourneys] = useState<JourneySummary[]>([]);
  useEffect(() => {
    homeActions.myJourneys().then((r) => setMyJourneys(r.journeys)).catch(() => {});
    if (me.user) homeActions.myTrips().then((r) => setMyTrips(r.trips));
  }, [me.user]);
  const recent = getRecent();
  return (
    <>
      {me.user && myTrips.length > 0 && (
        <>
          <h2>My trips</h2>
          <div className="card">
            {myTrips.map((t) => (
              <div key={t.token} className="expense-row">
                <a href={`#/t/${t.token}`}>{t.name}</a>
              </div>
            ))}
          </div>
        </>
      )}
      {myJourneys.length > 0 && (
        <>
          <h2>My journeys</h2>
          <div className="card">
            {myJourneys.map((j) => (
              <div key={j.token} className="expense-row">
                <a href={`#/j/${j.token}`}>{j.name}</a>
              </div>
            ))}
          </div>
        </>
      )}
      {recent.length > 0 && (
        <>
          <h2>Recent on this device</h2>
          <div className="card">
            {recent.map((t) => (
              <div key={t.token} className="expense-row">
                <a href={`#/t/${t.token}`}>{t.name}</a>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
