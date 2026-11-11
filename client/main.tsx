import React, { useCallback, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import ExpenseView from "./pages/ExpenseView.tsx"
import Home from "./pages/Home.tsx"
import JourneyView from "./pages/JourneyView.tsx"
import TripView from "./pages/TripView.tsx"
import { api, type Config, describeError, isApiError, type Me } from "./services/api.ts"
import "./styles/global.css"
import SnackRoot from "./components/Snack.tsx"
import { route } from "./routes.ts"
import "react-day-picker/style.css"

// Mutations that fail without a local handler shouldn't die silently —
// surface ApiErrors once, globally. Sites that intentionally swallow
// (share-link probe, detail-view ping) .catch(() => {}) as before.
addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
  if (isApiError(ev.reason)) {
    ev.preventDefault()
    alert(describeError(ev.reason))
  }
})

// ---------- App ----------
function App() {
  const [path, setPath] = useState(route())
  const [config, setConfig] = useState<Config | null>(null)
  const [me, setMe] = useState<Me>({ user: null })
  const reloadMe = useCallback(() => {
    void api.call("GET /api/me", {}).then(setMe)
  }, [])

  useEffect(() => {
    const onHash = () => setPath(route())
    addEventListener("hashchange", onHash)
    void api.call("GET /api/config", {}).then(setConfig)
    reloadMe()
    return () => removeEventListener("hashchange", onHash)
  }, [reloadMe])

  const mTrip = /^\/t\/([A-Za-z0-9]+)$/.exec(path)
  const mExp = /^\/t\/([A-Za-z0-9]+)\/e\/([A-Za-z0-9-]+)$/.exec(path)
  const mJourney = /^\/j\/([A-Za-z0-9]+)$/.exec(path)
  return (
    <>
      <SnackRoot />
      {mExp ? (
        <ExpenseView key={mExp[2] ?? ""} token={mExp[1] ?? ""} expenseId={mExp[2] ?? ""} />
      ) : mJourney ? (
        <JourneyView key={mJourney[1] ?? ""} token={mJourney[1] ?? ""} reloadMe={reloadMe} />
      ) : mTrip ? (
        <TripView key={mTrip[1] ?? ""} token={mTrip[1] ?? ""} config={config} reloadMe={reloadMe} />
      ) : (
        <Home config={config} me={me} reloadMe={reloadMe} />
      )}
    </>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
