import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Scout Runs exposes creation of a Bird-backed X Source", () => {
  const source = readFileSync(new URL("./ScoutRuns.tsx", import.meta.url), "utf8");

  expect(source).toContain("trpc.recruiting.createXSource.useMutation");
  expect(source).toContain("Add Bird X Source");
  expect(source).toContain('provider: "bird"');
});
