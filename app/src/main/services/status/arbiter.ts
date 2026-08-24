import type { AgentStatus } from "@shared/agent";
import type { AgentRegistry } from "../agents/registry";

type PtyState = "working" | "idle";

/**
 * Computes each agent's effective status from independent signals and writes the
 * winner to the registry. Several sources race to describe an agent — the PTY
 * activity heuristic (working/idle), Claude Code's Notification/Stop hooks
 * (needs-input/idle), so rather than letting them clobber each other in the DB,
 * they each feed the arbiter and a single priority order decides what the user sees:
 *
 *   needs-input  >  working  >  idle
 *
 * Any real PTY output ("working") clears a stale needs-input — if bytes are
 * flowing the agent is no longer blocked waiting on the user.
 */
export class StatusArbiter {
  private pty = new Map<string, PtyState>();
  private needsInput = new Set<string>();

  constructor(private registry: AgentRegistry) {}

  setPty(id: string, state: PtyState) {
    this.pty.set(id, state);
    // Output flowing means the agent isn't parked on a prompt anymore.
    if (state === "working") this.needsInput.delete(id);
    this.recompute(id);
  }

  setNeedsInput(id: string, on: boolean) {
    if (on) this.needsInput.add(id);
    else this.needsInput.delete(id);
    this.recompute(id);
  }

  /** Drop all tracked signals for an agent (e.g. on delete). */
  forget(id: string) {
    this.pty.delete(id);
    this.needsInput.delete(id);
  }

  private recompute(id: string) {
    const status: AgentStatus = this.needsInput.has(id)
      ? "needs-input"
      : this.pty.get(id) === "working"
        ? "working"
        : "idle";
    this.registry.setStatus(id, status);
  }
}
