import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assetTypeOf,
  errorNameOf,
  orderKindOf,
  orderTypeOf,
  RendererTrackInput,
  sanitizeStack,
  sideOf,
  TELEMETRY_EVENTS,
  templateOf,
} from "@shared/analytics";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { SettingsService } from "../settings";
import { AnalyticsService, type CaptureClient } from "./index";

// Same stand-in the SettingsService tests use: bun:sqlite exposes the sync query
// API drizzle needs, so we avoid better-sqlite3's Electron-ABI native binding.
function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

interface Captured {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

class FakeClient implements CaptureClient {
  events: Captured[] = [];
  capture(msg: Captured): void {
    this.events.push(msg);
  }
  async shutdown(): Promise<void> {}
}

// Track every service we spin up so listeners never leak onto the shared `bus`
// across tests (settings.update() fans out to all live AnalyticsService instances).
const live: AnalyticsService[] = [];
function makeService(settings: SettingsService, client: CaptureClient | null): AnalyticsService {
  const svc = new AnalyticsService();
  svc.start({ settings, client });
  live.push(svc);
  return svc;
}
afterEach(async () => {
  while (live.length) await live.pop()?.shutdown();
});

describe("AnalyticsService", () => {
  test("opted out → nothing is captured", () => {
    const settings = new SettingsService(memDb());
    settings.update({ telemetryEnabled: false });
    const fake = new FakeClient();
    const svc = makeService(settings, fake);
    svc.track("host_started");
    expect(fake.events).toHaveLength(0);
  });

  test("no client → no-op (community/source build)", () => {
    const svc = makeService(new SettingsService(memDb()), null);
    svc.track("host_started");
    // Nothing to assert but the absence of a throw; a null client is inert.
    expect(svc.anonymousId).toMatch(/[0-9a-f-]{36}/);
  });

  test("allowlisted event stamps super-props + the anonymous flag", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    svc.track("agent_created", { template: "dca", harness: "claude", approval_mode: "auto" });
    expect(fake.events).toHaveLength(1);
    const e = fake.events[0];
    expect(e.event).toBe("agent_created");
    expect(e.distinctId).toBe(svc.anonymousId);
    expect(e.properties).toMatchObject({
      template: "dca",
      approval_mode: "auto",
      platform: process.platform,
      arch: process.arch,
      $process_person_profile: false,
    });
    expect(e.properties?.app_version).toBeDefined();
  });

  test("an event with an extra prop is dropped whole (no PII leak)", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    // A ticker sneaks in — strict parsing must reject the entire event.
    svc.track("order_gate_prompted", {
      kind: "place",
      asset_type: "equity",
      side: "buy",
      order_type: "market",
      mode: "approve",
      symbol: "AAPL",
    } as never);
    expect(fake.events).toHaveLength(0);
  });

  test("an unknown event name is dropped, not thrown", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    expect(() => svc.track("not_an_event" as never)).not.toThrow();
    expect(fake.events).toHaveLength(0);
  });

  test("distinct id is a stable per-install value across service instances", () => {
    const db = memDb();
    const a = makeService(new SettingsService(db), new FakeClient());
    const b = makeService(new SettingsService(db), new FakeClient());
    expect(a.anonymousId).toBe(b.anonymousId);
    expect(a.anonymousId).toMatch(/[0-9a-f-]{36}/);
  });

  test("toggle off sends exactly one telemetry_disabled, then gates; on re-enables", () => {
    const settings = new SettingsService(memDb());
    const fake = new FakeClient();
    const svc = makeService(settings, fake);

    settings.update({ telemetryEnabled: false });
    expect(fake.events.map((e) => e.event)).toEqual(["telemetry_disabled"]);
    // Gated now: further events are dropped.
    svc.track("host_started");
    expect(fake.events).toHaveLength(1);

    settings.update({ telemetryEnabled: true });
    expect(fake.events.map((e) => e.event)).toEqual(["telemetry_disabled", "telemetry_enabled"]);
    svc.track("host_started");
    expect(fake.events).toHaveLength(3);
  });

  test("a non-telemetry setting change emits setting_changed (value only for enums/bools)", () => {
    const settings = new SettingsService(memDb());
    const fake = new FakeClient();
    makeService(settings, fake);

    settings.update({ defaultApprovalMode: "auto" });
    settings.update({ approvalTimeoutSec: 120 });

    const changes = fake.events.filter((e) => e.event === "setting_changed");
    expect(changes).toHaveLength(2);
    expect(changes[0].properties).toMatchObject({ key: "defaultApprovalMode", value: "auto" });
    // Numeric settings carry no value (only the key).
    expect(changes[1].properties?.key).toBe("approvalTimeoutSec");
    expect(changes[1].properties).not.toHaveProperty("value");
  });

  test("trackError sends only the class name + frames — never the message", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    svc.trackError("broker", new TypeError("secret /Users/alice/holdings AAPL"));
    expect(fake.events).toHaveLength(1);
    const e = fake.events[0];
    expect(e.event).toBe("app_error");
    expect(e.properties).toMatchObject({ subsystem: "broker", error_name: "TypeError" });
    const blob = JSON.stringify(e.properties);
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("AAPL");
  });
});

describe("analytics allowlist + normalizers", () => {
  test("normalizers map raw values, unknown → other", () => {
    expect(sideOf("BUY")).toBe("buy");
    expect(sideOf("sell")).toBe("sell");
    expect(sideOf("weird")).toBe("other");
    expect(sideOf(null)).toBe("other");
    expect(assetTypeOf("mcp__robinhood__place_option_order")).toBe("option");
    expect(assetTypeOf("mcp__robinhood__place_equity_order")).toBe("equity");
    expect(assetTypeOf("something_else")).toBe("other");
    expect(orderTypeOf("LIMIT")).toBe("limit");
    expect(orderTypeOf("stop")).toBe("other");
    expect(orderKindOf("cancel")).toBe("cancel");
    expect(orderKindOf("place")).toBe("place");
    expect(templateOf("momentum")).toBe("momentum");
    expect(templateOf("custom-thing")).toBe("other");
  });

  test("errorNameOf normalizes to a bare identifier", () => {
    expect(errorNameOf(new TypeError("x"))).toBe("TypeError");
    expect(errorNameOf(new Error("y"))).toBe("Error");
    expect(errorNameOf("a string")).toBe("string");
  });

  test("error_name schema rejects anything but an identifier", () => {
    const ok = TELEMETRY_EVENTS.app_error.safeParse({
      subsystem: "host",
      error_name: "RangeError",
    });
    expect(ok.success).toBe(true);
    const bad = TELEMETRY_EVENTS.app_error.safeParse({
      subsystem: "host",
      error_name: "has spaces and /paths",
    });
    expect(bad.success).toBe(false);
  });

  test("RendererTrackInput rejects host-only events and non-renderer errors", () => {
    expect(RendererTrackInput.safeParse({ event: "host_started" }).success).toBe(false);
    expect(
      RendererTrackInput.safeParse({
        event: "onboarding_step_completed",
        props: { step: "broker" },
      }).success,
    ).toBe(true);
    // app_error is locked to subsystem "renderer" on the tRPC surface.
    expect(
      RendererTrackInput.safeParse({
        event: "app_error",
        props: { subsystem: "host", error_name: "X" },
      }).success,
    ).toBe(false);
    expect(
      RendererTrackInput.safeParse({
        event: "app_error",
        props: { subsystem: "renderer", error_name: "X" },
      }).success,
    ).toBe(true);
  });

  test("sanitizeStack keeps bundle frames only, drops internals + node_modules", () => {
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at foo (/Users/a/out/main/host.js:41231:17)",
      "    at task (node:internal/process/task_queues:95:5)",
      "    at ws (/Users/a/node_modules/ws/lib/index.js:10:2)",
      "    at main (/Users/a/out/main/index.js:5:9)",
    ].join("\n");
    expect(sanitizeStack(err)).toEqual(["host.js:41231:17", "index.js:5:9"]);
  });

  test("sanitizeStack caps at 10 frames", () => {
    const lines = ["Error: boom"];
    for (let i = 0; i < 15; i++) lines.push(`    at fn (/x/out/host.js:${i}:1)`);
    const err = new Error("boom");
    err.stack = lines.join("\n");
    const frames = sanitizeStack(err);
    expect(frames).toHaveLength(10);
    for (const f of frames) expect(f).toMatch(/^[\w.-]+\.js:\d+(:\d+)?$/);
  });
});
