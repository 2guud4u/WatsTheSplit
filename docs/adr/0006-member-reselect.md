# Members can re-claim a different name; signed-in claims move the link

## Status
accepted

## Context

Claiming a Member was a one-way pick: the `claims` table is `(session, trip) → member`, so a device that picked the wrong name had no way out. Signed-in users were harder-blocked — `POST /api/trips/:trip/claim` rejected a second member with `already_linked_other_member` to preserve "one Linked Member per account per trip". Picking the wrong person was unrecoverable without a second device or clearing cookies.

## Decision

Re-claiming is allowed at every layer:

- The claim endpoint already used `INSERT OR REPLACE`, so an anonymous session's claim moves to the new member; the UI now exposes it.
- When a signed-in session claims a *different* member, the account link **moves**: the old member's `user_sub` is cleared and the new member's is set. "One Linked Member per account per trip" still holds — the link relocates rather than duplicates.
- A member linked to a *different* account stays unclaimable (`member_linked`), and reselect confirms first: leaving a `used` member warns that its expenses and settlements keep the old attribution; unsaved form input is discarded.

## Considered options

- **Claims only, links stay put**: a signed-in user couldn't switch without signing out — the wrong-person case mostly hits signed-in trip owners too, so it doesn't solve the problem.
- **Session-level override**: let a session claim one member while the account stays linked to another, with `myMember` preferring the claim. Two identity sources for one session; every consumer would need a rule for which wins. Moving the link keeps `myMember`'s linked-first resolution unchanged.
- **Block reselect on `used` members**: safest for attribution, but the wrong-person case often discovers itself exactly *after* expenses exist; a warning preserves the escape hatch.

## Consequences

- `already_linked_other_member` is gone from the wire contract and error copy.
- Switching mid-trip is per-trip and per-session; a signed-in user's linked member now follows their latest claim on that trip.
- Expenses attributed to a member never move — history stays under the name it was recorded with.
