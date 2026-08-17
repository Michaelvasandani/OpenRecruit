import { describe, expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { isTransientNetworkError } from "./network-error";

// The shape Node's undici `fetch` throws on a network failure — a bare
// `TypeError: fetch failed` with the code on `.cause` — as probed under Node 22 (the
// host runs Electron's Node). Constructed rather than fetched live: bun's own `fetch`
// throws a different shape, so a live probe here would test the wrong runtime.
const withCause = (code: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

describe("isTransientNetworkError", () => {
  test("the sleep/wake family — code on the cause, as undici reports it", () => {
    for (const code of [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ]) {
      expect(isTransientNetworkError(withCause(code))).toBe(true);
    }
    // …and on the error itself (a raw socket error surfacing without a fetch wrapper).
    expect(
      isTransientNetworkError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    ).toBe(true);
    // A bare `fetch failed` with an unrecognized cause is still transport-level.
    expect(isTransientNetworkError(new TypeError("fetch failed", { cause: new Error("?") }))).toBe(
      true,
    );
  });

  test("not transient: bugs, protocol errors, HTTP failures, other codes", () => {
    // A mapping bug in our own code is a TypeError too — but not `fetch failed`.
    expect(isTransientNetworkError(new TypeError("Cannot read properties of undefined"))).toBe(
      false,
    );
    expect(isTransientNetworkError(new McpError(-32601, "Method not found"))).toBe(false);
    expect(
      isTransientNetworkError(Object.assign(new Error("listen"), { code: "EADDRINUSE" })),
    ).toBe(false);
    expect(isTransientNetworkError(new Error("broker not connected"))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError("ECONNRESET")).toBe(false);
  });
});
