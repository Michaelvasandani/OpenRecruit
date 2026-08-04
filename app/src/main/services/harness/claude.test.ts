import { describe, expect, test } from "bun:test";
import { claudeHarness } from "./claude";

const CHANNEL = "--dangerously-load-development-channels=server:opentrade";

describe("claudeHarness argv builders (behavior locked by the seam refactor)", () => {
  test("interactive start with kickoff: kickoff stays the trailing positional", () => {
    expect(claudeHarness.interactiveArgs("start", "sid-1", "hello agent")).toEqual([
      "--session-id",
      "sid-1",
      CHANNEL,
      "hello agent",
    ]);
  });

  test("interactive start without kickoff", () => {
    expect(claudeHarness.interactiveArgs("start", "sid-1")).toEqual([
      "--session-id",
      "sid-1",
      CHANNEL,
    ]);
    expect(claudeHarness.interactiveArgs("start", "sid-1", null)).toEqual([
      "--session-id",
      "sid-1",
      CHANNEL,
    ]);
  });

  test("interactive resume", () => {
    expect(claudeHarness.interactiveArgs("resume", "sid-2")).toEqual([
      "--resume",
      "sid-2",
      CHANNEL,
    ]);
  });

  test("headless resume: skip-permissions one-shot with the wake prompt", () => {
    expect(claudeHarness.headlessArgs("resume", "sid-3", "[OPENTRADE WAKE t] go")).toEqual([
      "--resume",
      "sid-3",
      "--dangerously-skip-permissions",
      "-p",
      "[OPENTRADE WAKE t] go",
    ]);
  });

  test("headless start mints the conversation headlessly", () => {
    expect(claudeHarness.headlessArgs("start", "sid-4", "p")).toEqual([
      "--session-id",
      "sid-4",
      "--dangerously-skip-permissions",
      "-p",
      "p",
    ]);
  });

  test("interactive env forces the no-flicker fullscreen renderer", () => {
    expect(claudeHarness.interactiveEnv()).toEqual({ CLAUDE_CODE_NO_FLICKER: "1" });
  });
});
