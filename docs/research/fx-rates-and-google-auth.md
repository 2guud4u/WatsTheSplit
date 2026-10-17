# Research: FX rate sources, Google sign-in, realtime sync

Checked: 2026-10-15 to 2026-10-16 (UTC). Pricing and limits change often, so re-check them before you commit. Entries marked **UNVERIFIED** could not be confirmed from a primary source. Entries marked "(live check)" come from an unauthenticated API call made on the check date.

---

## 1. FX rate sources for "rate at the moment the expense is recorded"

### 1.1 Per-provider findings

**Frankfurter (open source; ECB plus other central banks)**
- Data: 223 currencies from 104 central banks and official sources. "Rates update daily and go back to 1948." No API key is required. [frankfurter.dev](https://frankfurter.dev/)
- Almost all series are daily. Weekly, monthly, and quarterly sources are left out of the blended feed. The API "isn't built for live trading". [frankfurter.dev FAQ](https://frankfurter.dev/)
- Limits: "There are no quotas." Requests are rate-limited only to prevent abuse. Blended rates are free for commercial use. Querying an individual provider's endpoint directly is subject to that provider's terms. You can self-host. [frankfurter.dev FAQ](https://frankfurter.dev/), [license](https://frankfurter.dev/license/)
- Base currency: any, via `?base=`. [frankfurter.dev](https://frankfurter.dev/)
- Historical data: one rate per date (`?date=YYYY-MM-DD`). There is no intraday data. [frankfurter.dev](https://frankfurter.dev/)
- Timestamp: responses carry a `date` field only, with no time of day (live check: `GET https://api.frankfurter.dev/v2/rates?base=EUR&quotes=VND,TWD,JPY,THB` returned `{"date":"2026-10-16",...}`).
- Coverage: JPY, THB, TWD and VND were returned by the live check above. `/v2/currencies` returned 165 entries in the default scope (live check). The site says 223 including legacy currencies (`scope=all`). [frankfurter.dev](https://frankfurter.dev/)
- The underlying ECB reference rates are published "around 16:00 CET every working day", reflect the 14:10 to 14:15 CET concertation, are "for information purposes only", and cover about 30 currencies (USD, JPY, GBP, KRW, MXN, IDR and THB are included; VND and TWD are not). [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)

**exchangerate.host (APILayer)**
- Free tier: 100 requests per month, daily updates, historical rates, non-commercial use only. The source-currency switch is paid only. [pricing](https://exchangerate.host/pricing)
- Paid tiers: Basic is $14.99/mo, hourly updates, commercial use. Professional Plus is $59.99/mo with 10-minute updates. Business is $99.99/mo with 60-second updates. [pricing](https://exchangerate.host/pricing)
- A key is required. A keyless call returns `missing_access_key` (live check, `api.exchangerate.host/latest`).
- Historical data is end-of-day only, "time stamped at one second before midnight". [pricing FAQ](https://exchangerate.host/pricing)
- Coverage: "168 world currencies". [APILayer docs](https://docs.apilayer.com/exchangerate/docs/api-documentation). Per-currency coverage of VND, TWD, etc. is **UNVERIFIED** (no keyless list available).
- Whether `/live` responses carry a timestamp field: **UNVERIFIED** (the docs page is JS-rendered and could not be read).

**Open Exchange Rates**
- Free tier: hourly updates, USD base only, 1,000 requests per month. [pricing](https://openexchangerates.org/signup)
- Paid tiers: Developer is $12/mo, hourly, 10k requests, any base. Enterprise is $47/mo with 30-minute updates. Unlimited is $97/mo with 5-minute updates. "VIP" tiers offer updates down to 1 second and intraday history. [pricing](https://openexchangerates.org/signup)
- An App ID (key) is required. [historical docs](https://docs.openexchangerates.org/reference/historical-json)
- Historical data: "the last values we published for a given UTC day". Changing the base or symbols requires Developer or higher. [historical docs](https://docs.openexchangerates.org/reference/historical-json)
- Timestamp: the response includes `timestamp`, the UNIX time "the rates were published". [historical docs](https://docs.openexchangerates.org/reference/historical-json)
- Coverage: `currencies.json` returned 173 codes, including all nine travel currencies listed in the table below (live check, `openexchangerates.org/api/currencies.json`).
- Commercial terms on the free plan: **UNVERIFIED** (terms page at [openexchangerates.org/terms](https://openexchangerates.org/terms) not reviewed).

**ExchangeRate-API**
- Open-access endpoint: no key, attribution required, updates once per day, rate-limited, caching allowed. Personal or commercial use is allowed, but redistribution is not. [docs/free](https://www.exchangerate-api.com/docs/free)
- Free keyed plan: 1.5k requests per month, daily updates. Pro is $10/mo with 60-minute updates and 30k requests. Business is $30/mo with 5-minute updates. [homepage pricing](https://www.exchangerate-api.com/)
- Historical data: daily ("one indicative mid-rate for each calendar day"), paid plans only. [historical docs](https://www.exchangerate-api.com/docs/historical-data-requests)
- Timestamp: `time_last_update_unix` and `time_last_update_utc`, plus `time_next_update_*`. [docs/free](https://www.exchangerate-api.com/docs/free)
- Base currency: any, via the URL path. [docs/free](https://www.exchangerate-api.com/docs/free)
- Coverage: the site says 161 to 165 currencies. [homepage](https://www.exchangerate-api.com/). The open endpoint returned 166 codes including JPY, THB, MXN, GBP, KRW, VND, IDR and TWD, last updated `Fri, 16 Oct 2026 00:02:31 +0000` (live check, `open.er-api.com/v6/latest/EUR`).

**Fixer (APILayer)**
- Free tier: 100 calls per month, hourly updates, historical data, non-commercial use. "All Base Currencies" is listed only on paid plans. [pricing](https://fixer.io/pricing)
- Paid tiers: Basic is $14.99/mo, hourly. Professional is $59.99/mo, 10-minute. Professional Plus is $99.99/mo, 60-second. [pricing](https://fixer.io/pricing)
- Historical data is end-of-day, "time stamped at one second before midnight". 170 currencies. [FAQ](https://fixer.io/faq)
- A key is required (live check: keyless call returns `missing_access_key`).
- Which base the free plan is restricted to (EUR is widely reported): **UNVERIFIED**.

**currencyapi.com**
- Free tier: 300 requests per month, 10 per minute, daily updates, personal (non-commercial) use. No `/convert` or `/range`. A key is required. [agents.md](https://currencyapi.com/agents.md), [plans JSON](https://api.currencyapi.com/v1/agent/plans)
- Paid tiers: small is $9.99/mo, hourly, commercial use. medium is $39.99/mo with minute updates. [plans JSON](https://api.currencyapi.com/v1/agent/plans)
- Timestamp: responses include `meta.last_updated_at` as an ISO datetime. Intraday lookup by `datetime` is possible "at the rate of the minute, quarter hour or hour the moment falls in", but needs a plan with intraday updates. [llms-full.txt](https://currencyapi.com/docs/llms-full.txt)
- Base currency: `base_currency` works on the free plan, per the agent docs example. [agents.md](https://currencyapi.com/agents.md)
- Coverage count and per-currency coverage: **UNVERIFIED** (list at [currency-list](https://currencyapi.com/docs/currency-list/) not counted).

**CurrencyFreaks**
- Free ("Developer") tier: 1,000 calls per month, 24-hour updates, USD base only. Historical data is listed on paid plans only. [pricing](https://currencyfreaks.com/pricing)
- Paid tiers: Starter is $9.99/mo, hourly. Growth is $49.99/mo, 10-minute. Professional is $99.99/mo, 60-second. [pricing](https://currencyfreaks.com/pricing)
- Timestamp: `date` is a datetime such as `"2026-08-25 12:43:00+00"`. A key is required. [documentation](https://currencyfreaks.com/documentation)
- Coverage: the docs say "1000+ currencies", including crypto. `currency-symbols` returned 1,019 entries including all nine travel currencies (live check).
- Commercial terms on the free plan: **UNVERIFIED**.

**Wise API**
- `GET /rates` supports `time=<ISO timestamp>` for a historic point and `group=day|hour|minute` history. The response `time` field is "Timestamp for exchange rate". [Wise rates reference](https://docs.wise.com/api-reference/rate/rateget.md)
- Access requires a partner OAuth agreement with mTLS, or a personal API token from a Wise **business** account. [Wise auth docs](https://docs.wise.com/guides/developer/auth-and-security). It is not a public keyless API.
- Request limits and terms for using rates in a third-party app: **UNVERIFIED**.

**Google Finance**
- No official public Google Finance FX API was found in Google developer documentation: **UNVERIFIED** (absence not provable). Google Sheets `GOOGLEFINANCE` is a spreadsheet function, not an app API. Its terms were not reviewed.

**Other: central bank official feeds via currencyapi `/v3/official`**
- currencyapi lists official rates from 35 central banks. [llms.txt](https://currencyapi.com/docs/llms.txt). These are daily fixings, like ECB.

### 1.2 Comparison table

| Provider | Key needed | Free update freq | Fastest paid freq | Free req limit | Free commercial use | Free base restriction | Historical granularity | Timestamp in response | Travel set JPY/THB/MXN/EUR/GBP/KRW/VND/IDR/TWD |
|---|---|---|---|---|---|---|---|---|---|
| [Frankfurter](https://frankfurter.dev/) | No | Daily | n/a (free only) | No quota | Yes (blended) | Any base | Daily | `date` only | Yes for JPY/THB/TWD/VND (live check). Others included in ECB set ([ECB](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)) |
| [exchangerate.host](https://exchangerate.host/pricing) | Yes | Daily | 60 s | 100/mo | No | No source switch | EOD (23:59:59 stamp) | UNVERIFIED | UNVERIFIED |
| [Open Exchange Rates](https://openexchangerates.org/signup) | Yes | Hourly | 5 min (1 s VIP) | 1,000/mo | UNVERIFIED | USD only | EOD per UTC day (intraday on VIP) | `timestamp` (UNIX) | Yes (live check) |
| [ExchangeRate-API](https://www.exchangerate-api.com/docs/free) | No (open) / Yes (free key) | Daily | 5 min | Open: rate-limited; key: 1.5k/mo | Yes (open, with attribution) | Any base | Daily, paid only | `time_last_update_unix` | Yes (live check) |
| [Fixer](https://fixer.io/pricing) | Yes | Hourly | 60 s | 100/mo | No | Paid-only "All Base Currencies" | EOD (23:59:59 stamp) | UNVERIFIED | UNVERIFIED |
| [currencyapi](https://api.currencyapi.com/v1/agent/plans) | Yes | Daily | Minutely | 300/mo, 10/min | No | Any base | Daily; minute/hour via `datetime` on paid | `meta.last_updated_at` | UNVERIFIED |
| [CurrencyFreaks](https://currencyfreaks.com/pricing) | Yes | 24 h | 60 s | 1,000/mo | UNVERIFIED | USD only | Daily, paid only | `date` datetime | Yes (live check) |
| [Wise](https://docs.wise.com/api-reference/rate/rateget.md) | Partner/business token | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Any pair | Minute/hour/day + point-in-time | `time` | UNVERIFIED |

### 1.3 What "exact time" realistically means

- **Free tiers do not give a rate for the minute of the expense.** Every free option is daily (Frankfurter, ExchangeRate-API, exchangerate.host, currencyapi, CurrencyFreaks) or at best hourly (Open Exchange Rates, Fixer). See the sources above. A rate fetched "now" on a free tier can be up to roughly 24 h old, or about 1 h old on OXR/Fixer free.
- Sub-hour freshness requires a paid plan. The cheapest documented options are: OXR $47/mo for 30 min and $97/mo for 5 min; ExchangeRate-API $30/mo for 5 min; currencyapi $39.99/mo for minutely; and Fixer, exchangerate.host and CurrencyFreaks at about $99.99/mo for 60 s. [OXR](https://openexchangerates.org/signup), [ERA](https://www.exchangerate-api.com/), [currencyapi](https://api.currencyapi.com/v1/agent/plans), [Fixer](https://fixer.io/pricing), [exchangerate.host](https://exchangerate.host/pricing), [CurrencyFreaks](https://currencyfreaks.com/pricing)
- Backfilling an intraday rate for an expense entered later is only documented for currencyapi paid plans (`datetime`), Wise (`time`), and OXR VIP. Everyone else returns one rate per day. Sources are in 1.1.
- All providers above publish **indicative mid-market or reference rates**, not the rate a card or exchange booth actually charged. [ExchangeRate-API](https://www.exchangerate-api.com/), [Frankfurter](https://frankfurter.dev/), [ECB](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
- **What this implies for storage:** store a snapshot with each expense. Because the rate's own validity time can differ from the recording time by hours, keep both:
  - the rate value
  - the base and quote
  - the provider
  - the provider's timestamp (`timestamp`, `time_last_update_unix`, `last_updated_at`, or `date`; these fields are cited above)
  - your own recorded-at time

  Frankfurter's `date`-only field gives day-level provenance at best. (The field choice is a factual consequence of the response formats, not a recommendation.)

---

## 2. Google sign-in options

### 2.1 Findings

**Firebase Authentication**
- Spark (no-cost) plan includes Authentication. With Identity Platform, 50K MAUs are no-cost. Phone auth is billed per SMS on Blaze only. [Firebase pricing](https://firebase.google.com/pricing)
- Google sign-in on the web uses the Firebase SDK's popup or redirect flow, or a Sign In With Google ID token passed to Firebase. You enable the provider in the console. [Firebase web Google sign-in](https://firebase.google.com/docs/auth/web/google-signin)
- iOS and Android SDKs exist ([iOS guide](https://firebase.google.com/docs/auth/ios/google-signin), [Android guide](https://firebase.google.com/docs/auth/android/google-signin)). The details of those pages were not re-read: **UNVERIFIED**. Expo/React Native support (for example via the community `@react-native-firebase`): **UNVERIFIED**.
- Bundled backend: Firestore. Its free quota is 1 GiB stored, 50K reads/day, 20K writes/day, 20K deletes/day and 10 GiB/month egress. [Firestore quotas](https://firebase.google.com/docs/firestore/quotas)

**Supabase Auth**
- Free plan: 50,000 MAU, 500 MB Postgres database, 2 active projects. Projects pause after 1 week of inactivity. [Supabase pricing](https://supabase.com/pricing)
- Google sign-in is supported on the web, in native Android, iOS and macOS apps, in Chrome extensions, and documented for Expo React Native, Flutter, Swift and Kotlin. [Supabase Google guide](https://supabase.com/docs/guides/auth/social-login/auth-google.md)
- Bundled backend: Postgres, plus Storage, Realtime and Edge Functions. [Supabase pricing](https://supabase.com/pricing)

**Auth.js (NextAuth)**
- Open-source library. Google provider setup needs `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` and a callback such as `/api/auth/callback/google`. Documented frameworks are Next.js, Qwik, SvelteKit and Express. [Auth.js Google provider](https://authjs.dev/getting-started/providers/google)
- No database is bundled. It provides adapters (Prisma, Drizzle, Supabase, Firestore, etc.). The site states the project "is now part of Better Auth". [Auth.js docs](https://authjs.dev/getting-started/providers/google)
- No hosted service, so there are no MAU fees (inferred from it being a library). A native iOS/Android/Expo SDK was not found: **UNVERIFIED**.

**Clerk**
- Hobby (free) plan: 50,000 monthly retained users per app, up to 3 social connections, fixed 7-day sessions, Clerk branding. Pro is $25/mo. [Clerk pricing](https://clerk.com/pricing)
- Expo is supported (hosted auth works in Expo Go; native components are in beta). [Clerk Expo quickstart](https://clerk.com/docs/expo/getting-started/quickstart)
- No database is bundled, though there is user metadata storage. [Clerk pricing](https://clerk.com/pricing)

**Direct Google Identity Services (Sign in with Google)**
- Web: personalized button, One Tap and automatic sign-in. Authentication returns ID tokens only. Authorization (access tokens) is a separate API. [GIS overview](https://developers.google.com/identity/gsi/web/guides/overview)
- Google does not list a price for sign-in itself: **UNVERIFIED**. You need your own backend to verify ID tokens and store users (inferred from ID-token-only output, [GIS overview](https://developers.google.com/identity/gsi/web/guides/overview)).
- Native SDKs exist: [Android Credential Manager](https://developer.android.com/identity/sign-in/credential-manager-siwg) and [iOS](https://developers.google.com/identity/sign-in/ios/start-integrating). Both are linked from [Supabase's guide](https://supabase.com/docs/guides/auth/social-login/auth-google.md).

### 2.2 Comparison table

| Option | Free tier | Web | iOS | Android | Expo/RN | Bundled DB |
|---|---|---|---|---|---|---|
| [Firebase Auth](https://firebase.google.com/pricing) | 50K MAU (Identity Platform) | Yes ([doc](https://firebase.google.com/docs/auth/web/google-signin)) | Yes (UNVERIFIED detail) | Yes (UNVERIFIED detail) | UNVERIFIED | Firestore (1 GiB, 50K reads/20K writes per day) |
| [Supabase Auth](https://supabase.com/pricing) | 50K MAU, 2 projects, pause after 7 days idle | Yes | Yes | Yes | Yes ([doc](https://supabase.com/docs/guides/auth/social-login/auth-google.md)) | Postgres 500 MB |
| [Auth.js](https://authjs.dev/getting-started/providers/google) | Library, no hosted fee | Yes (Next.js/SvelteKit/Qwik/Express) | UNVERIFIED (none found) | UNVERIFIED (none found) | UNVERIFIED (none found) | None (adapters) |
| [Clerk](https://clerk.com/pricing) | 50K MRU/app, 3 social connections | Yes | Yes (UNVERIFIED detail) | Yes (UNVERIFIED detail) | Yes ([doc](https://clerk.com/docs/expo/getting-started/quickstart)) | None |
| [Google Identity Services](https://developers.google.com/identity/gsi/web/guides/overview) | Price not listed (UNVERIFIED) | Yes | Yes (SDK) | Yes (Credential Manager) | UNVERIFIED | None |

### 2.3 Google Cloud Console setup (all options above need it)

1. Create or select a Google Cloud project. In the Google Auth Platform console, configure **Audience**, **Data Access (Scopes)** and **Branding**. [Supabase Google guide](https://supabase.com/docs/guides/auth/social-login/auth-google.md)
2. Scopes for basic sign-in: `openid`, `userinfo.email` and `userinfo.profile`. Adding sensitive or restricted scopes triggers lengthy verification. [Supabase Google guide](https://supabase.com/docs/guides/auth/social-login/auth-google.md)
3. Create OAuth client IDs per platform:
   - Web: JavaScript origins plus redirect URI.
   - Android: SHA-1 fingerprints (debug and release).
   - iOS: Bundle ID.

   [Supabase Google guide](https://supabase.com/docs/guides/auth/social-login/auth-google.md)
4. Verification:
   - Every app accessing Google APIs needs **brand verification**: a homepage on a verified domain, a privacy policy on the same domain linked from the consent screen, domain ownership verified in Search Console, and Google branding guidelines followed. [Verification requirements](https://support.google.com/cloud/answer/13464321)
   - The sensitive/restricted-scope requirements (demo video, limited use, security assessment) apply only when those scopes are requested. [Verification requirements](https://support.google.com/cloud/answer/13464321)
   - Brand verification "may take a few business days". [Supabase Google guide](https://supabase.com/docs/guides/auth/social-login/auth-google.md)
5. Exemptions: personal-use apps with fewer than 100 users, and apps in testing mode, skip verification. Users see an "unverified app" screen, and testing mode keeps a 100-user cap until verification. [When verification is not needed](https://support.google.com/cloud/answer/13464323)
6. Whether verification is mandatory for a production app using only `openid`/`email`/`profile` to remove the unverified screen: Google's pages above say brand verification applies to "all apps". The exact UX for non-sensitive-only apps is **UNVERIFIED**.

---

## 3. Realtime collaboration: Firestore vs Supabase Realtime

| | Firestore (Spark/free) | Supabase Realtime (Free) |
|---|---|---|
| Mechanism | Snapshot listeners on queries. Each added or updated doc in the result set is billed as a read. Reconnecting after 30 min offline, or with persistence off, re-bills the full query. [Firestore billing](https://firebase.google.com/docs/firestore/pricing) | Postgres Changes, Broadcast, Presence over WebSocket. [Realtime limits](https://supabase.com/docs/guides/realtime/limits.md) |
| Free limits | 50K reads/day, 20K writes/day, 1 GiB, 10 GiB/mo egress. [quotas](https://firebase.google.com/docs/firestore/quotas). Enterprise edition: 50K realtime update units/day. [pricing](https://firebase.google.com/pricing) | 200 concurrent connections, 2M messages/month, 100 msgs/s, 256 KB broadcast payload. [pricing](https://supabase.com/pricing), [limits](https://supabase.com/docs/guides/realtime/limits.md) |
| Concurrent connection cap | Not stated for Firestore on the pages reviewed (**UNVERIFIED**). Realtime Database is a separate product with 100 simultaneous connections on Spark. [pricing](https://firebase.google.com/pricing) | 200 (Free), 500 (Pro). [limits](https://supabase.com/docs/guides/realtime/limits.md) |
| Concurrent edits to the same record | Transactions: 270 s limit, 60 s idle expiry. [quotas](https://firebase.google.com/docs/firestore/quotas). Last-write-wins vs merge semantics: **UNVERIFIED** | No built-in conflict resolution is documented on the limits page. Behavior follows Postgres row updates (**UNVERIFIED**) |
| Other | Free quota applies to one database per project. [billing](https://firebase.google.com/docs/firestore/pricing) | Free projects pause after 1 week inactive. [pricing](https://supabase.com/pricing) |

---

## Sources

- https://frankfurter.dev/ (checked 2026-10-16)
- https://frankfurter.dev/license/ (linked, not re-read)
- https://api.frankfurter.dev/v2/rates , https://api.frankfurter.dev/v2/currencies (live, 2026-10-16)
- https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html (2026-10-16)
- https://exchangerate.host/pricing (2026-10-16)
- https://docs.apilayer.com/exchangerate/docs/api-documentation (2026-10-16, meta only)
- https://openexchangerates.org/signup (2026-10-16)
- https://docs.openexchangerates.org/reference/historical-json (2026-10-16)
- https://openexchangerates.org/api/currencies.json (live, 2026-10-16)
- https://www.exchangerate-api.com/ (2026-10-16)
- https://www.exchangerate-api.com/docs/free (2026-10-16)
- https://www.exchangerate-api.com/docs/historical-data-requests (2026-10-16)
- https://open.er-api.com/v6/latest/EUR (live, 2026-10-16)
- https://fixer.io/pricing , https://fixer.io/faq (2026-10-16)
- https://currencyapi.com/agents.md , https://api.currencyapi.com/v1/agent/plans , https://currencyapi.com/docs/llms.txt , https://currencyapi.com/docs/llms-full.txt (2026-10-16)
- https://currencyfreaks.com/pricing , https://currencyfreaks.com/documentation , https://api.currencyfreaks.com/v2.0/currency-symbols (2026-10-16)
- https://docs.wise.com/api-reference/rate/rateget.md , https://docs.wise.com/guides/developer/auth-and-security (2026-10-16)
- https://firebase.google.com/pricing (2026-10-16)
- https://firebase.google.com/docs/firestore/quotas (2026-10-16)
- https://firebase.google.com/docs/firestore/pricing (2026-10-16)
- https://firebase.google.com/docs/auth/web/google-signin (2026-10-16)
- https://supabase.com/pricing (2026-10-16)
- https://supabase.com/docs/guides/auth/social-login/auth-google.md (2026-10-16)
- https://supabase.com/docs/guides/realtime/limits.md (2026-10-16)
- https://authjs.dev/getting-started/providers/google (2026-10-16)
- https://clerk.com/pricing , https://clerk.com/docs/expo/getting-started/quickstart (2026-10-16)
- https://developers.google.com/identity/gsi/web/guides/overview (2026-10-16)
- https://support.google.com/cloud/answer/13464321 (2026-10-16)
- https://support.google.com/cloud/answer/13464323 (2026-10-16)
