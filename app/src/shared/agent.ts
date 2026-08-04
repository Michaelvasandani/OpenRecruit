import { z } from "zod";

export const AgentStatus = z.enum(["idle", "working", "needs-input", "awaiting-approval"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const ApprovalMode = z.enum(["approve", "auto"]);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

/**
 * Which agent CLI runs this agent. Fixed at creation; every harness-specific
 * behavior (spawn, wake transport, scaffold, gate wiring) is resolved through the
 * harness seam (`services/harness/`) — nothing outside it may branch on this id.
 */
export const HarnessId = z.enum(["claude", "codex"]);
export type HarnessId = z.infer<typeof HarnessId>;

/**
 * Runtime execution context for an agent's single `claude` writer (orthogonal to
 * the 4-value status dot). Drives the terminal-pane overlays:
 *  - `offline`     — no live `claude` for this agent
 *  - `headless`    — a backend `claude --resume -p` wake is running (no PTY)
 *  - `interactive` — a live GUI PTY is attached
 *  - `broken`      — the session is unresumable; needs a manual fresh restart
 * Held in memory by the host (PTY liveness is a host-side fact), defaulting to
 * `offline` on boot — never persisted.
 */
export const ExecutionState = z.enum(["offline", "headless", "interactive", "broken"]);
export type ExecutionState = z.infer<typeof ExecutionState>;

export const Agent = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  template: z.string(),
  harness: HarnessId,
  approvalMode: ApprovalMode,
  lastSessionId: z.string().nullable(),
  status: AgentStatus,
  executionState: ExecutionState,
  /** Headless (scheduled background) turns run since the last reset. Reset only via
   *  the agent view's turn-limit button Reset control (`agents.resetTurnLimit`). */
  headlessTurnsUsed: z.number().int().nonnegative(),
  /** Whether the global headless turn limit (`AppSettings.maxHeadlessTurns`) applies
   *  to this agent. There is no per-agent limit VALUE — only this on/off switch. */
  turnLimitEnabled: z.boolean(),
  createdAt: z.number(),
  archivedAt: z.number().nullable(),
});
export type Agent = z.infer<typeof Agent>;

export const CreateAgentInput = z.object({
  name: z.string().min(1).max(80),
  template: z.string().default("default"),
  harness: HarnessId.default("claude"),
  approvalMode: ApprovalMode.default("approve"),
  /**
   * The agent's CLAUDE.md **specialty section** (strategy persona/principles), as
   * edited in the New Agent dialog — NOT the shared prefix, which the registry
   * always prepends at scaffold time. When omitted, the template's own specialty
   * is used. Blank/whitespace is treated as omitted.
   */
  claudeMd: z.string().optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;
