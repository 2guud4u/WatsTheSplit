# WatsTheSplit

Split trip expenses with friends. No sign-in required to join — a shareable link (or QR) gets everyone in; email sign-in (4-letter code, no password) is optional and locks your name to your account. Each expense locks the exchange rate at the moment it is created (daily snapshot; hourly if OXR_APP_ID is set).

## Run locally

```sh
bun install
bun run build        # builds client into dist/
OXR_APP_ID=<key> bun run start   # http://localhost:3000
```

Dev mode (hot reload, API proxied to :3000):

```sh
bun run dev:server   # terminal 1
bun run dev:client   # terminal 2 → http://localhost:5173
```

## Environment variables

| Var | Purpose |
|---|---|
| `OXR_APP_ID` | Open Exchange Rates App ID (free tier: hourly, USD base, 1,000 req/mo). Without it, rates stay `unavailable` and expenses still work. |
| `RESEND_API_KEY` | Resend API key for sign-in emails. Without it, codes are printed to the server log (dev mode) — sign-in still works locally. |
| `EMAIL_FROM` | Sender for sign-in emails (default `WatsTheSplit <onboarding@resend.dev>`; use a verified domain in production). |
| `BASE_URL` | Public origin used in invite links (default `http://localhost:PORT`). |
| `PORT` | Listen port (default 3000). |
| `DB_PATH` | SQLite file (default `data.db`). |

## Deploying on your server

1. Point a domain you own at a Cloudflare Tunnel targeting `http://localhost:8081`.
2. Sign up at resend.com; add your domain via Cloudflare Domain Connect (it writes MX/SPF/DKIM for you), get an API key, set `RESEND_API_KEY` and `EMAIL_FROM`.
3. Set `BASE_URL=https://<domain>`.
4. Backup = copy `data.db`.

Email deliverability notes: `docs/research/email-sign-in.md`.

## How it works

- **Trip** — name, date range, trip currency (default for new expenses), settlement currency (locked once the first expense exists).
- **Members** — placeholders anyone can claim, claimed members (device-only, anyone can re-pick), linked members (signed-in email account).
- **Expense** — one payer, participants, total. Everyone in the trip is a participant by default; a participant with no typed share takes an equal share of whatever is left after fixed shares and items. Typing an amount fixes it. Items split equally among their sharers; "split rest equally" and "spread proportionally" distribute any leftover. If every participant has a fixed share and they don't add up, the gap/over shows as a badge.
- **Locked rate** — stored per expense at creation (rate, provider timestamp); re-fetched only if the currency changes.
- **Balances** — pairwise nets in settlement currency; settlements recorded in settlement currency.
- **Live updates** — Server-Sent Events per trip.
- **Trip password** — required at creation. The invite link carries it in the URL fragment (`#/t/<token>?pw=…`), so the link unlocks the trip seamlessly; a bare link (no `?pw=`) still prompts. Changing it re-prompts every device except signed-in members. Stored in plaintext alongside the hash so the invite URL can embed it — consistent with link = access.

Design rationale: `docs/adr/`. Vocabulary: `GLOSSARY.md`.

## Smoke test

```sh
bun run smoke   # spawns server on :3999 with seeded FX rates, runs full API flow
```

## Deploy (jia-server)

Deployed as Docker on `jia-server`, managed by `/usr/local/bin/server`:

```sh
server wts status    # app/version/CPU + public URL health
server wts update    # pull + build + apply (backs up data.db first)
server wts backup    # VACUUM INTO snapshot into ~/wts/data/backups/
server wts public on # start cloudflared (needs TUNNEL_TOKEN in ~/wts/.env)
```

Layout: repo at `~/wts`, SQLite at `~/wts/data/data.db` (bind-mounted into the container), backups in `~/wts/data/backups/` (keeps 10). Ports: `127.0.0.1`, tailnet `100.127.5.96`, LAN `192.168.8.208` — all on `:8081`.

Going public needs one-time Cloudflare steps: create a tunnel, add a public hostname pointing at `http://wts-server:8081`, paste `TUNNEL_TOKEN` into `~/wts/.env`, set `BASE_URL=https://<hostname>` in the same file, then `server wts public on`.

Public URL: `https://jiathe.dev/watsthesplit` — client built with `VITE_BASE=/watsthesplit/` (`--build-arg` in `wts_build`), server strips `BASE_PATH` in `server/index.ts`. Tunnel: point the hostname/path at `http://wts-server:8081`.
