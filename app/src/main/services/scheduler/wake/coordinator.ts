import type { ExecutionState } from "@shared/agent";
import { DEFAULT_SETTINGS } from "@shared/settings";
import { hostLog } from "../../../host/log";
import type { AgentRegistry } from "../../agents/registry";
import { analytics } from "../../analytics";
import { bus } from "../../event-bus";
import type {
  HeadlessExitReason,
  HeadlessWakeStrategy,
  InteractivePush,
  SchedulerControl,
  WakeTransport,
} from "./types";

/** Delay before re-attempting a failed interactive push delivery. */
const PUSH_RETRY_MS = 5_000;

/** Default hard ceiling on a single headless run. The kill timer is the only timer in
 *  the wake layer; on expiry we SIGTERM the child and its exit drives
 *  `headlessExited` (a clean `ok`, not a resume-fail). The actual value is a live
 *  Settings tunable (`maxHeadlessRunMinutes`); this is the fallback when none is wired
 *  (tests/standalone).
 */
const MAX_HEADLESS_RUN_MS = 30 * 60_000;
/** Consecutive headless resume-fails before an agent is declared unresumable. Each
 *  failure drops its own wake; the Nth in a row flips the agent to `broken`. Any clean
 *  exit resets the streak — normal timeouts throughout, no backoff. */
const MAX_RESUME_FAILS = 3;

/**
 * Per-agent state machine. One state at a time, 1:1 with the four `executionState`
 * values the renderer consumes:
 *  - `OFFLINE`             — no live PTY; wakes drain via the `-p` transport
 *  - `INTERACTIVE_RUNNING` — a live PTY exists; wakes deliver via `claude/channel`
 *  - `HEADLESS_RUNNING`    — a `-p` child is delivering the head (kill timer armed)
 *  - `BROKEN`              — unresumable (3 consecutive resume-fails, or a spawn error)
 */
type WriterState = "OFFLINE" | "INTERACTIVE_RUNNING" | "HEADLESS_RUNNING" | "BROKEN";

const TO_EXECUTION_STATE: Record<WriterState, ExecutionState> = {
  OFFLINE: "offline",
  INTERACTIVE_RUNNING: "interactive",
  HEADLESS_RUNNING: "headless",
  BROKEN: "broken",
};

/**
 * The per-agent wake actor. Owns ONE FIFO queue (`pending`) drained through one of two
 * delivery transports — the `claude/channel` while a PTY is live, or a headless
 * `claude --resume -p` child while none is. The transports differ in exactly one
 * property: **when the head leaves the queue**.
 *  - **channel (interactive):** advance on *handoff* — the instant the head is handed
 *    to a parked poll it shifts out, because the channel owns ordered, reliable
 *    delivery from there (no lock, no completion-gate, no turn-awareness).
 *  - **`-p` (headless):** advance on *exit* — the head stays at `pending[0]` until the
 *    child exits, so a crash mid-run never loses it (the single-writer "no lost wake").
 *
 * The actor's state IS the agent's `executionState` (pushed to the registry on every
 * transition); there is no internal-vs-UI projection.
 */
/** Everything an {@link AgentWriter} needs, as one object (vs a long positional list).
 *  The `() => …` fields are live reads of Settings tunables so a change applies to the
 *  next wake with no restart. */
interface AgentWriterDeps {
  registry: AgentRegistry;
  headless: HeadlessWakeStrategy;
  /** Live per-run max duration in ms (the kill-timer). */
  maxHeadlessRunMs: () => number;
  /** Live global per-agent turn budget. */
  maxHeadlessTurns: () => number;
  /** Live global on/off for the whole turn-limit feature. When off, no gating, counting,
   *  or pause notification happens. Distinct from the per-agent `Agent.turnLimitEnabled`. */
  turnLimitFeatureEnabled: () => boolean;
  /** Fired when the writer enters/leaves BROKEN so the coordinator can pause/resume the
   *  agent's crons + monitors (see {@link SchedulerControl}). No-op until a scheduler binds. */
  onBroken: (id: string) => void;
  onUnbroken: (id: string) => void;
}

class AgentWriter {
  private state: WriterState = "OFFLINE";
  /** The one wake queue (FIFO). Advanced on handoff (interactive) or on exit (headless). */
  private pending: string[] = [];
  /** A currently-parked `/wake-stream` long-poll (one poller per agent), or undefined. */
  private interactivePoll?: (prompt: string | null) => void;
  /** Non-channel interactive delivery (codex app-server push). While set, the parked
   *  poll is never served — the push IS the interactive transport. */
  private push?: InteractivePush;
  /** A push delivery is in flight (the head stays queued until its ack). */
  private pushInFlight = false;
  private pushRetryTimer?: NodeJS.Timeout;
  /** Max-runtime kill for the active `-p` child (HEADLESS_RUNNING only). */
  private headlessKillTimer?: NodeJS.Timeout;
  /** Consecutive headless resume-fails; reset by any clean exit. */
  private resumeFailCount = 0;
  /** Set when a user Stop SIGTERMs an in-flight child, so its exit is treated as a
   *  deliberate stop (→ OFFLINE) rather than a resume failure. */
  private stopping = false;

  private readonly registry: AgentRegistry;
  private readonly headless: HeadlessWakeStrategy;
  private readonly maxHeadlessRunMs: () => number;
  private readonly maxHeadlessTurns: () => number;
  private readonly turnLimitFeatureEnabled: () => boolean;
  private readonly onBroken: (id: string) => void;
  private readonly onUnbroken: (id: string) => void;

  constructor(
    private id: string,
    deps: AgentWriterDeps,
  ) {
    this.registry = deps.registry;
    this.headless = deps.headless;
    this.maxHeadlessRunMs = deps.maxHeadlessRunMs;
    this.maxHeadlessTurns = deps.maxHeadlessTurns;
    this.turnLimitFeatureEnabled = deps.turnLimitFeatureEnabled;
    this.onBroken = deps.onBroken;
    this.onUnbroken = deps.onUnbroken;
    // Seed BROKEN from a boot-time spawn-marker reconcile: single-writer crash recovery
    // sets `executionState = broken` directly, before this coordinator exists. (The
    // scheduler's own boot sweep skips arming a broken agent, so no disarm is needed
    // here — this seed doesn't go through `transition`.)
    if (this.registry.executionStateOf(id) === "broken") this.state = "BROKEN";
  }

  // ---- producer / consumer ----

  /** A wake was produced (cron/monitor fire). Route by state. */
  enqueue(prompt: string): void {
    switch (this.state) {
      case "OFFLINE":
        this.pending.push(prompt);
        this.startHeadless();
        break;
      case "INTERACTIVE_RUNNING":
        this.pending.push(prompt);
        this.serveInteractive(); // hand to a parked poll if one's waiting
        break;
      case "HEADLESS_RUNNING":
        this.pending.push(prompt); // drains when the active child exits
        break;
      case "BROKEN":
        // Unresumable; drop. A recurring cron re-fires after a manual Restart.
        hostLog.warn("dropping wake for broken agent", this.id);
        break;
    }
  }

  /** The `/wake-stream` consumer parks here. Served only in INTERACTIVE_RUNNING (the
   *  channel transport); in every other state the poll parks inertly (a headless `-p`
   *  run's MCP also polls, but its channel is inert and must never be served). */
  awaitPoll(signal: AbortSignal, holdMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const finish = (prompt: string | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.interactivePoll === handoff) this.interactivePoll = undefined;
        resolve(prompt);
      };
      const handoff = (prompt: string | null) => finish(prompt);
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), holdMs);
      signal.addEventListener("abort", onAbort);
      this.interactivePoll = handoff; // one poller per agent; replace any stale one
      this.serveInteractive(); // serve immediately if a wake is already queued
    });
  }

  // ---- PTY lifecycle (reported by TerminalService) ----

  onInteractiveUp(push?: InteractivePush): void {
    if (this.state === "HEADLESS_RUNNING") return; // single-writer: no PTY during a `-p` run
    this.resumeFailCount = 0; // a fresh interactive session is healthy
    // A prior push (from the previous PTY, e.g. a respawn-while-interactive) must not
    // leave its in-flight flag or retry timer set — the NEW push's first delivery would
    // be blocked by the stale `pushInFlight`, wedging the queue head (B5).
    this.pushInFlight = false;
    this.clearPushRetry();
    this.push = push;
    this.transition("INTERACTIVE_RUNNING");
    this.serveInteractive();
  }

  onInteractiveDown(): void {
    if (this.state !== "INTERACTIVE_RUNNING") return;
    this.push = undefined;
    this.pushInFlight = false;
    this.clearPushRetry();
    // The live writer is gone; the head + any queued wakes re-route to the `-p` transport.
    this.transition("OFFLINE");
    this.drain();
  }

  // ---- EC1 stop / shutdown ----

  /** EC1 "Stop task" / archive: drop queued wakes + end any active headless run. The
   *  interactive session itself is torn down by TerminalService, not here. */
  stop(): boolean {
    this.pending = [];
    if (this.interactivePoll) {
      const poll = this.interactivePoll;
      this.interactivePoll = undefined;
      poll(null);
    }
    // Only a headless run can be stopped (single-writer: a child is alive iff
    // HEADLESS_RUNNING). Its exit is then a deliberate stop, not a resume failure.
    if (this.state !== "HEADLESS_RUNNING") return false;
    this.stopping = true;
    this.clearKillTimer();
    return this.headless.stop(this.id);
  }

  /** Host shutdown: clear timers (the children are SIGTERM'd via stopAll). */
  dispose(): void {
    this.clearKillTimer();
    this.clearPushRetry();
  }

  // ---- internals ----

  /** Deliver the queue head into the live interactive session. Channel transport:
   *  hand to a parked poll (advance-on-handoff — the head shifts out the instant it's
   *  handed off). Push transport (codex): call the push and advance on its ack —
   *  the head stays queued until the app-server confirms the turn, then shifts. */
  private serveInteractive(): void {
    if (this.state !== "INTERACTIVE_RUNNING") return;
    if (this.push) {
      this.servePush();
      return;
    }
    if (!this.interactivePoll || this.pending.length === 0) return;
    const poll = this.interactivePoll;
    const head = this.pending.shift()!;
    poll(head); // resolves the parked /wake-stream long-poll; finish() clears the slot
  }

  /** Push-mode delivery: one in-flight push at a time; advance-on-ack; a failed
   *  delivery keeps the head and retries while the session stays interactive. */
  private servePush(): void {
    if (this.pushInFlight || this.pending.length === 0) return;
    const push = this.push;
    if (!push) return;
    const head = this.pending[0];
    this.pushInFlight = true;
    push(head).then(
      (ok) => this.pushSettled(push, head, ok),
      () => this.pushSettled(push, head, false),
    );
  }

  private pushSettled(push: InteractivePush, head: string, ok: boolean): void {
    // A newer push replaced this one (respawn-while-interactive installed a fresh push
    // via onInteractiveUp): the current in-flight state belongs to THAT push, so a stale
    // settle must not clear its `pushInFlight` (which would let a duplicate delivery
    // through). Bail before touching any shared state (B5).
    if (this.push !== push) return;
    this.pushInFlight = false;
    // The session may have flipped (PTY died, stop, broken) while the push ran —
    // the head then belongs to whatever transport took over; don't touch it here.
    if (this.state !== "INTERACTIVE_RUNNING") return;
    if (ok) {
      if (this.pending[0] === head) this.pending.shift();
      this.serveInteractive(); // deliver the next queued wake, if any
      return;
    }
    hostLog.warn("interactive wake push failed; retrying", this.id);
    this.clearPushRetry();
    this.pushRetryTimer = setTimeout(() => this.serveInteractive(), PUSH_RETRY_MS);
  }

  private clearPushRetry(): void {
    if (this.pushRetryTimer) {
      clearTimeout(this.pushRetryTimer);
      this.pushRetryTimer = undefined;
    }
  }

  /** OFFLINE with a queued wake → start the `-p` transport for the head. */
  private drain(): void {
    if (this.state !== "OFFLINE" || this.pending.length === 0) return;
    this.startHeadless();
  }

  private startHeadless(): void {
    // The headless turn budget: at most `maxHeadlessTurns` unattended `-p` runs since
    // the last reset — the agent view's turn-limit button is the only refill path (§12.2). An
    // exhausted budget drops the queued wakes and stays OFFLINE — a runaway scheduler
    // can't keep spending while nobody is watching. Recurring crons keep firing (and
    // keep being dropped here) so the agent resumes as soon as the user resets it.
    if (this.turnBudgetExhausted()) {
      hostLog.warn("headless turn limit reached; dropping queued wake(s)", this.id);
      this.pending = [];
      return;
    }
    this.transition("HEADLESS_RUNNING");
    this.armKillTimer();
    // Always count the run (no freeze while the feature is off — the count is reset
    // wholesale when the feature is re-enabled, so there's nothing to preserve). The
    // pause NOTIFICATION only makes sense when the feature + the agent's switch are on
    // and this run crossed the limit.
    const used = this.registry.incrementHeadlessTurns(this.id);
    const agent = this.registry.get(this.id);
    if (
      this.turnLimitFeatureEnabled() &&
      agent?.turnLimitEnabled &&
      used >= this.maxHeadlessTurns()
    ) {
      // This run consumed the last budgeted turn — the next unattended wake is dropped
      // until the user resets the count from the agent view's turn-limit button. Surface it so
      // the user knows the agent has paused and needs a reset (§12.4).
      analytics.track("turn_limit_reached");
      bus.emitEvent("notify", {
        kind: "restricted",
        title: `${agent.name} — Paused`,
        body: `${agent.name} has hit its turn limit. Reset to continue.`,
        agentId: this.id,
      });
    }
    const head = this.pending[0]; // kept at the head until exit (no lost wake on crash)
    this.headless.run(this.id, head, (reason) => this.headlessExited(reason));
  }

  /** True when the turn-limit feature is on globally, the agent's own switch is on, and
   *  its unattended-turn budget is spent. The global off-switch short-circuits first, so
   *  a disabled feature never gates. An unknown agent (e.g. archived mid-queue) is not
   *  gated here — the headless strategy has its own archived/missing guards. */
  private turnBudgetExhausted(): boolean {
    if (!this.turnLimitFeatureEnabled()) return false;
    const agent = this.registry.get(this.id);
    if (!agent?.turnLimitEnabled) return false;
    return agent.headlessTurnsUsed >= this.maxHeadlessTurns();
  }

  /** Would a wake enqueued right now be dropped rather than delivered? True when the
   *  session is BROKEN, or when it's not interactive and the turn budget is spent.
   *  Interactive sessions deliver via the channel and are never gated. The Scheduler
   *  checks this to skip firing a paused agent entirely — otherwise its cron/monitor
   *  keeps emitting a wake notification + history row every interval while nothing runs. */
  wouldDropWake(): boolean {
    if (this.state === "BROKEN") return true;
    if (this.state === "INTERACTIVE_RUNNING") return false;
    return this.turnBudgetExhausted();
  }

  private headlessExited(reason: HeadlessExitReason): void {
    this.clearKillTimer();
    if (this.stopping) {
      // A deliberate user Stop killed the child — don't count it as a resume failure.
      this.stopping = false;
      this.transition("OFFLINE");
      this.drain(); // in case a fresh wake arrived during the stop window
      return;
    }
    if (reason === "spawnFail") {
      // A spawn error is a config fault, not a flaky session: one-strike broken.
      this.pending = [];
      this.transition("BROKEN");
      return;
    }
    if (reason === "resumeFail") {
      this.pending.shift(); // drop the failed wake
      this.resumeFailCount += 1;
      if (this.resumeFailCount >= MAX_RESUME_FAILS) {
        this.pending = []; // genuinely unresumable — drop the rest
        this.transition("BROKEN");
        return;
      }
      this.transition("OFFLINE");
      this.drain();
      return;
    }
    // ok (clean exit, or the max-runtime backstop): complete the head, drain the next.
    this.resumeFailCount = 0;
    this.pending.shift();
    this.transition("OFFLINE");
    this.drain();
  }

  private armKillTimer(): void {
    this.clearKillTimer();
    this.headlessKillTimer = setTimeout(() => {
      hostLog.warn("headless run exceeded max runtime; killing", this.id);
      this.headless.stop(this.id); // SIGTERM; its exit drives headlessExited(ok)
    }, this.maxHeadlessRunMs());
  }

  private clearKillTimer(): void {
    if (this.headlessKillTimer) {
      clearTimeout(this.headlessKillTimer);
      this.headlessKillTimer = undefined;
    }
  }

  /** Set the state and publish it as the agent's `executionState` (1:1, no projection). */
  private transition(next: WriterState): void {
    const prev = this.state;
    this.state = next;
    this.registry.setExecutionState(this.id, TO_EXECUTION_STATE[next]);
    if (next === "BROKEN" && prev !== "BROKEN") {
      analytics.track("agent_marked_broken");
      // Unresumable → pause this agent's scheduling so it stops firing into a dead
      // session (no wake-notification spam, no "dropping wake" churn).
      this.onBroken(this.id);
    } else if (prev === "BROKEN" && next !== "BROKEN") {
      // Recovered (a manual Restart mints a fresh session) → resume its schedules.
      this.onUnbroken(this.id);
    }
  }
}

/**
 * The single authority for agent wake delivery: owns a `Map<agentId, AgentWriter>` and
 * fans the seam's calls to the right per-agent actor. `Scheduler` enqueues via
 * `enqueue`; the `/wake-stream` HTTP long-poll consumes via `awaitPoll`;
 * `TerminalService` reports PTY up/down via `onInteractiveUp`/`onInteractiveDown`.
 *
 * Each `AgentWriter` is one queue drained through two transports (channel vs `-p`),
 * differing only in their advance point — see {@link AgentWriter}.
 */
export class WakeCoordinator implements WakeTransport {
  private writers = new Map<string, AgentWriter>();
  /** Live read of the per-run max duration in ms (a Settings tunable). */
  private maxHeadlessRunMs: () => number;
  /** Live read of the global headless turn limit (a Settings tunable). */
  private maxHeadlessTurns: () => number;
  /** Live read of the global on/off for the whole turn-limit feature (a Settings toggle). */
  private turnLimitFeatureEnabled: () => boolean;
  /** Late-bound (the scheduler is built after this coordinator). While unset, a writer
   *  breaking/recovering is a no-op on scheduling. */
  private scheduler?: SchedulerControl;

  constructor(
    private registry: AgentRegistry,
    private headless: HeadlessWakeStrategy,
    opts: {
      maxHeadlessRunMs?: () => number;
      maxHeadlessTurns?: () => number;
      turnLimitFeatureEnabled?: () => boolean;
    } = {},
  ) {
    this.maxHeadlessRunMs = opts.maxHeadlessRunMs ?? (() => MAX_HEADLESS_RUN_MS);
    this.maxHeadlessTurns = opts.maxHeadlessTurns ?? (() => DEFAULT_SETTINGS.maxHeadlessTurns);
    this.turnLimitFeatureEnabled =
      opts.turnLimitFeatureEnabled ?? (() => DEFAULT_SETTINGS.headlessTurnLimitEnabled);
  }

  /** Bind the scheduler so a broken agent's crons/monitors are paused (and resumed on
   *  Restart). Called once at host wiring, after both are constructed. */
  setScheduler(scheduler: SchedulerControl): void {
    this.scheduler = scheduler;
  }

  private writer(id: string): AgentWriter {
    let w = this.writers.get(id);
    if (!w) {
      w = new AgentWriter(id, {
        registry: this.registry,
        headless: this.headless,
        maxHeadlessRunMs: this.maxHeadlessRunMs,
        maxHeadlessTurns: this.maxHeadlessTurns,
        turnLimitFeatureEnabled: this.turnLimitFeatureEnabled,
        onBroken: (aid) => this.scheduler?.disarmAgent(aid),
        onUnbroken: (aid) => this.scheduler?.rearmAgent(aid),
      });
      this.writers.set(id, w);
    }
    return w;
  }

  enqueue(agentId: string, prompt: string): void {
    this.writer(agentId).enqueue(prompt);
  }

  wouldDropWake(agentId: string): boolean {
    return this.writer(agentId).wouldDropWake();
  }

  awaitPoll(agentId: string, signal: AbortSignal, holdMs: number): Promise<string | null> {
    return this.writer(agentId).awaitPoll(signal, holdMs);
  }

  onInteractiveUp(agentId: string, push?: InteractivePush): void {
    this.writer(agentId).onInteractiveUp(push);
  }

  onInteractiveDown(agentId: string): void {
    // No writer ⇒ nothing ever queued for this agent; a stray PTY exit is a no-op.
    this.writers.get(agentId)?.onInteractiveDown();
  }

  stop(agentId: string): boolean {
    return this.writers.get(agentId)?.stop() ?? false;
  }

  stopAll(): void {
    for (const w of this.writers.values()) w.dispose();
    this.headless.stopAll();
  }
}
