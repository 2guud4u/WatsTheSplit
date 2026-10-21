# Research: "Trip in Review" — incorporating Spotify-Wrapped-style stats into Trip Wrapped

Checked: 2026-10-21 (UTC). Primary sources cited inline; implementation survey is file:line in this repo.

Context: Trip Wrapped already exists — silly award titles computed from expense data (`server/wrapped.ts`), gated until the trip ends (+5 days if no end date), rendered as a tab (`client/ui/Awards.tsx`). The ask: a Wrapped-style "trip in review" experience inside it.

---

## 1. What Spotify Wrapped actually shows (sourced)

From Spotify's own 2025 Wrapped announcements:

- **Core stat stories**: Minutes Listened (total time), Top Songs (top 5 + a playlist of your top 100 with stream counts), Top Artists (top 5), Top Genres, Top Podcasts. [2025 Wrapped user experience](https://newsroom.spotify.com/2025-12-03/2025-wrapped-user-experience/)
- **Comparative/personality stories**: Listening Age (taste vs. your age group's typical release years), Fan Leaderboard (your rank among an artist's global listeners), Clubs — you're sorted into one of six "listening style" clubs (Cloud State Society, Grit Collective, Club Serotonin, Full Charge Crew, Cosmic Stereo Club, Soft Hearts Club) plus a *role* inside the club (Leader, Scout, Archivist, Curator, Collector, Recruiter, Loyalist, Supporter, Broadcaster, Specialist). [Wrapped Clubs overview](https://newsroom.spotify.com/2025-12-03/wrapped-clubs-overview/)
- **Narrative/temporal stories**: Top Artist Sprint — how your top-5 artist rankings shifted *month by month*; Listening Archive — AI-generated snapshots of your most memorable streaming *days* (up to 5 daily reports). [2025 Wrapped user experience](https://newsroom.spotify.com/2025-12-03/2025-wrapped-user-experience/)
- **Interactive**: Top Song Quiz, Wrapped Party (live multiplayer competition). [ibid.]
- **Sharing**: every data story renders a "share card" — tap share → send via Spotify Messages or post to socials. The Wrapped feed is a hub to revisit stories + "best of" playlists. [ibid.]
- **Methodology transparency**: stories pick the metric that fits the narrative (songs by play count, artists by *weighted* stream count, albums by coverage-adjusted score); eligibility floor (30 songs × 30s, 5 artists); window Jan 1 → mid-Nov. [Wrapped methodology](https://newsroom.spotify.com/2025-12-05/wrapped-methodology-explained/)

**What makes it feel like Wrapped vs. a dashboard:** (a) personality/superlative framing — you're *a* Leader in *a* club, not "rank 3 of 6"; (b) narrative copy written for you; (c) one stat per "card"/story beat; (d) temporal stories (month-by-month shift, biggest day); (e) shareable visuals per story.

## 2. Current Trip Wrapped implementation

- `server/wrapped.ts` — pure read: `collectStats` (rows → `TripStats`, wrapped.ts:44-99) → `buildAwards` (~20 award candidates, wrapped.ts:163-228) → `pick` (everyone gets one before anyone gets two, cap 7, wrapped.ts:145-161). `funBoard(rows)` returns `{ awards }` (wrapped.ts:230-242); `journeyBoard(jr)` merges member stats onto person keys (wrapped.ts:244+).
- Stats already collected (zero new aggregation needed): `totalSpend`, `nExp`, per-member paid/consumed/payerCount/partCount, `catShare`/`catTotal` (per-category), `pairShare`/`tripleShare`/`settlePair`, `currencies` (per member), `biggestExp`, `createdCount`, `typedCount`, `biggestShare`, `owed`.
- Wire shape: `FunBoard = { awards: Award[] }`, `Award = { emoji, title, members, detail }` (`shared/wire.ts:42-43`). `TripView.fun` carries it (`wire.ts:94`); Journey `fun` the same.
- Render: `client/ui/Awards.tsx` — a list of award rows (emoji + title + members + detail). Called from the fun tab in trip/view.tsx and journey/view.tsx.
- Gating: `wrappedLive` — `fun_leaderboard && (end_date EOD || created_at + 5d)` (trip/view.tsx ~line 117-120); journey uses server-provided `wrapped_at`.

## 3. Recommended incorporation: a "Review" section inside the Wrapped tab

Not a new feature — the *same* fun tab, two stacked layers, matching Spotify's "stat stories → personality stories" sequence:

```
🎁 Trip Wrapped
┌─ THE NUMBERS (new) ──────────────┐
│ total spend · N expenses · N    │
│ currencies · biggest single     │
│ expense · top category          │
├─ per-member rows ────────────────┤
│ Alice: spent X · covered Y ·    │
│        in on N splits           │
└─ awards (existing) ──────────────┘
   🍽️ MVP · Most Voracious Person…
```

Spotify's own order mirrors this: factual data stories first, then personality/club assignments. Our awards already *are* the personality layer (Chief IOU Officer ≈ a Club + Role).

### Stats feasible with **zero new aggregation** (all in `TripStats`/`TripRows`)

| Wrapped story | Our analog | Data source |
|---|---|---|
| Minutes Listened | **Total spend** (settle ccy) + expense count | `st.totalSpend`, `st.nExp` |
| Top Genres | **Category breakdown** — top categories by spend with % bar | `st.catTotal` + `CATEGORIES` emojis |
| Top Artists | **Per-member spend line** — consumed per member | `st.consumed` |
| Fan Leaderboard | **Coverage** — "X fronted Y% of the trip" | `st.paid` / `totalSpend` |
| Top Artist Sprint (monthly) | **Daily spend timeline** — sparkline of spend per `recorded_at` day | `rows.expenses[].recorded_at` × rate |
| Listening Archive (big day) | **Biggest day** — max per-day spend, formatted | same timeline, argmax |
| Clubs + roles | **Existing awards** — no change needed | `buildAwards` |
| Share cards | **skip** (no image infra); optional: copy-to-clipboard text recap via existing `CopyButton` | n/a |
| Listening Age / Quiz / Party | **skip** — no analog or not worth it | n/a |

### Smallest viable version
Add a `review` object to `FunBoard` (wire) computed in `funBoard`/`journeyBoard` from `TripStats` + rows:

```ts
review: {
  total: string;            // formatted settle units
  expenseCount: number;
  currencies: string[];     // union of st.currencies
  biggest: { name: string; total: string } | null;   // biggest expense by name
  biggestDay: { date: string; total: string } | null; // needs per-day aggregation — new
  categories: { cat: string; units: number }[];      // top 4, sorted desc
  members: { name: string; consumed: string; covered: string; count: number }[];
  daily: { day: string; units: number }[];           // sparkline input — new
}
```

New aggregation needed: **per-day totals** (one pass over expenses, ~10 lines in `collectStats` — `day: recorded_at.slice(0,10)` bucketed by effective rate). Everything else reuses existing fields.

Render: extend `Awards.tsx` to take `{ review }` — a stat card + category bars + tiny sparkline (SVG, Pie already exists in expense/view.tsx as precedent) + per-member lines, then the existing award list below.

### Extension (later, if wanted)
- **Recap copy button**: "Trip in Review — Alice fronted $1,240 across 14 expenses 🍾" via `CopyButton` (exists, `client/ui/CopyButton.tsx`).
- **Per-member "your wrapped"**: filter the review to `me` when the viewer claimed a member — closer to Spotify's personalization; cheap since stats are already per-member.

## 4. Files that change for v1

| File | Change |
|---|---|
| `shared/wire.ts` | `FunBoard` gains `review` |
| `server/wrapped.ts` | `collectStats` adds `daily` bucket; `funBoard`/`journeyBoard` emit `review` |
| `client/ui/Awards.tsx` | render review section above awards |
| `test/app.ts` or `test/smoke.ts` | pin `review` presence + one stat (e.g. totalSpend) |
