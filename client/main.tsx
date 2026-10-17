import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { api, Config, flag } from "./api.ts";
import TripView from "./Trip.tsx";
import ExpenseView from "./Expense.tsx";
import { CurrencyPicker } from "./CurrencyPicker.tsx";
import "./styles.css";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, o: { type: string; size: string }) => void;
        };
      };
    };
  }
}

type Me = { user: { google_sub: string; email: string; name: string; picture: string } | null };

const route = () => location.hash.slice(1).split("?")[0] || "/";

// ---------- Google sign-in ----------
function useGoogle(config: Config | null, onSignedIn: () => void) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!config?.googleClientId) return;
    const init = () => {
      window.google?.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async (resp: { credential: string }) => {
          await api.post("/api/auth/google", { credential: resp.credential });
          onSignedIn();
        },
      });
      setReady(true);
    };
    if (window.google) init();
    else {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = init;
      document.head.appendChild(s);
    }
  }, [config?.googleClientId]);
  return ready;
}

function GoogleButton({ config, onSignedIn }: { config: Config; onSignedIn: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const ready = useGoogle(config, onSignedIn);
  useEffect(() => {
    if (ready && ref.current) {
      window.google?.accounts.id.renderButton(ref.current, { type: "standard", size: "medium" });
    }
  }, [ready]);
  if (!config.googleClientId) return null;
  return <div ref={ref} />;
}

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
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [tripCur, setTripCur] = useState("");
  const [settleCur, setSettleCur] = useState("");
  const [membersText, setMembersText] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const currencies = config?.currencies ?? [];

  const create = async () => {
    try {
      const r = await api.post("/api/trips", {
        name, start_date: start || null, end_date: end || null,
        trip_currency: tripCur, settle_currency: settleCur,
        password: pw, members: membersText,
      });
      addRecent(r.token, name);
      location.hash = `#/t/${r.token}`;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
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
          ) : config?.googleClientId ? (
            <>
              <span className="muted">Sign in to keep your identity across devices</span>
              <GoogleButton config={config} onSignedIn={reloadMe} />
            </>
          ) : (
            <span className="muted">No sign-in configured</span>
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
              <input className="wide" value={membersText}
                placeholder="Alice, Bob, Carol — they pick their name when they join"
                onChange={(e) => setMembersText(e.target.value)} /></div>
            <details className="more">
              <summary>Dates (optional)</summary>
              <div className="row">
                <div className="field"><label className="field-label">From</label><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
                <div className="field"><label className="field-label">To</label><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
              </div>
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
