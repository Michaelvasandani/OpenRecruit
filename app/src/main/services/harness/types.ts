import type { Agent, HarnessId } from "@shared/agent";

/**
 * The harness seam: everything OpenTrade does differently per agent CLI lives
 * behind this interface. Nothing outside `services/harness/` may branch on a
 * `HarnessId` — consumers resolve a `Harness` via `harnessFor()` and call it, so
 * adding a harness is a new implementation file + a registry entry, not a sweep
 * of if/elses.
 *
 * What stays OUTSIDE the seam (uniform across harnesses): session-id *storage*
 * (`agents.last_session_id` is "the resumable conversation id" whoever minted
 * it), the wake queue/state machine, spawn markers, the approval service, the
 * `[OPENTRADE WAKE <ts>]` prompt format, and `buildAgentEnv`'s base env.
 */

/** Whether a launch begins a brand-new conversation or resumes a stored one. */
export type SessionMode = "start" | "resume";

export interface ProbeResult {
  found: boolean;
  version: string | null;
}

export interface Harness {
  readonly id: HarnessId;
  /** The CLI binary spawned in the agent's PTY (resolved via the agent PATH). */
  readonly binary: string;
  /** The instructions file this harness reads from the agent dir. */
  readonly instructionsFile: "CLAUDE.md" | "AGENTS.md";
  /** The shared-prefix source in templates/agents/ composed above the specialty. */
  readonly instructionsPrefixFile: string;
  /**
   * Env vars stripped from a background run's env when subscription auth is
   * enforced (`settings.backgroundAllowApiKey` off), so unattended runs bill the
   * user's logged-in subscription instead of silently hitting an API key.
   */
  readonly subscriptionAuthStrip: readonly string[];

  /**
   * argv for an interactive PTY launch. `start` begins conversation `sessionId`
   * (with an optional kickoff prompt as the trailing positional); `resume`
   * continues it. The caller owns minting/persisting the id and first-run
   * bookkeeping — this is a pure argv builder.
   */
  interactiveArgs(mode: SessionMode, sessionId: string, kickoff?: string | null): string[];

  /** Harness-specific env layered over `buildAgentEnv` for interactive PTYs. */
  interactiveEnv(ctx: { agentDir: string }): Record<string, string>;

  /**
   * Run BEFORE spawning an interactive PTY (any mode). Codex: bring the agent's
   * app-server up so the TUI's auto-attach probe finds the control socket — a
   * TUI that boots first silently falls back to its embedded engine, splitting
   * the user's session from the wake engine.
   */
  prepareInteractive?(agent: Agent, agentDir: string): Promise<void>;

  /**
   * Present when the harness's engine mints conversation ids (codex): after a
   * bare interactive `start` launch, discover the session the TUI just created,
   * persist its id via `persist`, and deliver the kickoff into it. Fire-and-
   * forget (the PTY is already up). Consumes the kickoff, so `interactiveArgs`
   * receives none. Absent for harnesses where OpenTrade mints ids locally
   * (claude) and the kickoff rides the argv.
   */
  adoptInteractiveSession?(
    agent: Agent,
    agentDir: string,
    kickoff: string | null,
    persist: (sessionId: string) => void,
  ): void;

  /**
   * Present when the harness can end up on a DIFFERENT engine than OpenTrade's
   * (codex: a wrapper `codex` injecting `-c` drops the TUI into its embedded engine,
   * splitting the user's session from the wake engine). Called fire-and-forget after
   * a RESUME launch to assert the TUI attached to our server (the start path already
   * asserts this via adoption); surfaces a split-session warning if not. Absent for
   * harnesses with a single engine (claude).
   */
  verifyResumedSession?(agent: Agent, agentDir: string, sessionId: string): void;

  /**
   * When true, `writeConfig` produces the harness's COMPLETE on-disk config, so the
   * scaffold skips the claude-style steps (`.mcp.json` injection, hook copy) — codex.
   * When false/absent, the harness uses the claude-style scaffold AND `writeConfig`
   * (if present) layers its own generated files on top (claude: the order-gate
   * `settings.json` + hook scripts).
   */
  readonly generatesFullConfig?: boolean;

  /**
   * Write/refresh the harness's generated on-disk config in the agent dir. Called at
   * scaffold AND before every spawn (interactive + headless) — **self-healing**, so a
   * tampered or (critically) a never-created config is regenerated on the next launch.
   *  - codex: `.codex/config.toml`, hooks, gate scripts, auth link (the whole config).
   *  - claude: `.claude/settings.json` (the order-gate hook wiring — generated IN CODE
   *    because the template copy is git-untracked and absent from clean CI builds) +
   *    the hook scripts.
   */
  writeConfig?(agentDir: string, agentId: string): void;

  /**
   * argv for a headless one-shot CLI wake run (no PTY): resume/start `sessionId`,
   * deliver `wakePrompt`, exit when the turn is done. Present only for harnesses
   * whose headless transport IS a CLI child (claude); absent for harnesses that
   * run headless wakes another way (codex drives an app-server turn — see
   * CodexHeadlessStrategy — so it never builds argv). The routing headless
   * strategy guarantees this is only called for a harness that defines it.
   */
  headlessArgs?(mode: SessionMode, sessionId: string, wakePrompt: string): string[];

  /** Is the CLI installed? (onboarding + the New Agent dialog's picker). */
  probe(env: Record<string, string>): Promise<ProbeResult>;
}
