import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the live Scout Runs screen exposes Bird X Source setup and readiness checking", () => {
  const source = readFileSync(new URL("./ReviewWorkspace.tsx", import.meta.url), "utf8");

  expect(source).toContain("trpc.recruiting.createXSource.useMutation");
  expect(source).toContain("trpc.recruiting.checkSourceReadiness.useMutation");
  expect(source).toContain("Add Bird X Source");
  expect(source).toContain("Check Source");
});

test("Scout Runs defaults to signal triage with a concise run story", () => {
  const source = readFileSync(new URL("./ReviewWorkspace.tsx", import.meta.url), "utf8");

  expect(source).toContain('useState<RunCenterTab>("signals")');
  expect(source).toContain('aria-label="Search signals"');
  expect(source).toContain("Run story");
  expect(source).toContain("Signal detail");
  expect(source).toContain("Committed checkpoint");
});
