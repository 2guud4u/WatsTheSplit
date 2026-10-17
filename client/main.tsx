import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { api, Config, flag } from "./api.ts";
import TripView from "./Trip.tsx";
import ExpenseView from "./Expense.tsx";
import { CurrencyPicker } from "./CurrencyPicker.tsx";
import "./styles.css";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { SignInButton } from "./SignIn.tsx";

type Me = { user: { email: string; name: string | null } | null };

const route = () => location.hash.slice(1).split("?")[0] || "/";

// ---------- recent trips ----------
const RECENT_KEY = "wts_recent";
const getRecent = (): { token: string; name: string }[] => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
};
export const addRecent = (token: string, name: string) => {
  const list = getRecent().filter((t) => t.token !== token);
  list.unshift({ token, name });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20)));
};

// ---------- Home ----------
function Home({ config, me, reloadMe }: { config: Config | null; me: Me; reloadMe: () => void }) {
  const [name, setName] = useState("");
  const [range, setRange] = useState<DateRange | undefined>();
  const [tripCur, setTripCur] = useState("");
  const [settleCur, setSettleCur] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [memberInput, setMemberInput] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const currencies = config?.currencies ?? [];

  const create = async () => {
    try {
      const r = await api.post("/api/trips", {
        name,
        start_date: range?.from ? range.from.toISOString().slice(0, 10) : null,
        end_date: range?.to ? range.to.toISOString().slice(0, 10) : null,
        trip_currency: tripCur, settle_currency: settleCur,
        password: pw, members,
      });
      addRecent(r.token, name);
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
              <button className="link" onClick={async () => { await api.post("/api/auth/signout"); reloadMe(); }}>Sign out</button>
            </>
          ) : (
            <>
              <span className="muted">Keep your identity across devices</span>
              <SignInButton onSignedIn={reloadMe} />
            </>
          )}
        </div>
      </div>

      <button className="primary" onClick={() => setShowCreate(true)}>Create a trip</button>

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

// Drag-to-pick date range: pointer-down on a day sets the start, moving to
// another day extends the end. Click-click still works via DayPicker's own
// range mode. Dates are compared at day granularity.
export function RangePicker({ value, onChange, onCommit }: { value: DateRange | undefined; onChange: (r: DateRange | undefined) => void; onCommit?: (r: DateRange | undefined) => void }) {
  const start = React.useRef<Date | null>(null);
  const moved = React.useRef(false);
  const suppress = React.useRef(false); // swallow the click DayPicker fires after pointerup

  const dayAt = (e: React.PointerEvent): Date | null => {
    // During pointer capture e.target stays on the wrapper; hit-test instead.
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-day]");
    const ds = el?.getAttribute("data-day");
    return ds ? new Date(ds + "T00:00:00") : null;
  };

  const onDown = (e: React.PointerEvent) => {
    const d = dayAt(e);
    if (!d) return;
    start.current = d;
    moved.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const d = dayAt(e);
    if (!d || d.getTime() === s.getTime()) return;
    moved.current = true;
    onChange(s <= d ? { from: s, to: d } : { from: d, to: s });
  };
  const onUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    suppress.current = true;
    if (moved.current) { moved.current = false; onCommit?.(value); return; }
    // Plain click: finish a pending range, else start a new one.
    let next: DateRange | undefined;
    if (value?.from && !value?.to && s.getTime() !== value.from.getTime()) {
      next = s > value.from ? { from: value.from, to: s } : { from: s, to: value.from };
    } else {
      next = { from: s, to: undefined };
    }
    onChange(next);
    onCommit?.(next);
  };

  return (
    <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onPointerCancel={onUp} style={{ touchAction: "pan-y" }}>
      <DayPicker mode="range" selected={value} weekStartsOn={1}
        onSelect={(r) => { if (suppress.current) { suppress.current = false; return; } onChange(r); }} />
    </div>
  );
}

function RecentTrips({ me }: { me: Me }) {
  const [myTrips, setMyTrips] = useState<{ token: string; name: string }[]>([]);
  useEffect(() => {
    if (me.user) api.get("/api/my-trips").then((r) => setMyTrips(r.trips));
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

// ---------- App ----------
function App() {
  const [path, setPath] = useState(route());
  const [config, setConfig] = useState<Config | null>(null);
  const [me, setMe] = useState<Me>({ user: null });
  const reloadMe = useCallback(() => { api.get("/api/me").then(setMe); }, []);

  useEffect(() => {
    const onHash = () => setPath(route());
    addEventListener("hashchange", onHash);
    api.get("/api/config").then(setConfig);
    reloadMe();
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const mTrip = /^\/t\/([A-Za-z0-9]+)$/.exec(path);
  const mExp = /^\/t\/([A-Za-z0-9]+)\/e\/([A-Za-z0-9-]+)$/.exec(path);

  return (
    <>
      {mExp ? <ExpenseView key={mExp[2]} token={mExp[1]} expenseId={mExp[2]} />
        : mTrip ? <TripView key={mTrip[1]} token={mTrip[1]} config={config} me={me} reloadMe={reloadMe} />
        : <Home config={config} me={me} reloadMe={reloadMe} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
