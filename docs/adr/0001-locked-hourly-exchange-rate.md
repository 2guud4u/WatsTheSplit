# Locked hourly exchange rate from Open Exchange Rates' free tier

Each Expense locks its exchange rate when it is created, and gets a new one only if its currency changes. The rate comes from the server's latest hourly snapshot, fetched from Open Exchange Rates' free tier with USD as the base. Every free source we found updates daily or hourly, and per-minute rates cost about $40–100/mo ([research](../research/fx-rates-and-google-auth.md)). So "the rate at the exact time" means the newest hourly rate, up to about an hour old. Each Expense stores the rate, the provider's timestamp, and the time it was recorded, so the actual age of the rate stays visible. If the provider is down or out of quota, the last snapshot is used, so creating an Expense never fails because of exchange rates.

## Considered Options

- **Frankfurter (ECB):** no key, unlimited and free, but only one rate per day.
- **currencyapi paid (~$40/mo):** a true per-minute rate and point-in-time lookups, but not worth a subscription for a friends app.

## Consequences

- Fetching with a USD base gives every pair through cross rates (rate from USD to the target ÷ rate from USD to the source).
- Hourly fetching uses about 730 of the 1,000 free requests per month, so the remaining margin is small.
- The free tier's commercial-use terms are UNVERIFIED, so revisit this if the app is ever offered publicly.

- **Scraping Google/Yahoo for a "live" rate:** rejected. Undocumented endpoints break silently and violate ToS (rate limits, CAPTCHAs, IP bans), and a scraped number carries no trustworthy "as-of" time — which is the whole point of the feature. The ≤1h staleness on a documented rate is worth less than the bank spread no provider can see anyway.
