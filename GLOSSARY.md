# WatsTheSplit

Splitting shared costs among friends on a trip, where each expense is converted at the exchange rate in effect when it was recorded.

## Trip and people

**Trip**:
A named, dated group of people who share costs, with one Trip Currency and one Settlement Currency.
_Avoid_: Group, event

**Journey**:
A named group of Trips that share one "who owes who" view. Every Trip in it has the same Settlement Currency, which is also the Journey's. Reachable from inside any member Trip; a Trip belongs to at most one Journey.
_Avoid_: Folder, collection

**Journey Link**:
A shareable link that opens a Journey. Whoever opens it becomes a Journey Viewer: they can read every member Trip and pick a Member name (or add one) in any of them, which upgrades them to full member access for that Trip.
_Avoid_: Journey invite, share link

**Journey Viewer**:
A session that opened a Journey Link but hasn't joined any member Trip. Read-only until they claim a Member; claiming grants them edit access to that Trip without its Trip Password.
_Avoid_: Guest, spectator

**Person**:
A real human across the Trips in a Journey: Members with the same signed-in account count as one Person, and unlinked Members can be merged into one manually.
_Avoid_: User, identity

**Member**:
A named person in a Trip. A Member is a Placeholder Member, a Claimed Member, or a Linked Member.
_Avoid_: User, friend, participant (when meaning Trip membership)

**Placeholder Member**:
A Member that no one has claimed yet: just a name added so Expenses can include them.
_Avoid_: Ghost, guest, dummy user

**Claimed Member**:
A Member someone has picked as "me" on a device without signing in; anyone else with the Trip Link can still pick them.
_Avoid_: Guest, anonymous user

**Linked Member**:
A Member tied to a signed-in account (email-code sign-in); only that account can act as them.
_Avoid_: Registered user, verified member

**Trip Link**:
A shareable link (also shown as a QR code) that opens a Trip; it is the only thing needed to get in, and signing in is optional.
_Avoid_: Invite link, join code, invitation

**Trip Password**:
A required password on a Trip; anyone opening the Trip Link must enter it once per device (the share link carries it as ?pw= for seamless join). Linked Members don't need it.
_Avoid_: PIN, passcode

## Money

**Trip Currency**:
The currency preselected for new Expenses on a Trip; each Expense can still use a different one.
_Avoid_: Default currency, local currency

**Settlement Currency**:
The currency all Balances and Settlements on a Trip are shown in. A Journey uses the shared Settlement Currency of its Trips.
_Avoid_: Group currency, home currency, base currency, journey currency

**Locked Rate**:
The exchange rate from an Expense's currency to the Settlement Currency, taken when the Expense is created and taken again only if its currency changes. The Balance Details modal shows it trimmed to 2 significant figures (the stored value is always full precision).
_Avoid_: Live rate, current rate

## Expenses

**Expense**:
A single cost paid by one Payer on behalf of some Participants, with a name, currency, and Total.
_Avoid_: Bill, transaction, expense report

**Payer**:
The one Member who paid an Expense.
_Avoid_: Owner, creditor

**Participant**:
A Member included in an Expense, who may owe a Share of it.
_Avoid_: Party, debtor

**Total**:
The full amount the Payer paid for an Expense, in the Expense's currency.
_Avoid_: Price, amount

**Share**:
The part of an Expense's Total that one Participant owes.
_Avoid_: Portion, cut, owed amount

**Equal Share**:
A Participant with no explicit Share takes an equal part of whatever is left after fixed Shares and Items — the default when someone is added to an Expense.

**Unassigned Amount**:
The part of an Expense's Total that isn't covered by any Share yet.
_Avoid_: Remainder, missing amount

**Item**:
One line of an itemized Expense, with a name, a price, and the Participants who split it equally.
_Avoid_: Line item, entry

**Paid**:
A Participant's Share marked as reimbursed — by the Payer or by the Participant themself. A Paid Share doesn't count toward Balances.
_Avoid_: Reimbursed share, settled share

**Paid Out**:
An Expense whose Shares are all Paid; it contributes nothing to Balances.
_Avoid_: Settled expense, closed, done

## Owing

**Balance**:
The net amount one Member owes another across the whole Trip, in the Settlement Currency.
_Avoid_: Debt, total owed

**Settlement**:
A recorded payment from one Member to another that reduces their Balance.
_Avoid_: Settle-up, repayment, transfer

**Payment Method**:
A Member's "how to pay me" — a set of optional ways (phone number, Venmo handle, Cash App) that others in the trip use to send a Settlement. Anyone can set it without signing in. A Linked Member's lives on their signed-in account, shared across every trip they join; an Unlinked Member's lives on their own Member, per trip, and is promoted to the account when they sign in.
_Avoid_: Payment info, contact, Venmo, bank info, pay me

## Wrapped

**Trip Wrapped**:
A Trip's end-of-trip recap: silly awards (🎁) plus a stats review, computed from its Expenses, Shares, and Settlements. Enabling it requires an end date on the Trip — the recap unlocks at the end of that day. With Wrapped enabled, the person who created an Expense is prompted to pick a category for it (they can skip). A Journey has a Journey Wrapped, merged across its member Trips and unlocked at the last member Trip's end date.
_Avoid_: Fun board, leaderboard

**Trip in Review**:
The swipeable card-story presentation of a Trip Wrapped: one stat or award per card, opened from the 🎁 prompt or replayed from the Wrapped tab.
_Avoid_: Story, carousel

## Interface

**Snack**:
A brief, transient confirmation that appears at the bottom of the screen and fades on its own (or is dismissed by tapping); a successful action shows a green dot, a failed one a red one.
_Avoid_: Toast, notification, pop-up

## Change log

**Change**:
One record of what happened to an Expense or Settlement: created, deleted, or a single field edited (name, amount, payer, share, item, etc.), who did it, and when.
_Avoid_: Edit, entry, log line

**History**:
A Trip's full list of every Change, shown newest first in the History tab — all Expenses and Settlements, not just one.
_Avoid_: Activity feed, audit log
