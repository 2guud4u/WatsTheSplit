# Access by Trip Link; Google sign-in is optional

Anyone with a Trip's link (or QR code) can open it, create Trips, add Expenses, and pick who they are, all without signing in, because joining has to be "as easy as possible" for friends on a trip. The trust model rests on that. A Claimed Member (picked without signing in) can be picked by anyone else with the link, and the app tells people this so they're nudged to sign in. A Linked Member is tied to a Google account and only that account can act as them. An optional Trip Password protects against a leaked link. Changing it makes every device re-enter it, except Linked Members.

## Considered Options

- **Sign-in required for everyone:** better identity, but friends who never sign up can't be included, and joining gets slower.
- **Per-Placeholder invite links:** no wrong claims, but the creator has to send a link to each person.

## Consequences

- Do not "fix" this by adding a sign-in wall; that undoes the main product decision.
- Edits are attributed to a Member, not to a verified person, unless that Member is Linked.
