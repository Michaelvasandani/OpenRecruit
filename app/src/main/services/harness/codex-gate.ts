import { basename } from "node:path";
import type { Agent } from "@shared/agent";
import { hostLog } from "../../host/log";
import type { AgentRegistry } from "../agents/registry";
import type { ApprovalService } from "../approvals";
import { formatWakePrompt } from "../scheduler/wake/prompt";
import type { InteractivePush } from "../scheduler/wake/types";
import {
  type CodexAppServerManager,
  codexHomeFor,
  type ServerRequestAnswerer,
} from "./codex-app-server";

/**
 * Policy glue between the codex app-server and OpenTrade's gate/wake machinery.
 *
 * Approvals: while the backend drives a turn (wakes, headless runs), codex raises
 * server→client requests for anything its config gates. Order tools route into the
 * ApprovalService (the same card/audit/timeout flow as claude's PreToolUse hook —
 * the idempotent join collapses the hook + elicitation double-fire into one card).
 * Everything else follows headless parity with claude's
 * `--dangerously-skip-permissions`: auto-allow. The fail-closed anchor stands
 * regardless: per-tool `approval_mode = "prompt"` in the agent's config.toml means
 * an unanswered/erred request is a Decline in codex core.
 */

/**
 * Window in which the `approval_mode` elicitation answerer mirrors the PreToolUse
 * hook's just-made decision for the SAME order, instead of raising a second card.
 * Codex serializes the two layers (hook decides, then the elicitation fires a beat
 * later), so on backend-driven turns both hit ApprovalService; this collapses them.
 * Kept short: a GENUINE repeat order needs a full model round-trip, well beyond this,
 * so it still gets its own card (money-safety — see ApprovalService.request).
 */
const GATE_JOIN_DECIDED_MS = 5_000;

/** `mcpServer/elicitation/request` params (spike-verified shape). */
interface ElicitationParams {
  serverName?: string;
  message?: string;
  _meta?: { codex_approval_kind?: string; tool_params?: unknown };
}

/** Codex doesn't carry the tool name as a first-class field — it's quoted in the
 *  human message: `Allow the <server> MCP server to run tool "<tool>"?`. This is a
 *  best-effort LABEL only: a parse miss must never change the gate DECISION (which
 *  keys on the structured `serverName`/`_meta` fields), only degrade the card's name. */
export function toolNameFromElicitation(params: ElicitationParams): string | null {
  const m = params.message?.match(/run tool "([^"]+)"/);
  return m ? m[1] : null;
}

export function buildCodexAnswerer(approvals: ApprovalService): ServerRequestAnswerer {
  return async (agentId, method, params, signal) => {
    if (method === "mcpServer/elicitation/request") {
      const p = (params ?? {}) as ElicitationParams;
      // FAIL-CLOSED gate decision on STRUCTURED fields, never the prose message.
      // The generated config pre-approves every non-order Robinhood tool
      // (`default_tools_approval_mode = "approve"`), so the ONLY Robinhood tool that
      // can raise an elicitation is an order — route every one to the human gate.
      // A reworded codex message must not turn the anchor into an auto-approve (F1).
      const isRobinhood = p.serverName === "robinhood";
      const isToolCall = p._meta?.codex_approval_kind === "mcp_tool_call";
      if (isRobinhood && isToolCall) {
        // Tool NAME is best-effort (label + idempotent-join key with the hook layer);
        // if the message can't be parsed we still gate — the fallback name just means
        // the hook layer may raise a second card, which is safe (never a bypass).
        const tool = toolNameFromElicitation(p);
        const fullName = tool ? `mcp__robinhood__${tool}` : "mcp__robinhood__order";
        const decision = await approvals.request(
          {
            agentId,
            toolName: fullName,
            rawInput: p._meta?.tool_params ?? null,
          },
          {
            signal, // abandon the card if the codex connection drops mid-approval
            // Mirror the PreToolUse hook's decision for this same order rather than
            // raising a second card (codex's two serialized gate layers).
            joinDecidedMs: GATE_JOIN_DECIDED_MS,
          },
        );
        const allow = decision.hookSpecificOutput.permissionDecision === "allow";
        return { action: allow ? "accept" : "decline" };
      }
      // Any OTHER Robinhood elicitation (couldn't classify as a tool-call) → decline.
      // We never auto-accept for the order broker; the safe direction is to refuse.
      if (isRobinhood) {
        hostLog.warn(
          "codex robinhood elicitation not classified as a tool-call — declining (fail-closed)",
          agentId,
          p.message ?? "",
        );
        return { action: "decline" };
      }
      // Non-Robinhood MCP tool — unattended parity with claude's skip-permissions.
      return { action: "accept" };
    }
    // Shell/patch approvals during a backend-driven turn: allow (parity with
    // claude headless, where non-order tools run unattended). Response enums per
    // the app-server protocol schema.
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      return { decision: "approved" };
    }
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      return { decision: "accept" };
    }
    // Anything we don't understand: refuse loudly — codex treats the error as a
    // decline, which is the safe direction for an unknown escalation.
    hostLog.warn("codex server request unhandled (declining)", agentId, method);
    throw new Error(`opentrade: unhandled server request ${method}`);
  };
}

/**
 * Interactive wake delivery for codex agents: a wake becomes `turn/start` on the
 * agent's app-server; the attached TUI renders it live. Resolves `true` on the
 * turn/start ACK (advance-on-ack — stronger than the channel's handoff); the turn
 * itself continues in the background and the TUI shows it. Claude agents get no
 * push (their channel poll is the interactive transport).
 */
export function buildInteractivePushFactory(
  manager: CodexAppServerManager,
  registry: AgentRegistry,
): (agent: Agent) => InteractivePush | undefined {
  return (agent) => {
    if (agent.harness !== "codex") return undefined;
    return (prompt) =>
      new Promise<boolean>((resolve) => {
        const fresh = registry.get(agent.id);
        const threadId = fresh?.lastSessionId;
        if (!fresh || !threadId) {
          resolve(false);
          return;
        }
        const codexHome = codexHomeFor(basename(registry.agentDir(fresh)));
        manager
          .runTurn(agent.id, codexHome, threadId, formatWakePrompt(prompt), {
            events: { onAccepted: () => resolve(true) },
          })
          .then((outcome) => {
            // Reached only if the turn ended; ack already resolved true — this
            // covers the no-ack failure paths.
            if (outcome.outcome !== "completed") resolve(false);
            else resolve(true);
          })
          .catch((err) => {
            hostLog.warn("codex interactive wake push failed", agent.id, String(err));
            resolve(false);
          });
      });
  };
}
