# WatsTheSplit

Standards doc for an agent working on this codebase: the conventions, codified,
matching the codebase's current state (codify-don't-churn). The code is the
ground truth — where this doc and the code disagree, the code wins, and a
future `/retro` updates the doc.

## Stack

- **server** — Bun + TypeScript, no framework (raw `Request`/`Response` + `bun:sqlite`).
- **client** — React 19 + Vite 6.
- **shared** — wire types (the contract both sides compile against).

One standard, all three.

## Tooling (the gate)

- `bun run build` / `bun run start` / `bun dev` / `bun dev:server` / `bun dev:client`
- `bun run lint` — Biome check (lint + format + import order; zero errors)
- `bun run typecheck` — `tsc --noEmit`
- `bun run smoke` — the end-to-end test
- pre-commit (husky + lint-staged) runs Biome on staged files + `tsc --noEmit`
- the GitHub Actions `Gate` job runs Biome + `tsc --noEmit` + build on every PR
- config: `biome.json`, `tsconfig.json`

## File naming

- camelCase files: `server/ledger.ts`, `client/services/transport.ts`, `useTrip.ts`
- PascalCase components: `client/components/OweCard.tsx`, `client/pages/Home.tsx`
- one file = one concern.

## Structure

- one file = one concern, soft ~300-line cap (a signal to split, not a hard rule).
- server routes live one-per-domain in `server/routes/<domain>.ts`; the harness
  `server/app.ts` imports each domain's `Route[]` in dispatch order.
- client views split into `client/components/` (leaf components) + `client/pages/`
  (views), with `client/hooks/` for shared state and `client/services/` for the
  API layer (transport + routes + core).

## Error handling (the single standard)

Every handler reports failure through one `err()` — the server has a single
error source, no ad-hoc `Response` objects.

- **Before any write** (guard): `return err(status, code)`. `err(status, code,
  extra = {})` → `json({ error: code, ...extra }, { status })`.
- **Inside a mutation transaction** (roll back and return): `abort(err(status,
  code))` (see `server/mutate.ts`). `abort` throws an `Abort` that the
  `transact` seam catches, returning the error `Response` and rolling back.

The wire contract is snake_case end to end. `err` is typed against `ErrorCode`
(`shared/wire.ts`), so a new code is a union member and drift fails to compile
on the producing side. The error is a **string code** on the wire
(`data.error`), not an object; the human copy is a client catalog
(`COPY` in `client/services/transport.ts`), not the server response. The client
reads it back: `const code = String(data.error ?? `http_${status}`)` and routes
on `code` via an `ApiError` handler.

So: `return err(400, "bad_total")`, `abort(err(403, "payer_only"))`.
Codes are snake_case, the `code` names come from `ErrorCode`, and the client
checks the code — never the `msg`.

## Comments

- Comment **why, not what**: `// cheap CSRF guard for cookie auth`, `// the
  wire is snake_case end to end`.
- JSDoc for exported API (`/** Trip-scoped mutation: transaction + notify.trip
  after commit. */`).
- Line comments for non-obvious logic.

## Domain terms

Code names align with `GLOSSARY.md` (Trip, Member, Expense, Share, Balance,
Settlement, Payer, Change, Payment Method, …). No new domain term without a
glossary entry; `GLOSSARY.md` is the single source of the vocabulary.
