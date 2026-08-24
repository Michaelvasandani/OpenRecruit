import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AppSettings, DEFAULT_SETTINGS, SettingsUpdate } from "@shared/settings";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { SettingsService } from "./index";

// The app uses better-sqlite3, which Bun's test runner can't load natively; the
// bun:sqlite drizzle driver exposes the same sync query API, so it stands in here.
function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

describe("SettingsService", () => {
  test("returns defaults on an empty store", () => {
    const s = new SettingsService(memDb());
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  test("does not expose legacy broker/order settings or aliases", () => {
    const db = memDb();
    db.insert(schema.settings)
      .values([
        { key: "approval_timeout_sec", value: "120" },
        { key: "poll_interval_focused_sec", value: "3" },
        { key: "poll_interval_blurred_sec", value: "8" },
        { key: "default_approval_mode", value: "auto" },
        { key: "notify_orders", value: "0" },
        { key: "notify_approvals", value: "0" },
      ])
      .run();

    const s = new SettingsService(db);
    const active = s.get();
    const legacyFields = [
      "approvalTimeoutSec",
      "pollIntervalFocusedSec",
      "pollIntervalBlurredSec",
      "defaultApprovalMode",
      "notifyOrders",
      "notifyApprovals",
    ];

    for (const field of legacyFields) {
      expect(active).not.toHaveProperty(field);
      expect(AppSettings.shape).not.toHaveProperty(field);
      expect(SettingsUpdate.shape).not.toHaveProperty(field);
      expect(SettingsUpdate.safeParse({ [field]: true }).success).toBe(false);
    }

    // The expand/contract boundary is non-destructive: legacy rows remain recoverable
    // even though no active settings API reads or writes them.
    expect(db.select().from(schema.settings).all()).toEqual(
      expect.arrayContaining([
        { key: "approval_timeout_sec", value: "120" },
        { key: "default_approval_mode", value: "auto" },
        { key: "notify_orders", value: "0" },
      ]),
    );
  });

  test("update persists and round-trips, coercing booleans/numbers", () => {
    const s = new SettingsService(memDb());
    const next = s.update({
      onboardingComplete: true,
      maxHeadlessTurns: 24,
    });
    expect(next.onboardingComplete).toBe(true);
    expect(next.maxHeadlessTurns).toBe(24);
    // A fresh service over the same store reads the same values.
    expect(s.get()).toEqual(next);
  });

  test("partial update leaves other keys untouched", () => {
    const s = new SettingsService(memDb());
    s.update({ maxHeadlessTurns: 600 });
    s.update({ telemetryEnabled: false });
    const v = s.get();
    expect(v.maxHeadlessTurns).toBe(600);
    expect(v.telemetryEnabled).toBe(false);
  });

  test("telemetryEnabled defaults on and round-trips off", () => {
    const s = new SettingsService(memDb());
    expect(s.get().telemetryEnabled).toBe(true);
    expect(s.update({ telemetryEnabled: false }).telemetryEnabled).toBe(false);
    expect(s.get().telemetryEnabled).toBe(false);
  });

  test("showInMenuBar defaults on (menu bar item + ⌘Q→menu bar) and round-trips off", () => {
    const s = new SettingsService(memDb());
    expect(s.get().showInMenuBar).toBe(true);
    expect(s.update({ showInMenuBar: false }).showInMenuBar).toBe(false);
    expect(s.get().showInMenuBar).toBe(false);
  });

  test("rejects out-of-bounds values", () => {
    const s = new SettingsService(memDb());
    expect(() => s.update({ maxHeadlessTurns: 0 })).toThrow();
  });

  test("getOrCreate generates once then reuses (stable token across restarts)", () => {
    const db = memDb();
    let calls = 0;
    const s1 = new SettingsService(db);
    const first = s1.getOrCreate("local_api_token", () => `tok-${++calls}`);
    expect(first).toBe("tok-1");
    // Same service: no regeneration.
    expect(s1.getOrCreate("local_api_token", () => `tok-${++calls}`)).toBe("tok-1");
    // A fresh service over the same store reads the persisted value.
    const s2 = new SettingsService(db);
    expect(s2.getOrCreate("local_api_token", () => `tok-${++calls}`)).toBe("tok-1");
    expect(calls).toBe(1);
  });
});
