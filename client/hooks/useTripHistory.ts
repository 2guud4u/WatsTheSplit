import { useCallback, useEffect, useState } from "react";
import { api } from "../services/api.ts";
import type { HistoryEntry } from "../services/api.ts";
import { useTripEvents } from "./useTripEvents.ts";

// Trip history: fetches the trip's full change log (every expense/settlement
// created, edited, or deleted, per field) and live-reloads on change.
export function useTripHistory(token: string) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.call("GET /api/trips/:trip/history", { trip: token });
      setHistory(r.history);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useTripEvents([token], load);

  return { history, err };
}
