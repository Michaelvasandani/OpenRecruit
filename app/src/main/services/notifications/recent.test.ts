import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { HostNotification } from "@shared/notify";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import * as schema from "../../db/schema";
import { bus } from "../event-bus";
import { RECENT_MAX, RecentNotificationsService } from "./recent";

// better-sqlite3 can't load under Bun's test runner; bun:sqlite exposes the same
// sync API through drizzle. SCHEMA_DDL is dependency-free so the real schema is used.
function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_DDL);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function note(n: Partial<HostNotification> = {}): HostNotification {
  return { kind: "wake", title: "t", body: "b", ...n };
}

describe("RecentNotificationsService", () => {
  test("stamps `at` and returns newest first", () => {
    const s = new RecentNotificationsService(memDb());
    s.record(note({ title: "first" }), 100);
    s.record(note({ title: "second" }), 200);

    const list = s.list();
    expect(list.map((n) => n.title)).toEqual(["second", "first"]);
    expect(list[0].at).toBe(200);
  });

  test("keeps only the newest RECENT_MAX — it is a ring buffer, not a log", () => {
    const s = new RecentNotificationsService(memDb());
    const total = RECENT_MAX + 3;
    for (let i = 0; i < total; i++) s.record(note({ title: `n${i}` }), 1000 + i);

    const list = s.list();
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0].title).toBe(`n${total - 1}`); // newest kept
    expect(list.at(-1)?.title).toBe(`n${total - RECENT_MAX}`); // oldest survivor
    expect(list.some((n) => n.title === "n0")).toBe(false); // displaced, gone
  });

  test("round-trips the payload, with agentId omitted when absent", () => {
    const s = new RecentNotificationsService(memDb());
    s.record({ kind: "order", title: "Order filled", body: "BUY $5 of NET", agentId: "a1" }, 5);
    s.record(note({ kind: "approval" }), 6);

    const [withoutAgent, withAgent] = s.list();
    expect(withAgent).toEqual({
      kind: "order",
      title: "Order filled",
      body: "BUY $5 of NET",
      agentId: "a1",
      at: 5,
    });
    expect(withoutAgent.kind).toBe("approval");
    expect(withoutAgent.agentId).toBeUndefined();
  });

  test("a DB failure never escapes into the emitter", () => {
    // record() runs inline on the raw `notify` bus, whose emitters are the scheduler,
    // a host notification emitter — a throw here would break later listeners.
    const sqlite = new Database(":memory:"); // no schema: every write fails
    const s = new RecentNotificationsService(drizzle(sqlite, { schema }) as unknown as Db);
    expect(() => s.record(note())).not.toThrow();
  });

  test("start() records raw `notify` bus events and publishes the new list", () => {
    const s = new RecentNotificationsService(memDb());
    const off = s.start();
    const seen: number[] = [];
    const offList = bus.onEvent("notifications:recent", (list) => seen.push(list.length));
    try {
      bus.emitEvent("notify", note({ title: "from the bus" }));
      expect(s.list()[0].title).toBe("from the bus");
      expect(s.list()[0].at).toBeGreaterThan(0); // service stamps it; the bus payload has none
      expect(seen).toEqual([1]);
    } finally {
      // The bus is a module singleton — always detach so other suites stay clean.
      off();
      offList();
    }
  });
});
