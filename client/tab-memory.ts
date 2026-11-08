// Session-only last-selected tab per screen.
// Keyed by the token (trip or journey). It survives browser back and
// remounts within a session (the trip's key-based remount picks it back up),
// and resets on reload. Module scope, no persistence, no URL.

const lastTab = new Map<string, string>();

export function rememberTab(key: string, tab: string) {
  lastTab.set(key, tab);
}

export function rememberedTab<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  const saved = lastTab.get(key);
  return saved && (valid as readonly string[]).includes(saved) ? (saved as T) : fallback;
}
