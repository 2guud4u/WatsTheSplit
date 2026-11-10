// Wrapped (fun leaderboard): split into stats (collection + types) and
// awards (the award menu). This module re-exports the public surface so
// callers (trips/journeys routes) keep `import { funBoard, journeyBoard }
// from "./wrapped.ts"`.
export { funBoard, journeyBoard, pick, buildAwards } from "./awards.ts";
export type { Award } from "./awards.ts";
export { collectStats } from "./stats.ts";
export type { TripStats, Entity } from "./stats.ts";
