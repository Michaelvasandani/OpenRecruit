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
    expect(instructions).toContain("harness-native web search");
    expect(instructions).toContain("Claude WebSearch or Codex built-in web search");
    expect(instructions).toContain("Candidate-provided company or board seeds are optional");
    expect(instructions).toContain(
      "Reserve each Source's tools for that explicitly selected Source",
    );
    expect(instructions).toContain("AshbyInspectJobs");
    expect(instructions).toContain("XSearch and XRead");
    expect(instructions).toContain("record_source_outcome");
    expect(instructions).toContain("RecordSignal");
    expect(instructions).toContain("Primary evidence is preferred, not mandatory");
    expect(instructions).toContain("verification caveat");
    expect(instructions).toContain("complete_run");
  });

  test("names only the Sources pinned to the Run", () => {
    const instructions = recruitingProviderInstructions({
      runId: "run-hn",
      strategyMaterial: "Find matching public roles.",
      policyMaterial: "Use selected Sources only.",
      sourceKinds: ["hacker_news"],
    });
    expect(instructions).toContain("HackerNewsJobs");
    expect(instructions).toContain("record_source_outcome");
    expect(instructions).toContain("do not mention, suggest, or fall back to any other Source");
    expect(instructions).not.toMatch(/ashby/i);
    expect(instructions).not.toContain("XSearch");
    expect(instructions).not.toContain("OpenRecruit WebSearch");
    expect(instructions).toMatch(/\n2\. Call HackerNewsJobs[^\n]*\n3\. Primary evidence/);
  });

  test("selected job boards share one playbook that names only those boards", () => {
    const instructions = recruitingProviderInstructions({
      runId: "run-boards",
      strategyMaterial: "Find matching public roles.",
      policyMaterial: "Use selected Sources only.",
      sourceKinds: ["greenhouse", "workday"],
    });
    expect(instructions).toContain("### Job boards (Greenhouse, Workday)");
    expect(instructions).toContain("site:job-boards.greenhouse.io");
    expect(instructions).toContain("site:myworkdayjobs.com");
    expect(instructions).toContain("Workday boards cannot be enumerated");
    expect(instructions).not.toContain("jobs.lever.co");
    expect(instructions).not.toMatch(/ashby/i);
    // Boards have their own evidence path, so Web Search is not a fallback.
    expect(instructions).not.toContain("OpenRecruit WebSearch");
    expect(instructions).toMatch(/\n2\. Pass every posting URL[^\n]*JobPostingInspect/);
    expect(instructions).toMatch(/\n3\. Call RecordSignal[^\n]*JobPostingInspect/);
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

  test("states the host clock and listing cutoff in the Run prompt", () => {
    const prompt = recruitingProviderInstructions({
      runId: "run-1",
      strategyMaterial: "Find engineering roles.",
      policyMaterial: "Only surface job listings published within the past 7 days.",
      now: Date.parse("2026-09-18T12:00:00.000Z"),
    });
    expect(prompt).toContain("the current time is 2026-09-18T12:00:00.000Z");
    expect(prompt).toContain("published at or after 2026-09-11T12:00:00.000Z");
  });
});
