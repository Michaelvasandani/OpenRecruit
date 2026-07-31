import { describe, expect, test } from "bun:test";
import type { ExecutionState } from "@shared/agent";
import type { AgentRegistry } from "../../agents/registry";
import { WakeCoordinator } from "./coordinator";
import type { HeadlessExitReason, HeadlessWakeStrategy } from "./types";

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal AgentRegistry stand-in: the execution-state surface the coordinator
 *  reads (seed) and writes (publish) — it IS the actor's state, 1:1 — plus the
 *  headless turn budget (`get` + `incrementHeadlessTurns`). An agent with no
 *  seeded budget record reads as un-gated (like the real registry's default row
 *  with the limit toggled off). */
class FakeRegistry {
  states = new Map<string, ExecutionState>();
  budgets = new Map<string, { turnLimitEnabled: boolean; headlessTurnsUsed: number }>();
  executionStateOf(id: string): ExecutionState {
    return this.states.get(id) ?? "offline";
  }
  setExecutionState(id: string, s: ExecutionState): void {
    if (s === "offline") this.states.delete(id);
    else this.states.set(id, s);
  }
  get(id: string) {
    return this.budgets.get(id);
  }
  incrementHeadlessTurns(id: string): number {
    const b = this.budgets.get(id);
    if (!b) return 0;
    b.headlessTurnsUsed += 1;
    return b.headlessTurnsUsed;
  }
}

/** Headless runs report their outcome only when the test calls `finishNext(reason)`. */
class FakeHeadless implements HeadlessWakeStrategy {
  calls: string[] = [];
  stops = 0;
  private exits: Array<(reason: HeadlessExitReason) => void> = [];
  run(id: string, prompt: string, onExit: (reason: HeadlessExitReason) => void): void {
    this.calls.push(`${id}:${prompt}`);
    this.exits.push(onExit);
  }
  /** Simulate the active `-p` child exiting with the given outcome. */
  finishNext(reason: HeadlessExitReason = "ok"): void {
    this.exits.shift()?.(reason);
  }
  stop(): boolean {
    this.stops++;
    return true;
  }
  stopAll(): void {}
}

function make(maxHeadlessRunMs = 10_000, maxHeadlessTurns = 20, featureEnabled = true) {
  const reg = new FakeRegistry();
  const headless = new FakeHeadless();
  const coord = new WakeCoordinator(reg as unknown as AgentRegistry, headless, {
    maxHeadlessRunMs: () => maxHeadlessRunMs,
    maxHeadlessTurns: () => maxHeadlessTurns,
    turnLimitFeatureEnabled: () => featureEnabled,
  });
  return { reg, headless, coord };
}

/** Start a `/wake-stream` poll; returns the promise + its abort controller. */
function poll(c: WakeCoordinator, id: string, holdMs = 10_000) {
  const ac = new AbortController();
  return { p: c.awaitPoll(id, ac.signal, holdMs), ac };
}

describe("WakeCoordinator — headless transport (ported)", () => {
  test("offline agent runs headless, completion-gated on exit", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("a", "p1");
    expect(headless.calls).toEqual(["a:p1"]);
    expect(reg.executionStateOf("a")).toBe("headless");
    headless.finishNext("ok");
    expect(reg.executionStateOf("a")).toBe("offline");
  });

  test("a second headless wake queues behind the active run, then drains in order", () => {
    const { headless, coord } = make();
    coord.enqueue("b", "p1");
    coord.enqueue("b", "p2");
    expect(headless.calls).toEqual(["b:p1"]); // p2 queued, held at the head until exit
    headless.finishNext("ok");
    expect(headless.calls).toEqual(["b:p1", "b:p2"]);
    headless.finishNext("ok");
  });

  test("never serves a poll while a headless run holds the agent", async () => {
    const { headless, coord } = make();
    coord.enqueue("f", "p1"); // offline → headless run
    expect(headless.calls).toEqual(["f:p1"]);
    const ac = new AbortController();
    expect(await coord.awaitPoll("f", ac.signal, 20)).toBeNull(); // channel inert under -p
    expect(headless.calls).toEqual(["f:p1"]); // unchanged
    headless.finishNext("ok");
  });

  test("a headless run is killed by the max-runtime timer", async () => {
    const { headless, coord } = make(20); // tiny max-runtime
    coord.enqueue("x", "p1");
    expect(headless.calls).toEqual(["x:p1"]);
    await wait(40); // kill timer fires → SIGTERM the child
    expect(headless.stops).toBe(1);
  });
});

describe("WakeCoordinator — interactive transport (channel)", () => {
  test("a wake queued before any poll is handed to the next poll", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("d");
    coord.enqueue("d", "p1");
    expect(headless.calls).toEqual([]); // interactive, no poll yet → queued, never headless
    const { p } = poll(coord, "d");
    expect(await p).toBe("p1"); // handed off from the queue head
  });

  test("the head is delivered to a parked poll immediately (no turn gating)", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("c");
    const { p } = poll(coord, "c");
    await tick();
    coord.enqueue("c", "p1"); // mid-turn or not, the channel accepts the push
    expect(await p).toBe("p1");
    expect(headless.calls).toEqual([]); // never headless while interactive
  });

  test("two wakes fired back-to-back are handed to successive polls in order", async () => {
    const { coord } = make();
    coord.onInteractiveUp("t");
    coord.enqueue("t", "p1");
    coord.enqueue("t", "p2"); // both queued (no poll parked yet)
    const { p: p1 } = poll(coord, "t");
    expect(await p1).toBe("p1");
    const { p: p2 } = poll(coord, "t");
    expect(await p2).toBe("p2");
  });

  test("an undelivered head re-routes to headless when the PTY dies before handoff", () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("m");
    coord.enqueue("m", "p1"); // interactive, no poll → queued
    expect(headless.calls).toEqual([]);
    coord.onInteractiveDown("m"); // PTY dies (crash / GUI quit) before any handoff
    expect(headless.calls).toEqual(["m:p1"]); // re-routed to the -p transport
    headless.finishNext("ok");
  });

  test("awaitPoll returns null when the hold elapses", async () => {
    const { coord } = make();
    const ac = new AbortController();
    expect(await coord.awaitPoll("e", ac.signal, 10)).toBeNull();
  });

  test("awaitPoll returns null when the request aborts", async () => {
    const { coord } = make();
    const ac = new AbortController();
    const p = coord.awaitPoll("e2", ac.signal, 10_000);
    await tick();
    ac.abort();
    expect(await p).toBeNull();
  });
});

describe("WakeCoordinator — broken / resume-fail", () => {
  test("a broken agent drops its queued wakes and is never served", async () => {
    const { reg, headless, coord } = make();
    reg.setExecutionState("h", "broken"); // seed from a boot-time reconcile
    coord.enqueue("h", "p1");
    expect(headless.calls).toEqual([]);
    expect(reg.executionStateOf("h")).toBe("broken");
    const ac = new AbortController();
    expect(await coord.awaitPoll("h", ac.signal, 10)).toBeNull();
  });

  test("broken only after 3 consecutive resume-fails; each drops its own wake", () => {
    const { reg, headless, coord } = make();
    for (let i = 1; i <= 2; i++) {
      coord.enqueue("r", `p${i}`);
      expect(reg.executionStateOf("r")).toBe("headless");
      headless.finishNext("resumeFail"); // drops the wake, increments the streak
      expect(reg.executionStateOf("r")).toBe("offline"); // not broken yet
    }
    coord.enqueue("r", "p3");
    headless.finishNext("resumeFail"); // 3rd in a row
    expect(reg.executionStateOf("r")).toBe("broken");
    expect(headless.calls).toEqual(["r:p1", "r:p2", "r:p3"]); // each ran once, then dropped
  });

  test("a clean exit resets the resume-fail streak", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("s", "p1");
    headless.finishNext("resumeFail"); // streak = 1
    coord.enqueue("s", "p2");
    headless.finishNext("ok"); // streak reset to 0
    coord.enqueue("s", "p3");
    headless.finishNext("resumeFail"); // streak = 1 again, NOT 3
    expect(reg.executionStateOf("s")).toBe("offline");
  });

  test("a spawn error is one-strike broken and drops the queue", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("z", "p1");
    coord.enqueue("z", "p2"); // queued behind the active run
    headless.finishNext("spawnFail");
    expect(reg.executionStateOf("z")).toBe("broken");
    expect(headless.calls).toEqual(["z:p1"]); // p2 dropped, never ran
  });

  test("restart (onInteractiveUp) clears broken back to interactive", () => {
    const { reg, coord } = make();
    reg.setExecutionState("w", "broken");
    coord.enqueue("w", "p1"); // creates the writer, seeded broken
    expect(reg.executionStateOf("w")).toBe("broken");
    coord.onInteractiveUp("w"); // manual Restart spawns a fresh PTY
    expect(reg.executionStateOf("w")).toBe("interactive");
  });

  test("going broken disarms the agent's scheduling; recovering re-arms it", () => {
    const { headless, coord } = make();
    const sched = {
      disarmed: [] as string[],
      rearmed: [] as string[],
      disarmAgent(id: string) {
        this.disarmed.push(id);
      },
      rearmAgent(id: string) {
        this.rearmed.push(id);
      },
    };
    coord.setScheduler(sched);

    for (let i = 1; i <= 3; i++) {
      coord.enqueue("b", `p${i}`);
      headless.finishNext("resumeFail");
    }
    expect(sched.disarmed).toEqual(["b"]); // paused exactly once, on the broken transition
    expect(sched.rearmed).toEqual([]);

    coord.onInteractiveUp("b"); // manual Restart
    expect(sched.rearmed).toEqual(["b"]); // scheduling resumes
  });

  test("a spawn-fail broken also disarms scheduling", () => {
    const { coord, headless } = make();
    const disarmed: string[] = [];
    coord.setScheduler({ disarmAgent: (id) => disarmed.push(id), rearmAgent: () => {} });
    coord.enqueue("s", "p1");
    headless.finishNext("spawnFail"); // one-strike broken
    expect(disarmed).toEqual(["s"]);
  });
});

describe("WakeCoordinator — headless turn limit", () => {
  test("each headless run consumes one turn; the run past the budget is dropped", () => {
    const { reg, headless, coord } = make(10_000, 2);
    reg.budgets.set("a", { turnLimitEnabled: true, headlessTurnsUsed: 0 });
    coord.enqueue("a", "p1");
    headless.finishNext("ok");
    coord.enqueue("a", "p2");
    headless.finishNext("ok");
    expect(reg.budgets.get("a")!.headlessTurnsUsed).toBe(2);
    coord.enqueue("a", "p3"); // budget spent → dropped, never spawned
    expect(headless.calls).toEqual(["a:p1", "a:p2"]);
    expect(reg.executionStateOf("a")).toBe("offline"); // stays OFFLINE, not headless
  });

  test("an exhausted budget also gates queued wakes draining after the active run", () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("q", { turnLimitEnabled: true, headlessTurnsUsed: 0 });
    coord.enqueue("q", "p1"); // consumes the only turn
    coord.enqueue("q", "p2"); // queued behind the active run
    headless.finishNext("ok"); // drain → gate trips → p2 dropped
    expect(headless.calls).toEqual(["q:p1"]);
    expect(reg.executionStateOf("q")).toBe("offline");
  });

  test("a reset (the turn-limit button's Reset control) re-opens the budget", () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("v", { turnLimitEnabled: true, headlessTurnsUsed: 1 }); // spent
    coord.enqueue("v", "p1");
    expect(headless.calls).toEqual([]); // gated
    reg.budgets.get("v")!.headlessTurnsUsed = 0; // = registry.resetHeadlessTurns (agents.resetTurnLimit)
    coord.enqueue("v", "p2");
    expect(headless.calls).toEqual(["v:p2"]);
    headless.finishNext("ok");
  });

  test("a disabled per-agent toggle bypasses the limit", () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("d", { turnLimitEnabled: false, headlessTurnsUsed: 99 });
    coord.enqueue("d", "p1");
    expect(headless.calls).toEqual(["d:p1"]);
    headless.finishNext("ok");
    expect(reg.budgets.get("d")!.headlessTurnsUsed).toBe(100); // still counted, never gated
  });

  test("interactive (channel) delivery is never gated or counted", async () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("i", { turnLimitEnabled: true, headlessTurnsUsed: 5 }); // way past the limit
    coord.onInteractiveUp("i");
    coord.enqueue("i", "p1");
    const { p } = poll(coord, "i");
    expect(await p).toBe("p1"); // delivered via the channel regardless of the budget
    expect(headless.calls).toEqual([]);
    expect(reg.budgets.get("i")!.headlessTurnsUsed).toBe(5); // untouched
  });

  test("wouldDropWake: true when broken or turn-exhausted (offline), false when interactive", () => {
    const { reg, coord } = make(10_000, 1);
    // Fresh offline agent, budget open → deliverable.
    reg.budgets.set("w", { turnLimitEnabled: true, headlessTurnsUsed: 0 });
    expect(coord.wouldDropWake("w")).toBe(false);
    // Spent budget while offline → would drop.
    reg.budgets.get("w")!.headlessTurnsUsed = 1;
    expect(coord.wouldDropWake("w")).toBe(true);
    // Interactive session ignores the budget → deliverable via the channel.
    coord.onInteractiveUp("w");
    expect(coord.wouldDropWake("w")).toBe(false);
    // Broken → would drop.
    const { reg: reg2, coord: coord2 } = make();
    reg2.setExecutionState("b", "broken");
    expect(coord2.wouldDropWake("b")).toBe(true);
  });

  test("the global feature switch off: never gated (but still counts — no freeze)", () => {
    const { reg, headless, coord } = make(10_000, 1, /* featureEnabled */ false);
    reg.budgets.set("g", { turnLimitEnabled: true, headlessTurnsUsed: 5 }); // past the limit
    coord.enqueue("g", "p1");
    coord.enqueue("g", "p2"); // queued behind the active run
    expect(headless.calls).toEqual(["g:p1"]); // runs despite budget being spent
    headless.finishNext("ok");
    expect(headless.calls).toEqual(["g:p1", "g:p2"]); // and drains the next, no gate
    headless.finishNext("ok");
    // No freeze: the count still advances while off (it's reset wholesale on re-enable,
    // so there's nothing to preserve). Only gating/notifying is suppressed.
    expect(reg.budgets.get("g")!.headlessTurnsUsed).toBe(7); // 5 + 2 runs
  });
});

describe("WakeCoordinator — stop", () => {
  test("stop() clears pending and ends an in-flight headless run", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("i", "p1"); // headless run in flight
    coord.enqueue("i", "p2"); // queued
    expect(coord.stop("i")).toBe(true);
    expect(headless.stops).toBe(1);
    headless.finishNext("ok"); // the SIGTERM'd child exits (treated as a deliberate stop)
    expect(reg.executionStateOf("i")).toBe("offline");
    expect(headless.calls).toEqual(["i:p1"]); // p2 was cleared, never ran
  });

  test("stop() on an interactive agent clears the queue and reports no headless run", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("j");
    coord.enqueue("j", "p1"); // queued (no poll)
    expect(coord.stop("j")).toBe(false); // nothing headless to stop
    const { p } = poll(coord, "j", 10);
    expect(await p).toBeNull(); // queue cleared → a fresh poll parks, then the hold elapses
    expect(headless.calls).toEqual([]);
  });

  test("stop() on an unknown agent is a no-op", () => {
    const { coord } = make();
    expect(coord.stop("nope")).toBe(false);
  });
});
