import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { api, Config, Me, isApiError, describeError } from "./api.ts";
import TripView from "./trip/view.tsx";
import ExpenseView from "./expense/view.tsx";
import JourneyView from "./journey/view.tsx";
import Home from "./home/view.tsx";
import "./styles.css";
import "react-day-picker/style.css";

// Mutations that fail without a local handler shouldn't die silently —
// surface ApiErrors once, globally. Sites that intentionally swallow
// (share-link probe, detail-view ping) .catch(() => {}) as before.
addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
  if (isApiError(ev.reason)) {
    ev.preventDefault();
    alert(describeError(ev.reason));
  }
});

const route = () => location.hash.slice(1).split("?")[0] || "/";

// ---------- App ----------
function App() {
  const [path, setPath] = useState(route());
  const [config, setConfig] = useState<Config | null>(null);
  const [me, setMe] = useState<Me>({ user: null });
  const reloadMe = useCallback(() => { api.call("GET /api/me", {}).then(setMe); }, []);

  useEffect(() => {
    const onHash = () => setPath(route());
    addEventListener("hashchange", onHash);
    api.call("GET /api/config", {}).then(setConfig);
    reloadMe();
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const mTrip = /^\/t\/([A-Za-z0-9]+)$/.exec(path);
  const mExp = /^\/t\/([A-Za-z0-9]+)\/e\/([A-Za-z0-9-]+)$/.exec(path);
  const mJourney = /^\/j\/([A-Za-z0-9]+)$/.exec(path);
  return (
    <>
      {mExp ? <ExpenseView key={mExp[2]} token={mExp[1]} expenseId={mExp[2]} />
        : mJourney ? <JourneyView key={mJourney[1]} token={mJourney[1]} reloadMe={reloadMe} />
        : mTrip ? <TripView key={mTrip[1]} token={mTrip[1]} config={config} me={me} reloadMe={reloadMe} />
        : <Home config={config} me={me} reloadMe={reloadMe} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
