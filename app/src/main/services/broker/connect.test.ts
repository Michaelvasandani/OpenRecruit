import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Account } from "@shared/broker";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { analytics, type CaptureClient } from "../analytics";
import { SettingsService } from "../settings";
import { type BrokerAdapter, ConnectSuperseded } from "./adapter";
import { BrokerService } from "./index";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sqlite.exec(
    "CREATE TABLE broker_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL)",
  );
  return drizzle(sqlite, { schema }) as unknown as Db;
}

interface Deferred {
  resolve: () => void;
  reject: (err: unknown) => void;
  opts: { interactive?: boolean };
}

/**
 * The slice of BrokerAdapter `connect()` touches, with `connect` a hand-controlled
 * promise per call so tests can hold one in flight and land a second on top of it.
 * `cancelConnect` does what the real one does to a pending interactive flow: rejects
 * it with ConnectSuperseded. (No account → the poller never starts.)
 */
class FakeAdapter {
  calls: Deferred[] = [];
  cancels = 0;
  connected = false;

  connect(opts: { interactive?: boolean } = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.calls.push({ resolve, reject, opts });
    });
  }
  cancelConnect(): void {
    this.cancels++;
    const pending = this.calls.find((c) => c.opts.interactive && !("done" in c));
    if (pending) {
      Object.assign(pending, { done: true });
      pending.reject(new ConnectSuperseded());
    }
  }
  /** Land call #i as connected. */
  succeed(i: number) {
    this.connected = true;
    Object.assign(this.calls[i], { done: true });
    this.calls[i].resolve();
  }
  fail(i: number, err: unknown) {
    Object.assign(this.calls[i], { done: true });
    this.calls[i].reject(err);
  }
  isConnected() {
    return this.connected;
  }
  resets = 0;
  reset() {
    this.resets++;
    this.cancelConnect();
    this.connected = false;
  }
  async listAccounts(): Promise<Account[]> {
    return [];
  }
}

interface Captured {
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

// The service reports through the module singleton, which wires itself once
// (`start` is idempotent), so capture into one fake client for the whole file and
// clear it per test.
const client = new FakeClient();
analytics.start({ settings: new SettingsService(memDb()), client });
beforeEach(() => {
  client.events.length = 0;
});

const services: BrokerService[] = [];
afterEach(() => {
  while (services.length) services.pop()?.stopPolling();
});

function setup() {
  const db = memDb();
  const settings = new SettingsService(db);
  const adapter = new FakeAdapter();
  const svc = new BrokerService(db, adapter as unknown as BrokerAdapter, settings, {
    agentForOrder: () => null,
  });
  services.push(svc);
  return { svc, adapter, client };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("BrokerService.connect — one connect at a time", () => {
  test("a silent connect joins the one in flight instead of starting another", async () => {
    const { svc, adapter } = setup();
    const first = svc.connect();
    await tick();
    const second = svc.connect();
    await tick();
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.cancels).toBe(0);
    adapter.succeed(0);
    await Promise.all([first, second]);
    expect(svc.getStatus()).toBe("connected");
  });

  test("an interactive connect supersedes a pending interactive one", async () => {
    const { svc, adapter, client } = setup();
    const first = svc.connect({ interactive: true });
    await tick();
    expect(svc.getStatus()).toBe("connecting");
    // The user clicks Connect again while the first is waiting on the browser.
    const second = svc.connect({ interactive: true });
    await tick();
    expect(adapter.cancels).toBe(1);
    // The abandoned call resolves quietly — no error to the caller, no failure event,
    // and the status is left to the attempt that took over.
    await first;
    expect(svc.getStatus()).toBe("connecting");
    expect(client.events.map((e) => e.event)).not.toContain("broker_connect_failed");
    // The second attempt is now the one in flight, and it can complete.
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1].opts.interactive).toBe(true);
    adapter.succeed(1);
    await second;
    expect(svc.getStatus()).toBe("connected");
    expect(client.events.map((e) => e.event)).toContain("broker_connected");
  });

  test("an interactive connect waits for a pending silent one, then proceeds", async () => {
    const { svc, adapter } = setup();
    const silent = svc.connect();
    await tick();
    const click = svc.connect({ interactive: true });
    await tick();
    // Nothing to cancel on the silent path (no browser waiting); it just runs to its end.
    expect(adapter.calls).toHaveLength(1);
    adapter.fail(0, new Error("silent path: no session"));
    await silent.catch(() => {});
    await tick();
    // …and only then does the click get its own attempt.
    expect(adapter.calls).toHaveLength(2);
    adapter.succeed(1);
    await click;
    expect(svc.getStatus()).toBe("connected");
  });

  test("once connected, further connects are no-ops", async () => {
    const { svc, adapter } = setup();
    const c = svc.connect();
    await tick();
    adapter.succeed(0);
    await c;
    await svc.connect({ interactive: true });
    expect(adapter.calls).toHaveLength(1);
  });
});

describe("BrokerService.disconnect — the user's Reset/Cancel", () => {
  test("while a consent is pending: abandons it, forgets the session, status → disconnected", async () => {
    const { svc, adapter, client } = setup();
    // The user clicked Connect and closed the browser tab: the flow is waiting on the
    // loopback with nothing to unstick it, the panel spinning on "connecting".
    const click = svc.connect({ interactive: true });
    await tick();
    expect(svc.getStatus()).toBe("connecting");
    await svc.disconnect();
    // The abandoned click resolves quietly (superseded), not as a failure…
    await click;
    expect(client.events.map((e) => e.event)).not.toContain("broker_connect_failed");
    // …the session is forgotten, and the Connect CTA is back.
    expect(adapter.resets).toBe(1);
    expect(svc.getStatus()).toBe("disconnected");
    // A fresh Connect starts a new attempt rather than joining anything stale.
    const again = svc.connect({ interactive: true });
    await tick();
    expect(adapter.calls).toHaveLength(2);
    adapter.succeed(1);
    await again;
    expect(svc.getStatus()).toBe("connected");
  });

  test("while connected: forgets the session and stops polling", async () => {
    const { svc, adapter } = setup();
    const c = svc.connect();
    await tick();
    adapter.succeed(0);
    await c;
    expect(svc.getStatus()).toBe("connected");
    await svc.disconnect();
    expect(adapter.resets).toBe(1);
    expect(svc.getStatus()).toBe("disconnected");
    expect(svc.getAccount()).toBeNull();
  });

  test("when idle: harmless", async () => {
    const { svc, adapter } = setup();
    await svc.disconnect();
    expect(adapter.resets).toBe(1);
    expect(svc.getStatus()).toBe("disconnected");
  });
});

describe("BrokerService.connect — failure telemetry", () => {
  test("broker_connect_failed carries the error's machine code when it has one", async () => {
    const { svc, adapter, client } = setup();
    const c = svc.connect({ interactive: true });
    await tick();
    adapter.fail(
      0,
      Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8771"), {
        code: "EADDRINUSE",
      }),
    );
    await expect(c).rejects.toBeDefined();
    expect(svc.getStatus()).toBe("error");
    const failed = client.events.find((e) => e.event === "broker_connect_failed");
    expect(failed?.properties).toMatchObject({ error_name: "Error", error_code: "EADDRINUSE" });
    expect(JSON.stringify(failed?.properties)).not.toContain("127.0.0.1");
  });

  test("…and omits it when there is none", async () => {
    const { svc, adapter, client } = setup();
    const c = svc.connect({ interactive: true });
    await tick();
    adapter.fail(0, new TypeError("fetch failed"));
    await expect(c).rejects.toBeDefined();
    const failed = client.events.find((e) => e.event === "broker_connect_failed");
    expect(failed?.properties).toMatchObject({ error_name: "TypeError" });
    expect(failed?.properties).not.toHaveProperty("error_code");
  });
});
