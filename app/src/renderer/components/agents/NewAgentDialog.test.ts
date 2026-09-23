import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Ashby source setup explains Web Search discovery and deterministic verification", () => {
  const source = readFileSync(new URL("./NewAgentDialog.tsx", import.meta.url), "utf8");
  const normalized = source.replace(/\s+/g, " ");

  expect(source).toContain('if (kind === "ashby")');
  expect(source).toContain('return ["WebSearch", "AshbyInspectJobs", "RecordSignal"]');
  expect(source).toContain('"AshbyInspectJobs"');
  expect(source).toContain('"RecordSignal"');
  expect(normalized).toContain("Company or board seed lists are optional");
});
