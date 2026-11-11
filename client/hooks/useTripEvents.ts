import { useEffect, useState } from "react"
import { api } from "../services/api.ts"

// Live-reload: re-run `load` on every change to the given trips (SSE from
// other clients plus our own mutation echo). Omit tokens when unknown yet
// (e.g. journey before data loads).
export function useTripEvents(tokens: string[] | null, load: () => void) {
  // The join key re-runs only when the token set changes (stable across re-renders);
  // the `tokens` array itself would re-subscribe every render, a behavior change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: use the stable join key
  useEffect(() => {
    if (!tokens || tokens.length === 0) return
    return api.watch(tokens, load)
  }, [tokens?.join(","), load])
}
