import type { Database } from "bun:sqlite"

// The database schema: create the full table set if it doesn't exist (the
// idempotent `CREATE TABLE IF NOT EXISTS` form is what keeps re-running
// openDb against a real DB harmless; `IF NOT EXISTS` is a no-op when the
// table is already there, so fresh DBs and existing DBs behave identically).
export function createSchema(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  -- email is the identity (email-code sign-in); google_sub kept for old rows
  email      TEXT PRIMARY KEY,
  google_sub TEXT,
  name       TEXT,
  phone      TEXT,
  venmo      TEXT,
  cash_app   TEXT
);

CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_sub   TEXT REFERENCES users(google_sub),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  token             TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  start_date        TEXT,
  end_date          TEXT,
  trip_currency     TEXT NOT NULL,
  settle_currency   TEXT NOT NULL,
  password_hash     TEXT,
  password_text     TEXT,
  password_ver      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id         TEXT PRIMARY KEY,
  trip_token TEXT NOT NULL REFERENCES trips(token) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  user_sub   TEXT REFERENCES users(google_sub),
  created_at TEXT NOT NULL,
  -- Per-trip Payment Method for unlinked members (no account to adopt).
  -- Linked members read their account's payment instead.
  phone      TEXT,
  venmo      TEXT,
  cash_app   TEXT,
  UNIQUE(trip_token, user_sub)
);

-- Which device session acts as which member in a trip.
CREATE TABLE IF NOT EXISTS claims (
  session_token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
  trip_token    TEXT NOT NULL REFERENCES trips(token) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (session_token, trip_token)
);

-- Sessions that have entered the trip password (per password version).
CREATE TABLE IF NOT EXISTS consents (
  session_token TEXT NOT NULL,
  trip_token    TEXT NOT NULL,
  password_ver  INTEGER NOT NULL,
  PRIMARY KEY (session_token, trip_token)
);

CREATE TABLE IF NOT EXISTS expenses (
  id              TEXT PRIMARY KEY,
  trip_token      TEXT NOT NULL REFERENCES trips(token) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  currency        TEXT NOT NULL,
  total_minor     INTEGER NOT NULL,
  payer_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  rate            REAL,
  rate_provider   TEXT,
  rate_timestamp  TEXT,
  recorded_at     TEXT NOT NULL,
  last_edited_by  TEXT,
  last_edited_at  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  paid_out        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expense_participants (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  share_minor INTEGER,
  paid       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (expense_id, member_id)
);

CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_minor INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_sharers (
  item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, member_id)
);

CREATE TABLE IF NOT EXISTS settlements (
  id           TEXT PRIMARY KEY,
  trip_token   TEXT NOT NULL REFERENCES trips(token) ON DELETE CASCADE,
  from_member  TEXT NOT NULL REFERENCES members(id),
  to_member    TEXT NOT NULL REFERENCES members(id),
  amount_minor INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT
);

CREATE TABLE IF NOT EXISTS expense_photos (
  id         TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- Audit trail of every expense/settlement change. One row per field change,
-- plus a 'created' and 'deleted' event so every record's life is visible.
CREATE TABLE IF NOT EXISTS expense_history (
  id           TEXT PRIMARY KEY,
  trip_token   TEXT NOT NULL REFERENCES trips(token) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,          -- 'expense' | 'settlement'
  entity_id    TEXT NOT NULL,
  entity_name  TEXT NOT NULL,          -- human label, e.g. "Dinner" or "Alice paid Bob"
  kind         TEXT NOT NULL,          -- 'created' | 'deleted' | 'changed'
  field        TEXT,                   -- the field that changed (null for created/deleted)
  old_value    TEXT,
  new_value    TEXT,
  by           TEXT,                  -- member name, null when anonymous
  created_at   TEXT NOT NULL
);

-- Latest USD->X snapshot. Each row carries the provider's timestamp.
CREATE TABLE IF NOT EXISTS fx_latest (
  code              TEXT PRIMARY KEY,
  usd_rate          REAL NOT NULL,
  provider_timestamp TEXT NOT NULL,
  fetched_at        TEXT NOT NULL
);
`)
}
