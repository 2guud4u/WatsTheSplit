// Client-only shared types + small helpers. Wire types live in
// ../shared/wire.ts (re-exported through ./api.ts) — don't duplicate them here.

export type RecentTrip = { token: string; name: string };

// ---------- recent trips (localStorage) ----------
const RECENT_KEY = "wts_recent";
export const getRecent = (): RecentTrip[] => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
};
export const addRecent = (token: string, name: string) => {
  const list = getRecent().filter((t) => t.token !== token);
  list.unshift({ token, name });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20)));
};
