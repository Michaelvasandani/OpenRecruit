/**
 * The wake-delivery seam. `Scheduler` enqueues via `enqueue`; the `/wake-stream`
 * long-poll consumes via `awaitPoll`; `TerminalService` reports PTY up/down. The
 * coordinator owns one per-agent wake queue, drained through one of two transports —
 * the `claude/channel` (interactive) or a `claude --resume -p` child (headless) —
 * behind this interface, so the delivery mechanism stays decoupled from its callers.
 */
export interface WakeTransport {
  /** Enqueue a wake for an agent. Drained via the channel (a live PTY exists) or a
   *  headless `-p` child (none). Never blocks, never throws. */
  enqueue(agentId: string, prompt: string): void;
  /** Would a wake for this agent be dropped rather than delivered (session BROKEN, or
   *  out of background turns)? The Scheduler checks this to skip firing a paused agent —
   *  no wake notification, history row, or enqueue — instead of firing then dropping. */
  wouldDropWake(agentId: string): boolean;
  /** The `/wake-stream` consumer (channel transport): hand the queued head to the
   *  live interactive session, or park until one is offered / the hold elapses / the
   *  request aborts. Returns the wake prompt or null. */
  awaitPoll(agentId: string, signal: AbortSignal, holdMs: number): Promise<string | null>;
  /** A live interactive PTY came up (GUI opened/selected the agent). */
  onInteractiveUp(agentId: string): void;
  /** The interactive PTY went down (exit / GUI-close blanket kill); the head + any
   *  queued wakes re-route to the headless transport. */
  onInteractiveDown(agentId: string): void;
  /** EC1 "Stop task" / archive: clear the agent's queued wakes and end any active
   *  headless run. Returns whether a headless run was actually stopped. */
  stop(agentId: string): boolean;
  /** Clean host shutdown: end every active headless run and clear its crash marker, so
   *  the next boot doesn't mistake an in-flight run for a crash orphan. */
  stopAll(): void;
}

/**
 * The slice of the `Scheduler` the wake coordinator drives when an agent's
 * resumability changes. A `broken` (unresumable) agent can't run wakes, so its crons
 * and monitors are **paused** (disarmed, but left `enabled` in the DB) rather than
 * left firing into a dead session — otherwise every tick spams a wake notification and
 * a "dropping wake" log. A manual Restart clears `broken` and re-arms them. Late-bound
 * (`WakeCoordinator.setScheduler`) because the scheduler is built after the coordinator.
 */
export interface SchedulerControl {
  /** Disarm this agent's cron timers + stop its monitor children (DB `enabled` untouched). */
  disarmAgent(agentId: string): void;
  /** Re-arm this agent's still-enabled crons + monitors (Restart / recovery). */
  rearmAgent(agentId: string): void;
}

/** How a headless `-p` run terminated, reported by the strategy to the coordinator:
 *  - `ok`         — the child exited (clean, or killed by the max-runtime backstop)
 *  - `resumeFail` — a `--resume` exited non-zero almost immediately (unresumable session)
 *  - `spawnFail`  — the child failed to spawn at all (a config fault) */
export type HeadlessExitReason = "ok" | "resumeFail" | "spawnFail";

/** Autonomy backbone: spawn a headless `claude --resume <uuid> -p "<prompt>"`. */
export interface HeadlessWakeStrategy {
  /** Spawn the headless child for the head wake. Reports its terminal outcome via
   *  `onExit` (called exactly once). Never blocks — the run is fire-and-forget; the
   *  coordinator owns the max-runtime kill timer. */
  run(agentId: string, prompt: string, onExit: (reason: HeadlessExitReason) => void): void;
  /** SIGTERM the active headless run for an agent, if any. Returns whether one died. */
  stop(agentId: string): boolean;
  /** SIGTERM every live headless child + clear its marker (clean host shutdown). */
  stopAll(): void;
}
