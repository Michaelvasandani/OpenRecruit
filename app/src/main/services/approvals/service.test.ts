import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import * as schema from "../../db/schema";

// Isolate OPENTRADE_HOME before any module that derives paths from it loads.
const HOME = mkdtempSync(join(tmpdir(), "approvals-home-"));
process.env.OPENTRADE_HOME = HOME;

let AgentRegistry: typeof import("../agents/registry").AgentRegistry;
let AuditLog: typeof import("../audit").AuditLog;
let StatusArbiter: typeof import("../status/arbiter").StatusArbiter;
let ApprovalService: typeof import("./index").ApprovalService;
beforeAll(async () => {
  ({ AgentRegistry } = await import("../agents/registry"));
  ({ AuditLog } = await import("../audit"));
  ({ StatusArbiter } = await import("../status/arbiter"));
  ({ ApprovalService } = await import("./index"));
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const TOOL = "mcp__robinhood__place_equity_order";
const INPUT = { symbol: "NVDA", quantity: 1, side: "buy" };

function setup() {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_DDL);
  const db = drizzle(sqlite, { schema }) as unknown as Db;
  const registry = new AgentRegistry(db);
  const audit = new AuditLog(db, registry);
  const arbiter = new StatusArbiter(registry);
  const approvals = new ApprovalService(db, registry, audit, arbiter);
  // A real agent row (approve mode) without touching the scaffold path.
  sqlite.exec(
    `INSERT INTO agents (id, slug, name, template, approval_mode, status, created_at)
     VALUES ('a1', 'tester', 'Tester', 'default', 'approve', 'idle', 1)`,
  );
  return { approvals, db };
}

describe("ApprovalService idempotent join", () => {
  test("an identical request while pending attaches to the same card and decision", async () => {
    const { approvals } = setup();
    const first = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    // Same (agent, tool, input) — the second gate layer of the same tool call.
    const second = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });

    // Exactly ONE card is pending (no duplicate row).
    expect(approvals.listPending()).toHaveLength(1);

    const id = approvals.listPending()[0].id;
    approvals.decide({ id, approve: true });

    const [d1, d2] = await Promise.all([first, second]);
    expect(d1.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(d2.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(approvals.listPending()).toHaveLength(0);
  });

  test("a deny resolves the joined duplicate with the same deny", async () => {
    const { approvals } = setup();
    const first = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    const second = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    approvals.decide({ id: approvals.listPending()[0].id, approve: false, note: "nope" });

    const [d1, d2] = await Promise.all([first, second]);
    expect(d1.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(d2.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("a re-fire AFTER the decision (no joinDecidedMs) gets a fresh card — genuine repeat", async () => {
    const { approvals } = setup();
    const first = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    approvals.decide({ id: approvals.listPending()[0].id, approve: true });
    await first;

    // The PreToolUse hook path / claude pass no window, so a same-key request arriving
    // after the first resolved is a NEW order intent — never silently replayed (it
    // can't be told apart from a genuine repeat order). A fresh card is pending.
    const second = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    expect(approvals.listPending()).toHaveLength(1);
    approvals.decide({ id: approvals.listPending()[0].id, approve: true });
    expect((await second).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(approvals.listPending()).toHaveLength(0);
  });

  test("the codex answerer (joinDecidedMs) MIRRORS a just-made decision — one card", async () => {
    const { approvals } = setup();
    // Layer 1: the PreToolUse hook creates + resolves the card.
    const hook = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    approvals.decide({ id: approvals.listPending()[0].id, approve: true });
    expect((await hook).hookSpecificOutput.permissionDecision).toBe("allow");

    // Layer 2: the approval_mode elicitation answerer fires a beat later for the SAME
    // order and opts into mirroring within the window — no second card.
    const mirrored = await approvals.request(
      { agentId: "a1", toolName: TOOL, rawInput: INPUT },
      { joinDecidedMs: 5_000 },
    );
    expect(mirrored.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(approvals.listPending()).toHaveLength(0); // no new card raised
  });

  test("a deny is mirrored too (the answerer never upgrades a rejected order)", async () => {
    const { approvals } = setup();
    const hook = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    approvals.decide({ id: approvals.listPending()[0].id, approve: false });
    await hook;
    const mirrored = await approvals.request(
      { agentId: "a1", toolName: TOOL, rawInput: INPUT },
      { joinDecidedMs: 5_000 },
    );
    expect(mirrored.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(approvals.listPending()).toHaveLength(0);
  });

  test("different inputs do NOT join — each gets its own card", async () => {
    const { approvals } = setup();
    const p1 = approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    const p2 = approvals.request({
      agentId: "a1",
      toolName: TOOL,
      rawInput: { ...INPUT, quantity: 2 },
    });
    expect(approvals.listPending()).toHaveLength(2);
    for (const card of approvals.listPending()) approvals.decide({ id: card.id, approve: false });
    await Promise.all([p1, p2]);
  });

  test("auto-mode agents: instant allow, and the immediate re-fire replays it", async () => {
    const { approvals, db } = setup();
    // Flip the agent to full-auto.
    db.$client.exec?.("UPDATE agents SET approval_mode = 'auto' WHERE id = 'a1'");
    const d1 = await approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    const d2 = await approvals.request({ agentId: "a1", toolName: TOOL, rawInput: INPUT });
    expect(d1.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(d2.hookSpecificOutput.permissionDecision).toBe("allow");
  });
});
