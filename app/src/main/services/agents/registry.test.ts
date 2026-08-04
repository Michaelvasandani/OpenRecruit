import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";

// Isolate OPENTRADE_HOME to a throwaway dir before the registry module (which derives
// AGENTS_DIR from it) loads — hence the dynamic import in beforeAll.
const HOME = mkdtempSync(join(tmpdir(), "registry-home-"));
process.env.OPENTRADE_HOME = HOME;

let AgentRegistry: typeof import("./registry").AgentRegistry;
beforeAll(async () => {
  ({ AgentRegistry } = await import("./registry"));
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function memRegistry() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, template TEXT NOT NULL,
    harness TEXT NOT NULL DEFAULT 'claude',
    approval_mode TEXT NOT NULL, last_session_id TEXT, status TEXT NOT NULL,
    headless_turns_used INTEGER NOT NULL DEFAULT 0,
    turn_limit_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, archived_at INTEGER);`);
  return new AgentRegistry(drizzle(sqlite, { schema }) as unknown as Db);
}

describe("AgentRegistry — executionState", () => {
  test("defaults to offline; tracks the wake actor's state; offline drops the entry", () => {
    const r = memRegistry();
    expect(r.executionStateOf("a")).toBe("offline"); // default

    r.setExecutionState("a", "interactive");
    expect(r.executionStateOf("a")).toBe("interactive");
    r.setExecutionState("a", "headless");
    expect(r.executionStateOf("a")).toBe("headless");
    r.setExecutionState("a", "broken");
    expect(r.executionStateOf("a")).toBe("broken");

    r.setExecutionState("a", "offline"); // back to the default → entry removed
    expect(r.executionStateOf("a")).toBe("offline");
  });
});

describe("AgentRegistry — turn budgets", () => {
  test("resetAllTurnBudgets zeros every count and re-enables the per-agent limit", () => {
    const r = memRegistry();
    const a = r.create({
      name: "alpha",
      template: "default",
      harness: "claude",
      approvalMode: "approve",
    });
    const b = r.create({
      name: "beta",
      template: "default",
      harness: "claude",
      approvalMode: "approve",
    });
    // alpha: spent + per-agent limit turned OFF; beta: some usage, limit on.
    r.incrementHeadlessTurns(a.id);
    r.incrementHeadlessTurns(a.id);
    r.update(a.id, { turnLimitEnabled: false });
    r.incrementHeadlessTurns(b.id);
    expect(r.get(a.id)!.turnLimitEnabled).toBe(false);
    expect(r.get(a.id)!.headlessTurnsUsed).toBe(2);
    expect(r.get(b.id)!.headlessTurnsUsed).toBe(1);

    r.resetAllTurnBudgets();

    // Every agent: count zeroed AND per-agent limit forced back on (overrides opt-out).
    for (const id of [a.id, b.id]) {
      expect(r.get(id)!.headlessTurnsUsed).toBe(0);
      expect(r.get(id)!.turnLimitEnabled).toBe(true);
    }
  });
});

describe("AgentRegistry — CLAUDE.md composition", () => {
  // Markers unique to each half of the composed file.
  const PREFIX_MARKER = "## Self-scheduling — staying awake on the user's behalf";

  function claudeMdFor(template: string): string {
    const r = memRegistry();
    const agent = r.create({
      name: `compose ${template}`,
      template,
      harness: "claude",
      approvalMode: "approve",
    });
    return readFileSync(join(r.agentDir(agent), "CLAUDE.md"), "utf8");
  }

  test("prepends the shared OpenTrade prefix to every template's specialty section", () => {
    for (const [template, specialtyMarker] of [
      ["default", "## Your specialty — general purpose"],
      ["dca", "## Your specialty — dollar-cost averaging (DCA)"],
      ["momentum", "## Your specialty — momentum / trend-following"],
    ] as const) {
      const md = claudeMdFor(template);
      expect(md).toContain(PREFIX_MARKER); // shared mechanics present…
      expect(md).toContain(specialtyMarker); // …followed by the template's own section
      // Prefix comes first, specialty after.
      expect(md.indexOf(PREFIX_MARKER)).toBeLessThan(md.indexOf(specialtyMarker));
      // The shared title appears exactly once (the specialty file no longer carries its own H1).
      expect(md.startsWith("# OpenTrade Agent\n")).toBe(true);
      expect(md.split("# OpenTrade Agent").length - 1).toBe(1);
    }
  });

  test("unknown templates fall back to default but still get the prefix", () => {
    const md = claudeMdFor("does-not-exist");
    expect(md).toContain(PREFIX_MARKER);
    expect(md).toContain("## Your specialty — general purpose");
  });
});

describe("AgentRegistry — codex scaffold divergence", () => {
  test("codex agents get AGENTS.md + generated .codex config, no claude files", async () => {
    const { registerHarness } = await import("../harness");
    const { createCodexHarness } = await import("../harness/codex");
    const { CodexAppServerManager } = await import("../harness/codex-app-server");
    // writeConfig/scaffold never touch the manager — a bare instance is fine.
    registerHarness(
      createCodexHarness(
        new CodexAppServerManager(
          () => ({}),
          async () => ({}),
        ),
      ),
    );

    const r = memRegistry();
    const agent = r.create({
      name: "codex one",
      template: "default",
      harness: "codex",
      approvalMode: "approve",
    });
    const dir = r.agentDir(agent);
    const { existsSync, readFileSync } = await import("node:fs");
    const { basename, join } = await import("node:path");
    const { codexHomeFor } = await import("../harness/codex-app-server");
    const codexHome = codexHomeFor(basename(dir));

    // Instructions: AGENTS.md composed from the codex prefix + the specialty.
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    // Harness-neutral template files (kickoff.md) MUST still be copied — the cpSync
    // filter skips only claude-specific artifacts. Regression guard for B3: an absolute
    // template path containing a `/.claude` segment (e.g. this repo under
    // `.claude/worktrees/`) previously filtered out EVERY file, leaving no kickoff.
    expect(existsSync(join(dir, "kickoff.md"))).toBe(true);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("# OpenTrade Agent");
    expect(agents).toContain("Codex");

    // Claude-shaped template files skipped; codex config generated instead.
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    const toml = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain("[mcp_servers.robinhood]");
    // The fail-closed anchor: order tools ALWAYS prompt ("approve" would mean
    // pre-approved!), everything else pre-allowed like claude's allowlist.
    for (const t of [
      "place_equity_order",
      "place_option_order",
      "cancel_equity_order",
      "cancel_option_order",
    ]) {
      expect(toml).toContain(`[mcp_servers.robinhood.tools.${t}]\napproval_mode = "prompt"`);
    }
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    // Project trust suppresses the TUI's first-run trust prompt — keyed by the
    // REALPATH (codex canonicalizes the cwd before matching).
    const { realpathSync } = await import("node:fs");
    expect(toml).toContain(`[projects.${JSON.stringify(realpathSync(dir))}]`);
    // The opentrade MCP entry carries NO secrets (port/token ride the server env).
    expect(toml).toContain("[mcp_servers.opentrade]");
    expect(toml).not.toContain("OPENTRADE_TOKEN");

    // Gate hooks: claude-compatible hooks.json + executable scripts, abs paths.
    const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    const pre = hooks.hooks.PreToolUse[0];
    expect(pre.matcher).toBe("mcp__robinhood__(place|cancel)_(equity|option)_order");
    // The command is a shell string carrying the non-secret identifiers (codex
    // cleans the hook env; the scripts recover port/token from the manifest).
    expect(pre.hooks[0].command).toContain(join(codexHome, "hooks", "approval-gate.sh"));
    expect(pre.hooks[0].command).toContain("OPENTRADE_AGENT_ID=");
    expect(pre.hooks[0].command).toContain("OPENTRADE_HOME=");
    expect(pre.hooks[0].timeout).toBe(600);
    expect(existsSync(join(codexHome, "hooks", "approval-gate.sh"))).toBe(true);
    expect(existsSync(join(codexHome, "hooks", "order-result.sh"))).toBe(true);

    // codexHomeFor resolves under the REAL ~/.opentrade/cx (keyed by a hash, not
    // OPENTRADE_HOME — the socket-path length constraint), so this test writes outside
    // the throwaway HOME. Clean it up so the suite leaves no trace on the dev machine.
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("claude agents scaffold exactly as before (regression)", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const r = memRegistry();
    const agent = r.create({
      name: "claude one",
      template: "default",
      harness: "claude",
      approvalMode: "approve",
    });
    const dir = r.agentDir(agent);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".codex"))).toBe(false);
  });
});
