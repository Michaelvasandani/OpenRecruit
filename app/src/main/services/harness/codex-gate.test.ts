import { describe, expect, test } from "bun:test";
import type { PreToolUseDecision } from "@shared/approval";
import type { ApprovalService } from "../approvals";
import { buildCodexAnswerer, toolNameFromElicitation } from "./codex-gate";

const ALLOW: PreToolUseDecision = {
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
};
const DENY: PreToolUseDecision = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "no",
  },
};

/** Records every ApprovalService.request call and returns a scripted decision. */
function stubApprovals(decision: PreToolUseDecision) {
  const calls: Array<{ agentId: string; toolName: string; rawInput: unknown }> = [];
  const approvals = {
    request: async (args: { agentId: string; toolName: string; rawInput: unknown }) => {
      calls.push(args);
      return decision;
    },
  } as unknown as ApprovalService;
  return { approvals, calls };
}

const ELICIT = "mcpServer/elicitation/request";

describe("codex gate — elicitation fail-closed (F1)", () => {
  test("a Robinhood order elicitation routes to the approval gate (structured fields, not the message)", async () => {
    const { approvals, calls } = stubApprovals(ALLOW);
    const answer = buildCodexAnswerer(approvals);
    const res = await answer("a1", ELICIT, {
      serverName: "robinhood",
      message: 'Allow the robinhood MCP server to run tool "place_equity_order"?',
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { symbol: "NVDA", qty: 1 } },
    });
    expect(res).toEqual({ action: "accept" });
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("mcp__robinhood__place_equity_order");
    expect(calls[0].rawInput).toEqual({ symbol: "NVDA", qty: 1 });
  });

  test("a denied order elicitation declines", async () => {
    const { approvals } = stubApprovals(DENY);
    const answer = buildCodexAnswerer(approvals);
    const res = await answer("a1", ELICIT, {
      serverName: "robinhood",
      message: 'Allow the robinhood MCP server to run tool "cancel_option_order"?',
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
    });
    expect(res).toEqual({ action: "decline" });
  });

  test("an UNPARSEABLE Robinhood tool-call still gates — never auto-accepts (the core F1 fix)", async () => {
    const { approvals, calls } = stubApprovals(ALLOW);
    const answer = buildCodexAnswerer(approvals);
    // A reworded/absent message (e.g. a codex version bump) must NOT fall through to accept.
    const res = await answer("a1", ELICIT, {
      serverName: "robinhood",
      message: "Some future wording the regex can't parse",
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { symbol: "AAPL" } },
    });
    expect(res).toEqual({ action: "accept" }); // accepted only because the STUB approved
    expect(calls).toHaveLength(1); // ...but it went through the human gate, not a default-accept
    expect(calls[0].toolName).toBe("mcp__robinhood__order"); // safe fallback label
  });

  test("a Robinhood elicitation that isn't a tool-call fails closed (decline, no gate call)", async () => {
    const { approvals, calls } = stubApprovals(ALLOW);
    const answer = buildCodexAnswerer(approvals);
    const res = await answer("a1", ELICIT, {
      serverName: "robinhood",
      message: "Please confirm something",
      _meta: { codex_approval_kind: "some_other_kind" },
    });
    expect(res).toEqual({ action: "decline" });
    expect(calls).toHaveLength(0);
  });

  test("a non-Robinhood MCP elicitation auto-accepts (unattended parity)", async () => {
    const { approvals, calls } = stubApprovals(DENY);
    const answer = buildCodexAnswerer(approvals);
    const res = await answer("a1", ELICIT, {
      serverName: "opentrade",
      message: 'Allow the opentrade MCP server to run tool "list_schedules"?',
      _meta: { codex_approval_kind: "mcp_tool_call" },
    });
    expect(res).toEqual({ action: "accept" });
    expect(calls).toHaveLength(0); // never reached the order gate
  });
});

describe("toolNameFromElicitation", () => {
  test("extracts the quoted tool name", () => {
    expect(
      toolNameFromElicitation({
        message: 'Allow the robinhood MCP server to run tool "place_equity_order"?',
      }),
    ).toBe("place_equity_order");
  });
  test("returns null when the message can't be parsed", () => {
    expect(toolNameFromElicitation({ message: "no tool here" })).toBeNull();
    expect(toolNameFromElicitation({})).toBeNull();
  });
});
