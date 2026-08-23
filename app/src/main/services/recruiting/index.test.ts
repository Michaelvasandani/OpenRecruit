import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { bus } from "../event-bus";
import { RecruitingApplication, RecruitingError } from ".";

function makeDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(SCHEMA_DDL);
  const migration: MigrationDb = {
    exec: (sql) => void sqlite.exec(sql),
    rows: (sql) => sqlite.query(sql).all(),
  };
  migrate(migration, { fresh: true });
  return drizzle(sqlite, { schema }) as unknown as Db;
}

describe("RecruitingApplication", () => {
  let off: (() => void) | undefined;

  afterEach(() => off?.());

  test("creates a Scout through one revisioned transaction and emits after commit", () => {
    const db = makeDb();
    const app = new RecruitingApplication(db, () => 1234);
    const events: unknown[] = [];
    off = bus.onEvent("recruiting:changed", (event) => events.push(event));

    const created = app.createScout({
      name: "RSS Scout",
      harness: "claude",
      instructionPath: "agents/rss",
      idempotencyKey: "create-rss-1",
    });

    expect(created.revision).toBe(1);
    expect(created.replayed).toBe(false);
    expect(app.revision()).toBe(1);
    expect(app.listScouts()).toHaveLength(1);
    expect(events).toEqual([
      { revision: 1, kind: "scout", ids: [created.value.id], reason: "scout_created", at: 1234 },
    ]);
  });

  test("retries an identical command from its receipt without advancing revision", () => {
    const app = new RecruitingApplication(makeDb(), () => 1234);
    const input = {
      name: "RSS Scout",
      harness: "claude" as const,
      instructionPath: "agents/rss",
      idempotencyKey: "create-rss-1",
    };
    const first = app.createScout(input);
    const retry = app.createScout(input);

    expect(retry).toMatchObject({ revision: 1, replayed: true, value: first.value });
    expect(app.listScouts()).toHaveLength(1);
    expect(app.revision()).toBe(1);
  });

  test("rejects a reused idempotency key with a changed payload and stale archive", () => {
    const app = new RecruitingApplication(makeDb());
    const first = app.createScout({
      name: "RSS Scout",
      harness: "claude",
      instructionPath: "agents/rss",
      idempotencyKey: "create-rss-1",
    });
    expect(() =>
      app.createScout({
        name: "Different Scout",
        harness: "claude",
        instructionPath: "agents/rss",
        idempotencyKey: "create-rss-1",
      }),
    ).toThrow(RecruitingError);
    expect(() =>
      app.archiveScout({
        scoutId: first.value.id,
        expectedRevision: 99,
        idempotencyKey: "archive-1",
      }),
    ).toThrow(/expected 99/);
    expect(app.listScouts()).toHaveLength(1);
    expect(app.revision()).toBe(1);
  });
});
