import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../../db/client";
import * as schema from "../../../db/schema";
import { BrokerOAuthProvider, ConsentRequired } from "./oauth";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function provider() {
  const opened: string[] = [];
  const p = new BrokerOAuthProvider({ db: memDb(), openBrowser: (u) => opened.push(u) });
  return { p, opened };
}

const TOKENS = { access_token: "a", token_type: "bearer", refresh_token: "r" };

describe("BrokerOAuthProvider", () => {
  test("beginAuthorization adopts the loopback URL and drops the stale registration", () => {
    const { p } = provider();
    p.saveClientInformation({ client_id: "old" });
    p.saveCodeVerifier("v-old");
    p.saveTokens(TOKENS);
    p.beginAuthorization("http://127.0.0.1:50123/callback");
    // What the SDK reads: registration metadata + auth request + code exchange all
    // agree on the freshly bound URL, and there's no client to reuse → re-register.
    expect(p.redirectUrl).toBe("http://127.0.0.1:50123/callback");
    expect(p.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:50123/callback"]);
    expect(p.clientInformation()).toBeUndefined();
    expect(() => p.codeVerifier()).toThrow();
    // Tokens are left alone — dropping them is the adapter's call.
    expect(p.hasTokens()).toBe(true);
  });

  test("outside a consent, redirectUrl is still a truthy string (SDK: not a non-interactive grant)", () => {
    const { p } = provider();
    expect(p.redirectUrl).toBeTruthy();
    p.beginAuthorization("http://127.0.0.1:50123/callback");
    p.endAuthorization();
    expect(p.redirectUrl).toBeTruthy();
    expect(p.redirectUrl).not.toBe("http://127.0.0.1:50123/callback");
  });

  test("the browser gate: silent throws ConsentRequired; inside a consent it opens", () => {
    const { p, opened } = provider();
    expect(() => p.redirectToAuthorization(new URL("https://robinhood.com/oauth"))).toThrow(
      ConsentRequired,
    );
    expect(opened).toEqual([]);

    p.beginAuthorization("http://127.0.0.1:50123/callback");
    p.redirectToAuthorization(new URL("https://robinhood.com/oauth?x=1"));
    expect(opened).toEqual(["https://robinhood.com/oauth?x=1"]);

    p.endAuthorization();
    expect(() => p.redirectToAuthorization(new URL("https://x"))).toThrow(ConsentRequired);
    expect(opened).toHaveLength(1);
  });
});
