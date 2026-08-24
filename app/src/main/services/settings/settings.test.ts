import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AppSettings, DEFAULT_SETTINGS, SettingsUpdate } from "@shared/settings";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { bus } from "../event-bus";
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

  test("stores Firecrawl credentials while exposing only safe readiness", () => {
    const db = memDb();
    const s = new SettingsService(db);

    expect(s.get().firecrawl).toEqual({
      configured: false,
      readiness: "not_configured",
      safeFailure: null,
    });
    expect(() => s.requireFirecrawlApiKey()).toThrow(/not configured/);

    s.setFirecrawlApiKey("fc-old-secret");
    expect(s.requireFirecrawlApiKey()).toBe("fc-old-secret");
    expect(s.get().firecrawl).toEqual({
      configured: true,
      readiness: "ready",
      safeFailure: null,
    });
    expect(JSON.stringify(s.get())).not.toContain("fc-old-secret");

    // A replacement is visible to a fresh service instance, which models the
    // detached host reading the current value for its next provider operation.
    const replacement = new SettingsService(db);
    replacement.setFirecrawlApiKey("fc-new-secret");
    expect(new SettingsService(db).get().firecrawl.configured).toBe(true);
    expect(JSON.stringify(new SettingsService(db).get())).not.toContain("fc-new-secret");

    replacement.clearFirecrawlApiKey();
    expect(new SettingsService(db).get().firecrawl).toEqual({
      configured: false,
      readiness: "not_configured",
      safeFailure: null,
    });
  });

  test("tests the live key and records only safe provider readiness", async () => {
    const db = memDb();
    const seenKeys: string[] = [];
    const s = new SettingsService(db, {
      firecrawlProbe: async (apiKey) => {
        seenKeys.push(apiKey);
        return { status: 401 };
      },
    });

    s.setFirecrawlApiKey("fc-test-secret");
    const result = await s.testFirecrawlApiKey();

    expect(result).toEqual({
      configured: true,
      readiness: "reauthentication_required",
      safeFailure: "Firecrawl rejected the configured API key",
    });
    expect(seenKeys).toEqual(["fc-test-secret"]);
    expect(JSON.stringify(result)).not.toContain("fc-test-secret");
    expect(s.get().firecrawl).toEqual(result);
  });

  test("retests a replacement without restarting the service and clears safely", async () => {
    const seenKeys: string[] = [];
    const s = new SettingsService(memDb(), {
      firecrawlProbe: async (apiKey) => {
        seenKeys.push(apiKey);
        return { status: 200 };
      },
    });
    s.setFirecrawlApiKey("fc-first-secret");
    await s.testFirecrawlApiKey();
    s.setFirecrawlApiKey("fc-second-secret");
    await s.testFirecrawlApiKey();

    expect(seenKeys).toEqual(["fc-first-secret", "fc-second-secret"]);
    expect(s.get().firecrawl.readiness).toBe("ready");
    s.clearFirecrawlApiKey();
    expect((await s.testFirecrawlApiKey()).readiness).toBe("not_configured");
  });

  test("does not apply a stale test result after a concurrent replacement", async () => {
    let resolveProbe: ((response: { status: number }) => void) | undefined;
    const s = new SettingsService(memDb(), {
      firecrawlProbe: async () =>
        new Promise<{ status: number }>((resolve) => {
          resolveProbe = resolve;
        }),
    });
    s.setFirecrawlApiKey("fc-before-race");
    const pending = s.testFirecrawlApiKey();
    s.setFirecrawlApiKey("fc-after-race");
    if (!resolveProbe) throw new Error("probe was not started");
    resolveProbe({ status: 401 });
    await pending;

    expect(s.get().firecrawl).toEqual({ configured: true, readiness: "ready", safeFailure: null });
  });

  test("broadcasts safe settings after credential changes", () => {
    const s = new SettingsService(memDb());
    const payloads: AppSettings[] = [];
    const off = bus.onEvent("settings:changed", (next) => payloads.push(next));
    try {
      s.setFirecrawlApiKey("fc-broadcast-secret");
      s.clearFirecrawlApiKey();
    } finally {
      off();
    }

    expect(payloads).toHaveLength(2);
    expect(
      payloads.every((payload) => !JSON.stringify(payload).includes("fc-broadcast-secret")),
    ).toBe(true);
    expect(payloads[0]?.firecrawl.configured).toBe(true);
    expect(payloads[1]?.firecrawl.configured).toBe(false);
  });

  test("rejects an empty Firecrawl API key", () => {
    const s = new SettingsService(memDb());
    expect(() => s.setFirecrawlApiKey("   ")).toThrow(/API key/);
    expect(SettingsUpdate.safeParse({ firecrawl: { configured: true } }).success).toBe(false);
  });
});
