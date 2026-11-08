import { useEffect, useState } from "react";
import { rememberedTab, rememberTab } from "./tab-memory.ts";

// The last-selected tab per screen (keyed by token), session-only, plus a
// fallback: a remembered "fun" tab is shown, but a remembered "fun" falls back
// to the default when the tab is no longer live (Wrapped disabled / unlocked).
// The fallback value is persisted, not rawTab, so back-navigation lands on the
// default once the tab is live again.
export function useTabMemory<T extends string>(
  token: string,
  valid: readonly T[],
  fallback: T,
  funLive?: boolean,
): { tab: T; setTab: (t: T) => void } {
  const [rawTab, setRawTabState] = useState<T>(() =>
    rememberedTab(token, valid, fallback));
  const tab = funLive !== undefined && rawTab === "fun" && !funLive
    ? fallback : rawTab;
  const setTab = (t: T) => { rememberTab(token, t); setRawTabState(t); };
  useEffect(() => { rememberTab(token, tab); }, [token, tab]);
  return { tab, setTab };
}
