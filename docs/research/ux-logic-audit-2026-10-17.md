# UX / UI / logic audit — 2026-10-17

Method: fresh instance (`DB_PATH=/tmp/wts-audit/audit.db PORT=3998 FX_OFFLINE=1`), scenarios driven through the real UI in headless Chromium plus scripted API calls with separate cookie jars per "person". Sources are the app itself; every finding below was observed, not inferred.

## Fixed in this pass

| # | Finding | Fix |
|---|---|---|
| 1 | Journey "Who owes you / Who you owe" used plain `X pays Y` rows; trip used avatar owe-cards. Same concept, two looks. | Shared `client/OweCard.tsx` (`Avatar`, `OweCard`, `memberName`). Trip passes `onConfirm`/`onDetails`; journey passes neither (settling happens inside trips). |
| 2 | Expense page for a view-only visitor showed live inputs, **Delete expense**, item ✕, photo ✕ — all failed with 401 on click. | Edit body wrapped in `<fieldset disabled={readOnly}>`; Delete hidden unless `access === "edit"`. |
| 3 | View-only banner said "add yourself on the journey page" — wrong when the visitor came in from the trip. | Banner links to the trip: "pick your name on the trip to edit". |
| 4 | Trip page for a viewer still showed **✓ confirm paid**, settlement ✕, and **Record a custom payment**. | Hidden when `readOnly`. |
| 5 | Trip viewer with no Member saw "Nobody owes you" (false: they're nobody), while the journey said "showing everything". | Trip now matches journey: "You haven't picked your name yet — showing everyone's balances" + all pairs. |
| 6 | "Recorded payments" only listed under **Who owes you**; a payer on **Who you owe** couldn't see payments they'd made. | Listed under both tabs. |

## Verified working (scenario → result)

| Scenario | Result |
|---|---|
| Create trip → claim own name → add expense → lands on expense page, split equal by default | PASS |
| JPY expense with FX offline | `no_rate_count=1`, excluded from balances, warning shown |
| Shares summing past total | `over: true`, "over by" badge |
| Delete a Member used in an expense | 400 `member_in_use` |
| New device: no password / wrong / right | 401 / 403 / 200 `access: edit` |
| Record settlement then delete it | balances return to the pre-settlement state |
| Stranger opens journey link | join screen → trips list with `view only` + member chips |
| Journey viewer tries PATCH/DELETE expense, settlement, add member | all 401 |
| Journey viewer claims a Member | trip flips to `access: edit`, expense POST 200 |
| Journey "Who you owe" vs trip "Who you owe" for the same person | same card, same amount |
| Home after opening a journey | listed under **My journeys** |
| UI copy vs GLOSSARY `_Avoid_` terms | none found |

## Open — decisions for you (not changed)

1. **Creator must pick their own name right after creating a trip.** One extra step; the creator was already asked for member names. Option: auto-claim the first name entered, or add a "This is me" toggle on the member pills.
2. **Anonymous claims can be taken over** (S5): any device with the link can pick a Claimed Member. Documented in GLOSSARY ("anyone else with the Trip Link can still pick them") and nudged by the "not signed in" hint — consistent, but surprising for users who skip the hint.
3. **Currency pickers start empty** on trip creation. Explicit, but most trips use the same currency for both; could default Settlement Currency to Trip Currency once picked.
4. **Journey links bypass trip passwords for reading** (ADR 0004). No revocation UI yet.
