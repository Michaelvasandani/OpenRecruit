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
    expect(columns(db, "agents")).toContain("last_turn_at"); // v5
    // Whole new tables ride the DDL — no migration, no version bump (§6.3).
    expect(columns(db, "recent_notifications")).toContain("at");
  });

  test("an existing DB picks up a whole new table from the DDL alone", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    // A shipped DB predating recent_notifications: baseline agents, no version stamp.
    db.exec(BASELINE_AGENTS);
    expect(userVersion(m)).toBe(0);
    db.exec(SCHEMA_DDL); // boot order: DDL first, then migrate
    migrate(m, { fresh: false });
    expect(columns(db, "recent_notifications")).toContain("kind");
    expect(db.query("SELECT * FROM recent_notifications").all()).toEqual([]);
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
    expect(row.last_turn_at).toBe(null); // v5: never spoke since the column shipped
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

  test("v6 imports each active legacy agent into exactly one Scout", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    db.exec(BASELINE_AGENTS);
    db.exec(
      `INSERT INTO agents (id, slug, name, template, approval_mode, last_session_id, status, created_at)
       VALUES ('active', 'active-agent', 'Active Agent', 'default', 'approve', 'session-1', 'idle', 1000),
              ('archived', 'old-agent', 'Old Agent', 'default', 'approve', 'session-2', 'idle', 1001)`,
    );
    db.exec("UPDATE agents SET archived_at = 2000 WHERE id = 'archived'");
    db.exec(SCHEMA_DDL);
    migrate(m, { fresh: false });

    const scouts = db
      .query(
        "SELECT legacy_agent_id, name, harness, instruction_path, resumable_session_ref FROM scouts",
      )
      .all() as Record<string, unknown>[];
    expect(scouts).toHaveLength(1);
    expect(scouts[0]).toMatchObject({
      legacy_agent_id: "active",
      name: "Active Agent",
      harness: "claude",
      instruction_path: "agents/active-agent",
      resumable_session_ref: "session-1",
    });

    migrate(m, { fresh: false });
    expect(db.query("SELECT count(*) AS count FROM scouts").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM schedules").get()).toEqual({ count: 0 });
  });

  test("fresh recruiting schema has the subject checks, foreign keys, and durable clock", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_DDL);
    migrate(m, { fresh: true });

    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("SELECT revision FROM domain_clock WHERE id = 1").get()).toEqual({
      revision: 0,
    });
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('profiles', 'scouts', 'scout_runs', 'signals', 'leads', 'opportunities', 'investigations', 'revisit_plans', 'candidate_decisions', 'command_receipts') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual([
      "candidate_decisions",
      "command_receipts",
      "investigations",
      "leads",
      "opportunities",
      "profiles",
      "revisit_plans",
      "scout_runs",
      "scouts",
      "signals",
    ]);
    expect(() =>
      db.exec(
        `INSERT INTO candidate_decisions (id, lead_id, opportunity_id, kind, created_at)
         VALUES ('invalid', NULL, NULL, 'dismiss', 1)`,
      ),
    ).toThrow();
  });

  test("v6 leaves legacy runtime and broker records recoverable", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    db.exec(BASELINE_AGENTS);
    db.exec(
      `INSERT INTO agents (id, slug, name, created_at) VALUES ('legacy', 'legacy', 'Legacy', 1)`,
    );
    db.exec(SCHEMA_DDL);
    db.exec(`
      INSERT INTO schedules (id, agent_id, cron_expr, prompt, created_at) VALUES ('schedule', 'legacy', '* * * * *', 'wake', 1);
      INSERT INTO monitors (id, agent_id, command, created_at) VALUES ('monitor', 'legacy', 'echo signal', 1);
      INSERT INTO wakes (id, agent_id, source_kind, prompt, background, fired_at) VALUES ('wake', 'legacy', 'cron', 'wake', 1, 1);
      INSERT INTO approvals (id, agent_id, tool_name, raw_input, requested_at) VALUES ('approval', 'legacy', 'tool', '{}', 1);
      INSERT INTO broker_cache (key, payload, fetched_at) VALUES ('portfolio', '{}', 1);
    `);
    migrate(m, { fresh: false });

    expect(db.query("SELECT count(*) AS count FROM schedules").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM monitors").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM wakes").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM approvals").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM broker_cache").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM scouts").get()).toEqual({ count: 1 });
  });

  test("v7 adds Candidate Profile draft columns to an existing v6 database", () => {
    const db = new Database(":memory:");
    const m = wrap(db);
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'draft',
        current_version_id TEXT,
        content_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO profiles (id, name, artifact_path, created_at, updated_at)
      VALUES ('p1', 'Candidate', '/tmp/p1.md', 1, 1);
      PRAGMA user_version = 6;
    `);
    db.exec(SCHEMA_DDL);
    migrate(m, { fresh: false });

    expect(userVersion(m)).toBe(SCHEMA_VERSION);
    expect(columns(db, "profiles")).toEqual(
      expect.arrayContaining([
        "role_target",
        "draft_markdown",
        "draft_structured",
        "draft_provenance",
        "revision",
      ]),
    );
    expect(db.query("SELECT name, revision FROM profiles WHERE id = 'p1'").get()).toEqual({
      name: "Candidate",
      revision: 0,
    });
  });
});
