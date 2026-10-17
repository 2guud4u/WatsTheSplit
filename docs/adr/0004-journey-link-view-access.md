# Journey links grant read access to member trips

## Status
accepted

## Context

A Journey groups Trips for a shared "who owes who" view. Before this decision, opening a Journey required already having access to one member Trip (`journeyAccess` just checked `hasAccess` on some member trip), so the Journey could only be shared by re-sharing each Trip Link separately.

## Decision

Opening a Journey Link records a grant (`journey_access` row keyed by session) that gives **read access to the Journey and every member Trip**, bypassing each Trip's password. A Journey Viewer can then claim a Member name (or add a new one) in any member Trip; a successful claim writes a `consents` row at the current `password_ver`, upgrading that session to full edit access for that Trip — without ever typing the Trip Password.

Access is two-tiered: `openTripView` (read; trip access OR journey grant) vs `openTrip`/`withTrip` (edit; trip access only). Mutations and settings stay behind edit access. Trip payloads carry `access: "edit" | "view"` and omit `password` for viewers.

## Considered options

- **Journey page only, trips stay gated**: smallest change, but the feature request was explicitly "view the trips and add themselves" — gating trips defeats it.
- **Journey link grants full edit access**: simpler, but then anyone with the journey link can edit expenses in every trip; the view-then-claim step preserves trip boundaries and lets members pick their name per trip.

## Consequences

- Journey links are powerful: they bypass trip passwords for reading. Keep them private; there is no revocation UI yet.
- Claiming remains the only upgrade path, so "who's in the trip" stays a real member list.
- `journey_access` is per-session (device cookie); a signed-in user gets the same grant on each device.
