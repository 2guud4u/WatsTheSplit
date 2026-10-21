import { useEffect, useState } from "react";
import { api } from "./api.ts";

// Live-reload: re-run `load` on every change to the given trips (SSE from
// other clients plus our own mutation echo). Omit tokens when unknown yet
// (e.g. journey before data loads).
export function useTripEvents(tokens: string[] | null, load: () => void) {
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;
    return api.watch(tokens, load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens?.join(","), load]);
}
