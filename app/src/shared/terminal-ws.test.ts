import { describe, expect, test } from "bun:test";
import { withTerminalPort } from "./terminal-ws";

describe("withTerminalPort", () => {
  const url = "ws://127.0.0.1:43117/sessions/agent%201?token=a%2Bb&replay=1";

  test("swaps only the port, keeping the session path and token", () => {
    expect(withTerminalPort(url, 61001)).toBe(
      "ws://127.0.0.1:61001/sessions/agent%201?token=a%2Bb&replay=1",
    );
  });

  test("0 leaves the URL untouched", () => {
    expect(withTerminalPort(url, 0)).toBe(url);
  });
});
