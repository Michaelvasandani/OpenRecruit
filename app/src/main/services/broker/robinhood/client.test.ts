import { describe, expect, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { isReauthRequired } from "./client";

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
