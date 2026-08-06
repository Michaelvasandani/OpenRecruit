import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_DDL } from "./ddl";
import { type MigrationDb, migrate, SCHEMA_VERSION, userVersion } from "./migrate";

/** Adapt bun:sqlite to the runner's minimal surface (the app adapts better-sqlite3). */
function wrap(db: Database): MigrationDb {
  return { exec: (sql) => void db.exec(sql), rows: (sql) => db.query(sql).all() };
}

/** The v0.1.x production `agents` table — the shape shipped before schema versioning. */
const BASELINE_AGENTS = `CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'default',
  approval_mode TEXT NOT NULL DEFAULT 'approve',
  last_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);`;

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

describe("db migrations", () => {
  test("a fresh DB gets the latest DDL and is stamped current without replaying", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    db.exec(SCHEMA_DDL);
    migrate(m, { fresh: true });
    expect(userVersion(m)).toBe(SCHEMA_VERSION);
    expect(columns(db, "agents")).toContain("headless_turns_used");
    expect(columns(db, "agents")).toContain("turn_limit_enabled");
    expect(columns(db, "agents")).toContain("harness");
    expect(columns(db, "wakes")).toContain("source_id"); // v4
  });

  test("a v0.1.x production DB (user_version 0) migrates in place, preserving rows", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    // Simulate the shipped baseline with a real agent in it.
    db.exec(BASELINE_AGENTS);
    db.exec(
      `INSERT INTO agents (id, slug, name, template, approval_mode, status, created_at)
       VALUES ('a1', 'citrini', 'Citrini', 'default', 'approve', 'idle', 1234)`,
    );
    // What createDb does on boot: current DDL (no-op for an existing table), then migrate.
    db.exec(SCHEMA_DDL);
    migrate(m, { fresh: false });

    expect(userVersion(m)).toBe(SCHEMA_VERSION);
    const row = db.query("SELECT * FROM agents WHERE id = 'a1'").get() as Record<string, unknown>;
    expect(row.name).toBe("Citrini"); // data survived
    expect(row.headless_turns_used).toBe(0); // new columns arrived with their defaults
    expect(row.turn_limit_enabled).toBe(1);
    expect(row.harness).toBe("claude"); // v3: pre-harness agents default to claude
  });

  test("replaying against an already-current table is a no-op (idempotent steps)", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    // A table already at the latest shape but never version-stamped (e.g. created
    // whole by a newer DDL): the replay must not throw on duplicate columns.
    db.exec(SCHEMA_DDL);
    migrate(m, { fresh: false });
    expect(userVersion(m)).toBe(SCHEMA_VERSION);
    // And running migrate again does nothing.
    migrate(m, { fresh: false });
    expect(userVersion(m)).toBe(SCHEMA_VERSION);
  });

  test("v4 adds wakes.source_id to an existing (v3) DB, preserving wake rows as NULL", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    // A pre-v4 wakes table (no source_id) with a real wake in it, stamped at v3.
    db.exec(`CREATE TABLE wakes (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      prompt TEXT NOT NULL, background INTEGER NOT NULL, fired_at INTEGER NOT NULL
    );`);
    db.exec(
      `INSERT INTO wakes (id, agent_id, source_kind, prompt, background, fired_at)
       VALUES ('w1', 'a1', 'cron', 'run', 0, 1000)`,
    );
    db.exec("PRAGMA user_version = 3");
    // Boot: current DDL (IF NOT EXISTS is a no-op for the existing wakes table), then migrate.
    db.exec(SCHEMA_DDL);
    migrate(m, { fresh: false });

    expect(userVersion(m)).toBe(SCHEMA_VERSION);
    expect(columns(db, "wakes")).toContain("source_id");
    const row = db.query("SELECT * FROM wakes WHERE id = 'w1'").get() as Record<string, unknown>;
    expect(row.prompt).toBe("run"); // data survived
    expect(row.source_id).toBeNull(); // pre-v4 rows read NULL, not a bogus id
  });

  test("refuses to open a DB stamped newer than this build (downgrade guard)", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    db.exec(SCHEMA_DDL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(m, { fresh: false })).toThrow(/newer than this build/);
  });
});
