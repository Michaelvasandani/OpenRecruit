import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { bus } from "../event-bus";
import {
  BirdOperationCancelledError,
  enqueueBirdOperation,
  executeBirdSearch,
  probeBirdExecutable,
} from "./bird";
import { type BirdProbe, SettingsService } from "./index";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function executablePath(): string {
  const path = join(tmpdir(), `openrecruit-bird-settings-${crypto.randomUUID()}`);
  writeFileSync(path, "bird executable fixture");
  chmodSync(path, 0o755);
  return path;
}

function probe(path: string, account = "candidate") {
  const fingerprint = createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    configuredPath: path,
    resolvedPath: realpathSync(path),
    fingerprint,
    readiness: "ready" as const,
    safeFailure: null,
    detectedVersion: "0.8.0",
    accountIdentity: { id: "123", username: account, displayName: "Candidate" },
  };
}

describe("Bird settings", () => {
  test("serializes one authenticated account lane and removes queued cancellation", async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const first = enqueueBirdOperation("test-account", undefined, async () => {
      order.push("first:start");
      await Bun.sleep(30);
      order.push("first:end");
      return "first";
    });
    const second = enqueueBirdOperation("test-account", controller.signal, async () => {
      order.push("second:start");
      return "second";
    });
    setTimeout(() => controller.abort(), 5);
    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { value: "first" } });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      BirdOperationCancelledError,
    );
    expect(order).toEqual(["first:start", "first:end"]);
  });

  test("bounds a Bird operation below the global twenty-second timeout", async () => {
    const executable = join(tmpdir(), `openrecruit-bird-timeout-${crypto.randomUUID()}`);
    writeFileSync(executable, "#!/bin/sh\nsleep 1\nprintf '%s' 'should-not-return'");
    chmodSync(executable, 0o755);
    const result = await executeBirdSearch(executable, "hiring", 1, undefined, 10);
    expect(result.timedOut).toBe(true);
    expect(result.failureCategory).toBe("timed_out");
    expect(result.stdout).toBe("");
  });

  test("defaults to an unconfigured safe projection", () => {
    expect(new SettingsService(memDb()).get().bird).toMatchObject({
      configured: false,
      configuredPath: null,
      readiness: "not_configured",
      consentCurrent: false,
      accountIdentity: null,
    });
  });

  test("requires an absolute path and tests a saved executable without exposing output", async () => {
    const path = executablePath();
    const seen: string[] = [];
    const birdProbe: BirdProbe = async (configuredPath) => {
      seen.push(configuredPath);
      return probe(configuredPath);
    };
    const service = new SettingsService(memDb(), { birdProbe });
    expect(() => service.setBirdPath("bird")).toThrow(/absolute path/i);
    service.setBirdPath(path);
    const result = await service.testBird();
    expect(seen).toEqual([path]);
    expect(result).toMatchObject({
      configured: true,
      readiness: "ready",
      detectedVersion: "0.8.0",
      fingerprintSummary: expect.stringContaining("SHA-256"),
      accountIdentity: { id: "123", username: "candidate" },
      consentCurrent: false,
    });
    expect(JSON.stringify(result)).not.toContain('"fingerprint":"');
  });

  test("binds consent and invalidates it after executable replacement", async () => {
    const path = executablePath();
    const service = new SettingsService(memDb(), { birdProbe: async (p) => probe(p) });
    service.setBirdPath(path);
    await service.testBird();
    expect(service.confirmBirdConsent()).toBeDefined();
    expect(service.get().bird.consentCurrent).toBe(true);

    writeFileSync(path, "replacement executable fixture");
    expect(service.get().bird.consentCurrent).toBe(false);
    expect(service.get().bird.safeFailure).toMatch(/changed/i);
  });

  test("fails closed for an unsupported detected version", async () => {
    const path = executablePath();
    const service = new SettingsService(memDb(), {
      birdProbe: async (configuredPath) => ({
        ...probe(configuredPath),
        readiness: "unsupported",
        detectedVersion: "0.9.0",
        accountIdentity: null,
        safeFailure: "raw unsupported output must not cross the boundary",
      }),
    });
    service.setBirdPath(path);
    const result = await service.testBird();
    expect(result).toMatchObject({
      readiness: "unsupported",
      detectedVersion: "0.9.0",
      safeFailure: "Bird 0.9.0 is unsupported; OpenRecruit requires Bird 0.8.0",
      consentCurrent: false,
    });
    expect(JSON.stringify(result)).not.toContain("raw unsupported output");
  });

  test("uses OPENRECRUIT_BIRD_PATH as a host-only override", async () => {
    const persistedPath = executablePath();
    const overridePath = executablePath();
    const previous = process.env.OPENRECRUIT_BIRD_PATH;
    process.env.OPENRECRUIT_BIRD_PATH = overridePath;
    try {
      const seen: string[] = [];
      const service = new SettingsService(memDb(), {
        birdProbe: async (configuredPath) => {
          seen.push(configuredPath);
          return probe(configuredPath);
        },
      });
      service.setBirdPath(persistedPath);
      await service.testBird();
      expect(seen).toEqual([overridePath]);
      expect(service.get().bird.configuredPath).toBe(overridePath);
    } finally {
      if (previous === undefined) delete process.env.OPENRECRUIT_BIRD_PATH;
      else process.env.OPENRECRUIT_BIRD_PATH = previous;
    }
  });

  test("draft tests do not persist a path or metadata", async () => {
    const path = executablePath();
    const service = new SettingsService(memDb(), { birdProbe: async (p) => probe(p) });
    const result = await service.testBird({ path });
    expect(result).toMatchObject({ configured: true, readiness: "ready", consentCurrent: false });
    expect(service.get().bird).toMatchObject({ configured: false, readiness: "not_configured" });
  });

  test("clearing removes active Bird metadata but leaves unrelated settings intact", async () => {
    const path = executablePath();
    const service = new SettingsService(memDb(), { birdProbe: async (p) => probe(p) });
    service.setBirdPath(path);
    await service.testBird();
    service.confirmBirdConsent();
    service.update({ telemetryEnabled: false });
    service.clearBird();
    expect(service.get().bird).toMatchObject({ configured: false, readiness: "not_configured" });
    expect(service.get().telemetryEnabled).toBe(false);
  });

  test("broadcasts only safe readiness metadata", async () => {
    const path = executablePath();
    const service = new SettingsService(memDb(), { birdProbe: async (p) => probe(p) });
    const payloads: string[] = [];
    const off = bus.onEvent("settings:changed", (value) => payloads.push(JSON.stringify(value)));
    try {
      service.setBirdPath(path);
      await service.testBird();
    } finally {
      off();
    }
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads.every((payload) => !payload.includes('"fingerprint":"'))).toBe(true);
    expect(payloads.every((payload) => !payload.includes("cookie"))).toBe(false); // warning is safe and intentional
    expect(payloads.every((payload) => !payload.includes("auth_token"))).toBe(true);
  });
});

const configuredBirdPath = process.env.OPENRECRUIT_BIRD_PATH?.trim();
(configuredBirdPath ? test : test.skip)(
  "real configured Bird integration runs only the setup readiness contract",
  async () => {
    const result = await probeBirdExecutable(configuredBirdPath as string);
    expect(result.detectedVersion).toBe("0.8.0");
    expect(result.readiness).toBe("ready");
    expect(result.accountIdentity).not.toBeNull();
  },
);
