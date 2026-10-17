import { Database } from "bun:sqlite";

const PATH = process.env.DB_PATH ?? "data.db";
export const db = new Database(PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  google_sub TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT,
  picture    TEXT
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
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expense_participants (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  share_minor INTEGER,
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

-- Latest USD->X snapshot. Each row carries the provider's timestamp.
CREATE TABLE IF NOT EXISTS fx_latest (
  code              TEXT PRIMARY KEY,
  usd_rate          REAL NOT NULL,
  provider_timestamp TEXT NOT NULL,
  fetched_at        TEXT NOT NULL
);
`);

// schema tweaks for existing DBs
if (db.query("SELECT 1 FROM pragma_table_info('expenses') WHERE name='mode'").get()) {
  db.exec("ALTER TABLE expenses DROP COLUMN mode");
}

if (!db.query("SELECT 1 FROM pragma_table_info('expenses') WHERE name='category'").get()) {
  db.exec("ALTER TABLE expenses ADD COLUMN category TEXT");
}

db.exec("CREATE UNIQUE INDEX IF NOT EXISTS members_name_nocase ON members(trip_token, name COLLATE NOCASE)");

if (!db.query("SELECT 1 FROM pragma_table_info('trips') WHERE name='fun_leaderboard'").get()) {
  db.exec("ALTER TABLE trips ADD COLUMN fun_leaderboard INTEGER NOT NULL DEFAULT 0");
}
if (!db.query("SELECT 1 FROM pragma_table_info('trips') WHERE name='created_by_token'").get()) {
  db.exec("ALTER TABLE trips ADD COLUMN created_by_token TEXT");
}

if (!db.query("SELECT 1 FROM pragma_table_info('members') WHERE name='opted_out_fun'").get()) {
  db.exec("ALTER TABLE members ADD COLUMN opted_out_fun INTEGER NOT NULL DEFAULT 0");
}

if (!db.query("SELECT 1 FROM pragma_table_info('members') WHERE name='detail_views'").get()) {
  db.exec("ALTER TABLE members ADD COLUMN detail_views INTEGER NOT NULL DEFAULT 0");
}


if (!db.query("SELECT 1 FROM pragma_table_info('expenses') WHERE name='created_by_member_id'").get()) {
  db.exec("ALTER TABLE expenses ADD COLUMN created_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL");
}

if (!db.query("SELECT 1 FROM pragma_table_info('trips') WHERE name='password_text'").get()) {
  db.exec("ALTER TABLE trips ADD COLUMN password_text TEXT");
}
