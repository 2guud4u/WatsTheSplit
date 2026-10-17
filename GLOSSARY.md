# WatsTheSplit

Splitting shared costs among friends on a trip, where each expense is converted at the exchange rate in effect when it was recorded.

## Trip and people

**Trip**:
A named, dated group of people who share costs, with one Trip Currency and one Settlement Currency.
_Avoid_: Group, event

**Journey**:
A named group of Trips that share one "who owes who" view, in a Journey Currency. Reachable from inside any member Trip; a Trip belongs to at most one Journey.
_Avoid_: Folder, collection

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
The currency all Balances and Settlements on a Trip are shown in.
_Avoid_: Group currency, home currency, base currency

**Journey Currency**:
The currency a Journey's shared Balance is shown in.
_Avoid_: Group currency

**Locked Rate**:
The exchange rate from an Expense's currency to the Settlement Currency, taken when the Expense is created and taken again only if its currency changes.
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

**Paid Out**:
An Expense the Payer marked as fully reimbursed; its Shares don't count toward Balances until unmarked.
_Avoid_: Settled expense, closed, done

## Owing

**Balance**:
The net amount one Member owes another across the whole Trip, in the Settlement Currency.
_Avoid_: Debt, total owed

**Settlement**:
A recorded payment from one Member to another that reduces their Balance.
_Avoid_: Settle-up, repayment, transfer
