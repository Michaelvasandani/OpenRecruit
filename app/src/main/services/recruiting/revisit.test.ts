import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { RecruitingApplication, RecruitingError } from ".";

function makeDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(SCHEMA_DDL);
  const migration: MigrationDb = {
    exec: (sql) => void sqlite.exec(sql),
    rows: (sql) => sqlite.query(sql).all(),
  };
  migrate(migration, { fresh: true });
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function fixture() {
  let now = 10_000;
  const db = makeDb();
  const app = new RecruitingApplication(db, () => now);
  const profile = app.importProfile({
    name: "Candidate",
    roleTarget: "Staff engineer",
    cvText: "Built durable systems",
    careerInterests: "Developer tools",
    idempotencyKey: "profile-import",
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: "profile-confirm",
  });
  const source = app.createSource({
    kind: "rss",
    name: "Jobs",
    idempotencyKey: "source",
  });
  const scout = app.createScout({
    name: "Scout",
    harness: "claude",
    instructionPath: "agents/scout",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: "scout",
  });
  return {
    app,
    db,
    scout: scout.value,
    source: source.value,
    now: (value: number) => (now = value),
  };
}

describe("Recruiting Revisit Plans and durable Run requests", () => {
  test("requires exactly one Revisit Plan subject and allows cadence or no automatic revisit", () => {
    const { app, scout, source } = fixture();
    const plan = app.createRevisitPlan({
      scoutId: scout.id,
      sourceId: source.id,
      cadence: "PT1H",
      idempotencyKey: "plan-source",
    });

    expect(plan.value).toMatchObject({
      scoutId: scout.id,
      sourceId: source.id,
      cadence: "PT1H",
      state: "active",
    });
    expect(plan.value.dueAt).toBe(10_000 + 60 * 60 * 1_000);
    expect(() =>
      app.createRevisitPlan({
        scoutId: scout.id,
        sourceId: source.id,
        leadId: "also-a-subject",
        idempotencyKey: "plan-invalid",
      }),
    ).toThrow(RecruitingError);

    const secondSource = app.createSource({
      kind: "rss",
      name: "More jobs",
      idempotencyKey: "source-2",
    });
    const manualOnly = app.createRevisitPlan({
      scoutId: scout.id,
      sourceId: secondSource.value.id,
      cadence: null,
      idempotencyKey: "plan-manual-only",
    });
    expect(manualOnly.value.dueAt).toBeNull();
  });

  test("coalesces equivalent pending requests and dispatches one pinned Run", () => {
    const { app, scout } = fixture();
    const first = app.requestScheduledRefresh({
      scoutId: scout.id,
      reason: "new signal",
      idempotencyKey: "source-event-1",
    });
    const second = app.requestScheduledRefresh({
      scoutId: scout.id,
      reason: "new signal",
      idempotencyKey: "source-event-2",
    });

    expect(first.value.id).toBe(second.value.id);
    expect(second.value.status).toBe("pending");
    const dispatched = app.processRunRequests();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.runId).toBeTruthy();
    expect(app.listRunRequests()).toHaveLength(1);
    expect(app.listScoutRuns(scout.id)).toHaveLength(1);
  });

  test("coalesces Source Events even when callers use different idempotency keys", () => {
    const { app, scout, source } = fixture();
    const first = app.requestSourceEvent({
      scoutId: scout.id,
      sourceId: source.id,
      reason: "new signal",
      idempotencyKey: "source-event-a",
    });
    const second = app.requestSourceEvent({
      scoutId: scout.id,
      sourceId: source.id,
      reason: "new signal",
      idempotencyKey: "source-event-b",
    });
    expect(second.value.id).toBe(first.value.id);
    expect(app.listRunRequests(scout.id)).toHaveLength(1);
  });

  test("persists Candidate requests and explicit reconsiderations as distinct durable triggers", () => {
    const { app, scout } = fixture();
    const candidate = app.requestCandidateRun({
      scoutId: scout.id,
      reason: "Candidate requested a fresh search",
      idempotencyKey: "candidate-request",
    });
    const explicit = app.requestExplicitReconsideration({
      scoutId: scout.id,
      reason: "Reconsider the stale conclusion",
      idempotencyKey: "explicit-reconsideration",
    });
    expect(candidate.value.trigger).toBe("candidate_request");
    expect(explicit.value.trigger).toBe("explicit_request");
    expect(app.listRunRequests(scout.id)).toHaveLength(2);
  });

  test("does not enqueue the same dispatched Run wake twice", () => {
    const { app, scout } = fixture();
    const wakes: string[] = [];
    app.setWake({
      enqueue: (_agentId, prompt) => wakes.push(prompt),
      wouldDropWake: () => false,
      awaitPoll: async () => null,
      onInteractiveUp: () => {},
      onInteractiveDown: () => {},
      stop: () => false,
      stopAll: () => {},
    });
    app.requestScheduledRefresh({ scoutId: scout.id, idempotencyKey: "idempotent-wake" });
    app.processRunRequests();
    app.processRunRequests();
    expect(wakes).toHaveLength(1);
  });

  test("does not redeliver an active Run wake after application reconstruction", () => {
    const { app, db, scout } = fixture();
    const wakes: string[] = [];
    const wake = {
      enqueue: (_agentId: string, prompt: string) => wakes.push(prompt),
      wouldDropWake: () => false,
      awaitPoll: async () => null,
      onInteractiveUp: () => {},
      onInteractiveDown: () => {},
      stop: () => false,
      stopAll: () => {},
    };
    app.setWake(wake);
    app.requestScheduledRefresh({ scoutId: scout.id, idempotencyKey: "restart-idempotent-wake" });
    app.processRunRequests();
    expect(wakes).toHaveLength(1);

    const recovered = new RecruitingApplication(db, () => 10_000);
    recovered.setWake(wake);

    expect(wakes).toHaveLength(1);
  });

  test("records committed checkpoints and exposes Run Center projections", () => {
    const { app, scout, source } = fixture();
    const requested = app.requestScheduledRefresh({
      scoutId: scout.id,
      idempotencyKey: "scheduled-refresh",
    });
    app.processRunRequests();
    const runId = app.listRunRequests()[0]?.runId;
    if (!runId) throw new Error("request was not dispatched");

    app.checkpointScoutRun({
      runId,
      phase: "discovery",
      checkpoint: JSON.stringify({ sourceId: source.id, cursor: "page-2" }),
      idempotencyKey: "checkpoint-1",
    });
    app.checkpointScoutRun({
      runId,
      phase: "discovery",
      checkpoint: JSON.stringify({ sourceId: source.id, cursor: "page-3" }),
      idempotencyKey: "checkpoint-2",
    });

    expect(app.listScoutRunCheckpoints(runId)).toHaveLength(2);
    expect(app.getScoutRun(runId)?.checkpoint).toContain("page-3");
    const projection = app.getScoutRunCenter(scout.id);
    expect(projection).toMatchObject({
      scoutId: scout.id,
      activeRunId: runId,
      lastRun: expect.objectContaining({ id: runId }),
    });
    expect(requested.value.requestKey).toBeTruthy();
  });

  test("does not wake a Run for a Candidate-disabled Source", () => {
    const { app, scout, source } = fixture();
    app.disableSource(source.id);
    const request = app.requestSourceEvent({
      scoutId: scout.id,
      sourceId: source.id,
      reason: "new source signal",
      idempotencyKey: "disabled-source-event",
    });

    expect(app.processRunRequests()).toEqual([]);
    expect(app.getRunRequest(request.value.id)).toMatchObject({
      status: "blocked",
      safeFailure: "The Candidate disabled this Source",
    });
    expect(app.listScoutRuns(scout.id)).toHaveLength(0);
  });

  test("turns a due cadence into one Revisit request and advances the next due time", () => {
    const { app, scout, source, now } = fixture();
    const plan = app.createRevisitPlan({
      scoutId: scout.id,
      sourceId: source.id,
      cadence: "PT1H",
      dueAt: 10_000,
      idempotencyKey: "due-plan",
    });
    now(10_000);
    const requests = app.processDueRevisits();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      trigger: "revisit",
      sourceId: source.id,
      requestKey: `revisit:${plan.value.id}:10000`,
    });
    expect(app.getRevisitPlan(plan.value.id)?.dueAt).toBe(10_000 + 60 * 60 * 1_000);
    expect(app.processDueRevisits()).toHaveLength(0);
  });

  test("finalizes Runs with each explicit terminal outcome", () => {
    for (const outcome of ["completed", "incomplete", "failed", "cancelled"] as const) {
      const { app, scout } = fixture();
      app.requestScheduledRefresh({
        scoutId: scout.id,
        idempotencyKey: `terminal-${outcome}`,
      });
      app.processRunRequests();
      const runId = app.listScoutRuns(scout.id)[0]?.id;
      if (!runId) throw new Error(`missing ${outcome} Run`);
      app.advanceScoutRun({
        runId,
        status: "running",
        phase: "discovery",
        checkpoint: JSON.stringify({ started: true }),
        idempotencyKey: `${outcome}-running`,
      });
      app.advanceScoutRun({
        runId,
        status: "finalizing",
        phase: "finalization",
        idempotencyKey: `${outcome}-finalizing`,
      });
      const finalized = app.advanceScoutRun({
        runId,
        status: outcome,
        phase: "finalization",
        idempotencyKey: `${outcome}-terminal`,
      });
      expect(finalized.value.status).toBe(outcome);
    }
  });
});
