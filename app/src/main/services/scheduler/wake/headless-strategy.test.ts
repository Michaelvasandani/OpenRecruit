import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@shared/agent";
import { hostLog } from "../../../host/log";
import type { AgentRegistry } from "../../agents/registry";
import { registerHarness } from "../../harness";
import { claudeHarness } from "../../harness/claude";
import { HeadlessRunStrategy } from "./headless-strategy";

describe("HeadlessRunStrategy harness output", () => {
  test("preserves a UTF-8 character split across stderr chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-utf8-"));
    const agent: Agent = {
      id: "utf8-scout",
      slug: "utf8-scout",
      name: "UTF-8 Scout",
      template: "default",
      harness: "claude",
      lastSessionId: null,
      status: "idle",
      executionState: "offline",
      headlessTurnsUsed: 0,
      turnLimitEnabled: true,
      lastActiveAt: null,
      createdAt: 1,
      archivedAt: null,
    };
    const registry = {
      get: (id: string) => (id === agent.id ? agent : undefined),
      agentDir: () => dir,
      setLastSessionId: (_id: string, sessionId: string) => {
        agent.lastSessionId = sessionId;
      },
    } as unknown as AgentRegistry;
    const localApi = { port: 43123, token: "test-token" };
    const before = (() => {
      try {
        return readFileSync(hostLog.file, "utf8").length;
      } catch {
        return 0;
      }
    })();

    registerHarness({
      ...claudeHarness,
      binary: process.execPath,
      writeConfig: () => {},
      headlessArgs: () => [
        "-e",
        "process.stderr.write(Buffer.from([0xe2])); setTimeout(() => { process.stderr.write(Buffer.from([0x82, 0xac])); process.exit(1); }, 50);",
      ],
    });

    try {
      const strategy = new HeadlessRunStrategy(registry, localApi as never);
      await new Promise<void>((resolve) => strategy.run(agent.id, "search", () => resolve()));
      const written = readFileSync(hostLog.file, "utf8").slice(before);

      expect(written).toContain("stderr: €");
      expect(written).not.toContain("�");
    } finally {
      registerHarness(claudeHarness);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
