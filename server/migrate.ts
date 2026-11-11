import type { Database } from "bun:sqlite"

// Migrations for existing DBs: every step is idempotent (guarded by a
// pragma check or `IF NOT EXISTS`), so a crash mid-migration can re-run
// safely.
export function runMigrations(db: Database): void {
  // schema tweaks for existing DBs
  if (db.query("SELECT 1 FROM pragma_table_info('expenses') WHERE name='mode'").get()) {
    db.exec("ALTER TABLE expenses DROP COLUMN mode")
  }

  if (!db.query("SELECT 1 FROM pragma_table_info('expenses') WHERE name='category'").get()) {
    db.exec("ALTER TABLE expenses ADD COLUMN category TEXT")
  }

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS members_name_nocase ON members(trip_token, name COLLATE NOCASE)")

  if (!db.query("SELECT 1 FROM pragma_table_info('trips') WHERE name='fun_leaderboard'").get()) {
    db.exec("ALTER TABLE trips ADD COLUMN fun_leaderboard INTEGER NOT NULL DEFAULT 0")
  }
  if (!db.query("SELECT 1 FROM pragma_table_info('trips') WHERE name='created_by_token'").get()) {
    db.exec("ALTER TABLE trips ADD COLUMN created_by_token TEXT")
  }
  if (!db.query("SELECT 1 FROM pragma_table_info('trips') WHERE name='created_by_member_id'").get()) {
    db.exec("ALTER TABLE trips ADD COLUMN created_by_member_id TEXT")
  }
  // backfill: owner's member = the member the creator session claimed (if any)
  db.exec(
    `UPDATE trips SET created_by_member_id = (SELECT c.member_id FROM claims c WHERE c.trip_token = trips.token AND c.session_token = trips.created_by_token) WHERE created_by_member_id IS NULL AND created_by_token IS NOT NULL`
  )

  if (!db.query("SELECT 1 FROM pragma_table_info('members') WHERE name='opted_out_fun'").get()) {
    db.exec("ALTER TABLE members ADD COLUMN opted_out_fun INTEGER NOT NULL DEFAULT 0")
  }

  if (!db.query("SELECT 1 FROM pragma_table_info('members') WHERE name='detail_views'").get()) {
    db.exec("ALTER TABLE members ADD COLUMN detail_views INTEGER NOT NULL DEFAULT 0")
  }

  if (!db.query("SELECT 1 FROM pragma_table_info('expenses') WHERE name='created_by_member_id'").get()) {
    db.exec("ALTER TABLE expenses ADD COLUMN created_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL")
  }

  if (!db.query("SELECT 1 FROM pragma_table_info('trips') WHERE name='password_text'").get()) {
    db.exec("ALTER TABLE trips ADD COLUMN password_text TEXT")
  }

  if (!db.query("SELECT 1 FROM pragma_table_info('expenses') WHERE name='paid_out'").get()) {
    db.exec("ALTER TABLE expenses ADD COLUMN paid_out INTEGER NOT NULL DEFAULT 0")
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS journeys (
  token           TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  settle_currency TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journey_trips (
  journey_token TEXT NOT NULL REFERENCES journeys(token) ON DELETE CASCADE,
  trip_token    TEXT NOT NULL UNIQUE REFERENCES trips(token) ON DELETE CASCADE,
  PRIMARY KEY (journey_token, trip_token)
);
-- manual identity merge: members in the same group_id count as one person
CREATE TABLE IF NOT EXISTS journey_merges (
  journey_token TEXT NOT NULL REFERENCES journeys(token) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  group_id      TEXT NOT NULL,
  PRIMARY KEY (journey_token, member_id)
);
`)

  db.exec(`
-- journey sharing: a session that opened a journey link can view all member trips
CREATE TABLE IF NOT EXISTS journey_access (
  session_token TEXT NOT NULL,
  journey_token TEXT NOT NULL REFERENCES journeys(token) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (session_token, journey_token)
);

`)
  if (!db.query("SELECT 1 FROM pragma_table_info('journeys') WHERE name='fun_leaderboard'").get()) {
    db.exec("ALTER TABLE journeys ADD COLUMN fun_leaderboard INTEGER NOT NULL DEFAULT 0")
  }

  if (!db.query("SELECT 1 FROM pragma_table_info('expense_participants') WHERE name='paid'").get()) {
    db.exec("ALTER TABLE expense_participants ADD COLUMN paid INTEGER NOT NULL DEFAULT 0")
    // carry over the old whole-expense flag
    db.exec(`UPDATE expense_participants SET paid = 1 WHERE expense_id IN (SELECT id FROM expenses WHERE paid_out = 1)`)
  }

  // migrate: users table keyed by email instead of google_sub; sessions/members
  // .user_sub carries the email going forward. FK off so DROP TABLE isn't blocked
  // by references; each step drops its staging table first so a crash mid-migration
  // can re-run.
  db.exec("PRAGMA foreign_keys = OFF;")
  try {
    // old schema has google_sub as PRIMARY KEY (pk>0); new schema has it nullable (pk=0)
    if (db.query("SELECT 1 FROM pragma_table_info('users') WHERE name='google_sub' AND pk > 0").get()) {
      db.exec(`
        DROP TABLE IF EXISTS users_new;
        CREATE TABLE users_new (
          email      TEXT PRIMARY KEY,
          google_sub TEXT,
          name       TEXT
        );
        INSERT INTO users_new (email, google_sub, name)
          SELECT email, google_sub, name FROM users WHERE email != '';
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `)
    }
    if (
      db
        .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='sessions'")
        .get()
        ?.sql.includes("REFERENCES users(google_sub)")
    ) {
      db.exec(`
        DROP TABLE IF EXISTS sessions_new;
        CREATE TABLE sessions_new (
          token      TEXT PRIMARY KEY,
          user_sub   TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO sessions_new SELECT token, user_sub, created_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
      `)
    }
    if (
      db
        .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='members'")
        .get()
        ?.sql.includes("REFERENCES users(google_sub)")
    ) {
      db.exec(`
        DROP TABLE IF EXISTS members_new;
        CREATE TABLE members_new (
          id         TEXT PRIMARY KEY,
          trip_token TEXT NOT NULL REFERENCES trips(token) ON DELETE CASCADE,
          name       TEXT NOT NULL,
          user_sub   TEXT,
          opted_out_fun INTEGER NOT NULL DEFAULT 0,
          detail_views INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          UNIQUE(trip_token, user_sub)
        );
        INSERT INTO members_new SELECT id, trip_token, name, user_sub, opted_out_fun, detail_views, created_at FROM members;
        DROP TABLE members;
        ALTER TABLE members_new RENAME TO members;
        CREATE UNIQUE INDEX IF NOT EXISTS members_name_nocase ON members(trip_token, name COLLATE NOCASE);
      `)
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON;")
  }

  // migrate: users table gains Payment Method columns (phone, venmo, cash_app)
  // for a fresh account's "how to pay me" info.
  // col is from a fixed const list — safe to interpolate.
  for (const col of ["phone", "venmo", "cash_app"] as const) {
    if (!db.query(`SELECT 1 FROM pragma_table_info('users') WHERE name='${col}'`).get()) {
      db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`)
    }
  }

  // migrate: members table gains Payment Method columns (phone, venmo, cash_app)
  // for an unlinked member's per-trip "how to pay me" info.
  for (const col of ["phone", "venmo", "cash_app"] as const) {
    if (!db.query(`SELECT 1 FROM pragma_table_info('members') WHERE name='${col}'`).get()) {
      db.exec(`ALTER TABLE members ADD COLUMN ${col} TEXT`)
    }
  }
}
