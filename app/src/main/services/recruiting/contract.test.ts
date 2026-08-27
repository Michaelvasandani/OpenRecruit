import { describe, expect, test } from "bun:test";
import {
  assertSafeMaterial,
  PROHIBITED_RECRUITING_CAPABILITIES,
  recruitingOperationsFor,
  recruitingProviderInstructions,
  validateRecruitingOperation,
} from "./contract";

describe("provider-neutral Recruiting contract", () => {
  test("gives Claude and Codex the same bounded operations", () => {
    const claude = recruitingOperationsFor("claude");
    const codex = recruitingOperationsFor("codex");
    expect(claude).toEqual(codex);
    expect(claude.map((operation) => operation.name)).toEqual([
      "read_run_context",
      "list_selected_sources",
      "record_checkpoint",
      "record_source_outcome",
      "record_signal",
      "complete_run",
    ]);
    const instructions = recruitingProviderInstructions({
      runId: "run-1",
      strategyMaterial: "Find matching public roles.",
      policyMaterial: "Use selected Sources only.",
    });
    expect(instructions).toContain("OpenRecruit WebSearch and WebFetch");
    expect(instructions).toContain("record_source_outcome");
    expect(instructions).toContain("RecordSignal");
    expect(instructions).toContain("complete_run");
  });

  test("fails closed for unrestricted or externally communicative capabilities", () => {
    expect(PROHIBITED_RECRUITING_CAPABILITIES).toEqual(
      expect.arrayContaining([
        "unrestricted_sql",
        "arbitrary_http",
        "credentials",
        "posting",
        "messaging",
        "applications",
        "access_control_bypass",
      ]),
    );
    expect(() => validateRecruitingOperation("execute_sql")).toThrow(/not permitted/i);
    expect(() => validateRecruitingOperation("send_message")).toThrow(/not permitted/i);
    expect(() => validateRecruitingOperation("record_checkpoint")).not.toThrow();
    expect(() =>
      assertSafeMaterial("Never use credentials or send messages.", "Scout Policy"),
    ).not.toThrow();
    expect(() =>
      assertSafeMaterial("Use arbitrary HTTP and send messages to employers.", "Scout Policy"),
    ).toThrow(/prohibited capability/i);
    expect(() => assertSafeMaterial("Use arbitrary HTTP requests.", "Scout Policy")).toThrow(
      /prohibited capability/i,
    );
    expect(() =>
      assertSafeMaterial("Never use credentials; send messages.", "Scout Policy"),
    ).toThrow(/prohibited capability/i);
    expect(() =>
      recruitingProviderInstructions({
        runId: "run-1",
        strategyMaterial: "Use arbitrary HTTP requests.",
        policyMaterial: "Safe policy",
      }),
    ).toThrow(/prohibited capability/i);
  });
});
