# Journey balances are summed direct debts in one currency

A Journey's "who owes who" used to net everyone's position, convert it at today's rate into a separately chosen Journey Currency, and simplify to the fewest payments. That made it impossible to mark a journey debt as paid trip by trip: a simplified "Dave pays Bob" may have no trip behind it, and a converted total doesn't match any trip's numbers. We now require every Trip in a Journey to share one Settlement Currency (which becomes the Journey's), and each journey card is the sum of the two people's own pairwise debts from each trip. Marking paid records one Settlement per chosen trip, so trip balances stay the source of truth and undo is just deleting that trip's payment.

## Considered Options

- **Keep simplified, converted totals**: fewer payments, but they can't be split back into trips, and exchange rate drift leaves leftover amounts.
- **Convert per-trip pieces at today's rate**: allows mixed currencies, but the recorded payments never exactly zero out the trips.

## Consequences

- A Journey may show more cards than the old simplified view (no "pay a friend of a friend" shortcuts).
- Trips settling in a different currency can't join the Journey; Settlement Currency is fixed at trip creation, so the rule can't be broken later.
- `journeys.settle_currency` is still stored, but is set from the first trip, not chosen.
