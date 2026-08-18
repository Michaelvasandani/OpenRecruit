import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { brokerErrorCode, isTransientNetworkError } from "./network-error";

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

  test("MCP request/transport failures from a sleep-interrupted poll are transient", () => {
    // The POST connected, then the machine froze mid-request → the SDK's 60 s timer or a
    // detected stream close, rather than a connect-time `fetch failed`.
    expect(
      isTransientNetworkError(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    ).toBe(true);
    expect(
      isTransientNetworkError(new McpError(ErrorCode.ConnectionClosed, "Connection closed")),
    ).toBe(true);
  });

  test("not transient: bugs, server-side protocol errors, HTTP failures, other codes", () => {
    // A mapping bug in our own code is a TypeError too — but not `fetch failed`.
    expect(isTransientNetworkError(new TypeError("Cannot read properties of undefined"))).toBe(
      false,
    );
    // A genuine server-side JSON-RPC error is the app's problem, not the network's.
    expect(
      isTransientNetworkError(new McpError(ErrorCode.MethodNotFound, "Method not found")),
    ).toBe(false);
    expect(isTransientNetworkError(new McpError(ErrorCode.InternalError, "boom"))).toBe(false);
    expect(
      isTransientNetworkError(Object.assign(new Error("listen"), { code: "EADDRINUSE" })),
    ).toBe(false);
    expect(isTransientNetworkError(new Error("broker not connected"))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError("ECONNRESET")).toBe(false);
  });
});

describe("brokerErrorCode", () => {
  test("maps an McpError's numeric code to its enum name (a bounded identifier)", () => {
    expect(brokerErrorCode(new McpError(ErrorCode.RequestTimeout, "x"))).toBe("RequestTimeout");
    expect(brokerErrorCode(new McpError(ErrorCode.ConnectionClosed, "x"))).toBe("ConnectionClosed");
    // A server's own numeric code with no enum name → undefined (correctly dropped, not
    // leaked as a raw number the allowlist regex would reject anyway).
    expect(brokerErrorCode(new McpError(-32050 as ErrorCode, "custom"))).toBeUndefined();
  });

  test("falls back to errorCodeOf for the transport cases", () => {
    expect(brokerErrorCode(withCause("ECONNRESET"))).toBe("ECONNRESET");
    expect(brokerErrorCode(Object.assign(new Error("listen"), { code: "EADDRINUSE" }))).toBe(
      "EADDRINUSE",
    );
    expect(
      brokerErrorCode(new TypeError("fetch failed", { cause: new Error("?") })),
    ).toBeUndefined();
  });
});
