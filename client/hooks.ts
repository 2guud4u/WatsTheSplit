import { useEffect, useState } from "react";
import { BASE } from "./api.ts";

// Live-reload: re-run `load` on every event from the given trips' streams.
// Pass the trip tokens whose changes should refresh this view; omit when
// unknown yet (e.g. journey before data loads).
export function useTripEvents(tokens: string[] | null, load: () => void) {
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;
    const sources = tokens.map((token) => {
      const es = new EventSource(`${BASE}/api/trips/${token}/events`);
      es.onmessage = () => load();
      return es;
    });
    return () => sources.forEach((es) => es.close());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens?.join(","), load]);
}
