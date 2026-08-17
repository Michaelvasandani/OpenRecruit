import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../../db/client";
import * as schema from "../../../db/schema";
import { ConnectSuperseded } from "../adapter";
import {
  isReauthRequired,
  type Loopback,
  OAuthFlowError,
  oauthErrorCode,
  openLoopback,
  RobinhoodAdapter,
} from "./client";
import { ConsentRequired } from "./oauth";

describe("isReauthRequired", () => {
  test("401 (UnauthorizedError) → re-auth", () => {
    expect(isReauthRequired(new UnauthorizedError("no token"))).toBe(true);
  });

  test("expired/revoked refresh token (InvalidGrantError) → re-auth", () => {
    // The exact case that broke reconnect: the SDK re-throws this on a dead grant.
    expect(isReauthRequired(new InvalidGrantError("invalid_grant"))).toBe(true);
  });

  test("transient ServerError → NOT re-auth (must not nuke a valid session)", () => {
    expect(isReauthRequired(new ServerError("upstream 5xx"))).toBe(false);
  });

  test("generic errors / non-errors → NOT re-auth (propagate)", () => {
    expect(isReauthRequired(new Error("boom"))).toBe(false);
    expect(isReauthRequired(new TypeError("bad"))).toBe(false);
    expect(isReauthRequired("invalid_grant")).toBe(false);
    expect(isReauthRequired(undefined)).toBe(false);
    expect(isReauthRequired(null)).toBe(false);
  });
});

describe("oauthErrorCode", () => {
  test("maps an RFC 6749 callback error to OAUTH_*; anything else is OAUTH_UNKNOWN", () => {
    expect(oauthErrorCode("access_denied")).toBe("OAUTH_ACCESS_DENIED");
    expect(oauthErrorCode("server_error")).toBe("OAUTH_SERVER_ERROR");
    expect(oauthErrorCode(null)).toBe("OAUTH_UNKNOWN");
    expect(oauthErrorCode("")).toBe("OAUTH_UNKNOWN");
    // A closed whitelist: free text can't ride along, even as letters.
    expect(oauthErrorCode("bad thing /Users/alice")).toBe("OAUTH_UNKNOWN");
    expect(oauthErrorCode("ACCESS_DENIED")).toBe("OAUTH_UNKNOWN");
  });
});

// ---- the loopback listener ----

const open: Loopback[] = [];
const servers: Server[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
  while (servers.length) servers.pop()?.close();
});

async function loopback(opts: { timeoutMs?: number; port?: number } = {}): Promise<Loopback> {
  const lb = await openLoopback(opts);
  open.push(lb);
  return lb;
}

/** Hit the loopback's callback like the browser redirect would. */
async function callback(lb: Loopback, query: string): Promise<Response> {
  return fetch(`${lb.redirectUrl}?${query}`);
}

/** Watch for unhandled rejections during `fn` — the exact bug that fired `app_error`. */
async function noUnhandledRejections(fn: () => Promise<void>): Promise<void> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await fn();
    // Give the microtask queue + a macrotask turn a chance to surface anything.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(seen).toEqual([]);
}

describe("openLoopback", () => {
  test("binds an ephemeral 127.0.0.1 port; two loopbacks never collide", async () => {
    const a = await loopback();
    const b = await loopback();
    const portOf = (lb: Loopback) => Number(new URL(lb.redirectUrl).port);
    expect(new URL(a.redirectUrl).hostname).toBe("127.0.0.1");
    expect(new URL(a.redirectUrl).pathname).toBe("/callback");
    expect(portOf(a)).toBeGreaterThan(0);
    expect(portOf(b)).toBeGreaterThan(0);
    expect(portOf(a)).not.toBe(portOf(b));
    // Nothing is pinned to the old fixed port anymore.
    expect(portOf(a)).not.toBe(8771);
  });

  test("resolves the code from the callback and answers the browser with a page", async () => {
    const lb = await loopback();
    const res = await callback(lb, "code=abc123&state=opentrade");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OpenTrade connected");
    expect(await lb.code).toBe("abc123");
  });

  test("an OAuth error on the callback rejects with a bounded OAUTH_* code", async () => {
    const lb = await loopback();
    const res = await callback(lb, "error=access_denied&error_description=The+user+declined");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Authorization failed");
    const err = await lb.code.catch((e) => e);
    expect(err).toBeInstanceOf(OAuthFlowError);
    expect(err.name).toBe("OAuthFlowError");
    expect(err.code).toBe("OAUTH_ACCESS_DENIED");
    // The description (free text) is never carried on the error.
    expect(String(err.message)).not.toContain("declined");
  });

  test("other paths 404 and don't settle the flow", async () => {
    const lb = await loopback();
    const res = await fetch(new URL("/favicon.ico", lb.redirectUrl));
    expect(res.status).toBe(404);
    let settled = false;
    lb.code.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });

  test("times out with OAUTH_TIMEOUT and releases the port", async () => {
    const lb = await loopback({ timeoutMs: 30 });
    const err = await lb.code.catch((e) => e);
    expect(err).toBeInstanceOf(OAuthFlowError);
    expect(err.code).toBe("OAUTH_TIMEOUT");
    // The port is free again: nobody answers on it.
    await expect(callback(lb, "code=late")).rejects.toBeDefined();
  });

  test("close() on a pending flow rejects with ConnectSuperseded and releases the port", async () => {
    const lb = await loopback();
    lb.close();
    const err = await lb.code.catch((e) => e);
    expect(err).toBeInstanceOf(ConnectSuperseded);
    await expect(callback(lb, "code=late")).rejects.toBeDefined();
  });

  test("a rejection nobody is awaiting yet is NOT an unhandledRejection", async () => {
    // The consumer awaits `code` only after a network round-trip; before this fix, a
    // listener error rejecting in that window surfaced as `unhandledRejection` → the
    // `app_error {subsystem: host, error_name: Error, source: unhandled_rejection}` seen
    // in telemetry, with no useful detail.
    await noUnhandledRejections(async () => {
      const lb = await loopback();
      lb.close();
      await new Promise((r) => setTimeout(r, 10)); // still un-awaited here
      const err = await lb.code.catch((e) => e); // the real await still sees it
      expect(err).toBeInstanceOf(ConnectSuperseded);
    });
  });

  test("a bind failure rejects openLoopback itself (before any browser opens)", async () => {
    // Occupy a port, then ask the loopback for that exact port.
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as { port: number }).port;
    await noUnhandledRejections(async () => {
      const err = await openLoopback({ port }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("EADDRINUSE");
    });
  });
});

// ---- the adapter's connect() branching + the interactive flow ----

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

/**
 * The adapter with the two network calls stubbed: `doConnect` (the MCP client
 * connect that drives the SDK's auth) and `exchangeCode` (the token exchange). What
 * the stubs do is scripted per test; everything else — the loopback, the provider,
 * the branching in `connect()` / `interactiveConnect()` — is the real code.
 */
class TestAdapter extends RobinhoodAdapter {
  connectScript: (call: number) => Promise<void> = async () => {};
  connectCalls = 0;
  exchanged: string[] = [];
  opened: string[] = [];

  constructor(db: Db) {
    const opened: string[] = [];
    super({ db, openBrowser: (url) => opened.push(url) });
    this.opened = opened;
  }

  get prov() {
    return this.provider;
  }

  protected override async doConnect(): Promise<void> {
    this.connectCalls++;
    await this.connectScript(this.connectCalls);
  }

  protected override async exchangeCode(code: string): Promise<void> {
    this.exchanged.push(code);
  }

  /** The SDK's move when it wants consent: ask the provider to open the browser. */
  wantConsent() {
    this.prov.redirectToAuthorization(new URL("https://robinhood.com/oauth?x=1"));
    throw new UnauthorizedError("redirect");
  }
}

const TOKENS = { access_token: "a", token_type: "bearer", refresh_token: "r" };

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const adapters: TestAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()?.cancelConnect();
});
function adapter(): TestAdapter {
  const a = new TestAdapter(memDb());
  adapters.push(a);
  return a;
}

describe("RobinhoodAdapter.connect — silent vs interactive", () => {
  test("silent + tokens + ConsentRequired: keeps the tokens, no browser, stays disconnected", async () => {
    const a = adapter();
    a.prov.saveTokens(TOKENS);
    a.connectScript = async () => a.wantConsent();
    await a.connect();
    expect(a.isConnected()).toBe(false);
    expect(a.hasTokens()).toBe(true); // the refresh failed transiently — don't nuke it
    expect(a.opened).toEqual([]); // never a browser unprompted
  });

  test("silent + tokens + InvalidGrantError (dead grant): drops the tokens, no browser", async () => {
    const a = adapter();
    a.prov.saveTokens(TOKENS);
    a.connectScript = async () => {
      throw new InvalidGrantError("invalid_grant");
    };
    await a.connect();
    expect(a.hasTokens()).toBe(false);
    expect(a.opened).toEqual([]);
  });

  test("silent + tokens + transient ServerError: propagates, tokens kept", async () => {
    const a = adapter();
    a.prov.saveTokens(TOKENS);
    a.connectScript = async () => {
      throw new ServerError("5xx");
    };
    await expect(a.connect()).rejects.toBeInstanceOf(ServerError);
    expect(a.hasTokens()).toBe(true);
    expect(a.opened).toEqual([]);
  });

  test("silent + no tokens: nothing happens", async () => {
    const a = adapter();
    await a.connect();
    expect(a.connectCalls).toBe(0);
    expect(a.opened).toEqual([]);
  });

  test("interactive + tokens + ConsentRequired: fresh consent replaces the session", async () => {
    const a = adapter();
    a.prov.saveTokens(TOKENS);
    a.connectScript = async (call) => {
      if (call === 1) a.wantConsent(); // the token connect: SDK wants a browser
      if (call === 2) a.wantConsent(); // interactiveConnect's kickoff: now allowed
      // call 3 (after the exchange): connected
    };
    const done = a.connect({ interactive: true });
    await until(() => a.opened.length === 1);
    expect(a.hasTokens()).toBe(false); // the maybe-good session was dropped for a fresh one
    // Complete the consent on the loopback the flow bound.
    await fetch(`${a.prov.redirectUrl}?code=fresh`);
    await done;
    expect(a.exchanged).toEqual(["fresh"]);
    expect(a.connectCalls).toBe(3);
  });
});

describe("RobinhoodAdapter interactive consent flow", () => {
  test("registers under the loopback's redirect URL, opens one browser, exchanges the code", async () => {
    const a = adapter();
    // A stale registration from an earlier, abandoned attempt (made under a different
    // port). It must not be reused — Robinhood would reject the redirect_uri.
    a.prov.saveClientInformation({ client_id: "stale" });
    a.connectScript = async (call) => {
      if (call === 1) {
        // What the SDK sees at this point: no client (cleared → will re-register), a
        // redirect URL pointing at the loopback that was just bound.
        expect(a.prov.clientInformation()).toBeUndefined();
        expect(a.prov.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        expect(a.prov.clientMetadata.redirect_uris).toEqual([a.prov.redirectUrl]);
        a.wantConsent();
      }
    };
    const done = a.connect({ interactive: true });
    await until(() => a.opened.length === 1);
    expect(a.opened[0]).toContain("robinhood.com/oauth");
    await fetch(`${a.prov.redirectUrl}?code=c1`);
    await done;
    expect(a.exchanged).toEqual(["c1"]);
    expect(a.connectCalls).toBe(2);
    // The browser gate closed again once the flow ended.
    expect(() => a.prov.redirectToAuthorization(new URL("https://x"))).toThrow(ConsentRequired);
  });

  test("the user declining rejects the connect with OAUTH_ACCESS_DENIED", async () => {
    const a = adapter();
    a.connectScript = async () => a.wantConsent();
    // Capture the outcome up front: the rejection lands on a later I/O turn than the
    // callback fetch resolves on, so a late `.catch` would read as unhandled.
    const outcome = a.connect({ interactive: true }).then(
      () => null,
      (e) => e,
    );
    await until(() => a.opened.length === 1);
    await fetch(`${a.prov.redirectUrl}?error=access_denied`);
    const err = await outcome;
    expect(err).toBeInstanceOf(OAuthFlowError);
    expect(err.code).toBe("OAUTH_ACCESS_DENIED");
    expect(a.exchanged).toEqual([]);
  });

  test("a second interactive connect supersedes a pending one — no overlap, no unhandled rejection", async () => {
    await noUnhandledRejections(async () => {
      const a = adapter();
      a.connectScript = async (call) => {
        if (call === 1 || call === 2) a.wantConsent();
      };
      const first = a.connect({ interactive: true }).then(
        () => null,
        (e) => e,
      );
      await until(() => a.opened.length === 1);
      const firstUrl = a.prov.redirectUrl;

      // The user clicks Connect again (from another surface / a remounted screen).
      const second = a.connect({ interactive: true });
      // The first attempt is abandoned in favor of the second — quietly, with a marker
      // the service recognizes, not a generic failure.
      expect(await first).toBeInstanceOf(ConnectSuperseded);
      // Its loopback is gone…
      await expect(fetch(`${firstUrl}?code=late`)).rejects.toBeDefined();
      // …and the second bound its own, on a different port, and opened its own browser.
      await until(() => a.opened.length === 2);
      expect(a.prov.redirectUrl).not.toBe(firstUrl);
      await fetch(`${a.prov.redirectUrl}?code=c2`);
      await second;
      expect(a.exchanged).toEqual(["c2"]);
    });
  });
});
