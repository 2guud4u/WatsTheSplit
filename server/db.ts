import { Database, type Statement, type SQLQueryBindings } from "bun:sqlite";
import { createSchema } from "./schema.ts";
import { runMigrations } from "./migrate.ts";

let _db: Database | null = null;

/** The open database. Throws if openDb() hasn't run — every import below must stay lazy. */
export const getDb = () => {
  if (!_db) throw new Error("openDb() must run before any db use");
  return _db;
};

// Lazy facade so existing `db.query(...)` call sites don't care when openDb ran.
// Method calls bind to the live instance; prepare() at module top-level is still
// unsafe — use stmt() for reusable statements.
export const db = new Proxy({} as Database, {
  get(_t, prop) {
    const v = getDb()[prop as keyof Database];
    return typeof v === "function" ? v.bind(getDb()) : v;
  },
});

// Prepared statements cached per db instance (safe across openDb(':memory:') in tests).
const _stmts = new WeakMap<Database, Map<string, Statement>>();
export function stmt<T = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<T, P> {
  let per = _stmts.get(getDb());
  if (!per) _stmts.set(getDb(), (per = new Map()));
  let s = per.get(sql);
  if (!s) per.set(sql, (s = getDb().prepare<T, P>(sql)));
  return s as Statement<T, P>;
}

/** Open (creating) the database at path — ":memory:" for tests — and run migrations. */
export function openDb(path: string = process.env.DB_PATH ?? "data.db"): Database {
  const d = new Database(path, { create: true });
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  createSchema(d);
  runMigrations(d);
  _db = d;
  return d;
}
