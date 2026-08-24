import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  DeterministicFeedProvider,
  DeterministicXProvider,
  RecruitingApplication,
  RecruitingError,
  recruitingOperationsFor,
  validateRecruitingOperation,
} from ".";

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

const sharedUrl = "https://x.com/openrecruit/status/1000000000000000001";
const rssUrl = "https://example.test/openrecruit.xml";

function rssFixture(content: string): string {
  return `<rss><channel><title>OpenRecruit fixtures</title><link>https://example.test</link><item><guid>rss-1000000000000000001</guid><title>Staff Platform Engineer</title><link>${sharedUrl}</link><description>${content}</description><pubDate>Wed, 20 Aug 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
}

const xFixture = JSON.stringify({
  data: [
    {
      id: "1000000000000000001",
      text: "OpenRecruit is hiring a Staff Platform Engineer to build resilient developer tools.",
      created_at: "2026-08-20T12:01:00.000Z",
      author_id: "42",
      edit_history_tweet_ids: ["1000000000000000001"],
    },
  ],
  includes: { users: [{ id: "42", username: "openrecruit", name: "OpenRecruit" }] },
  meta: { result_count: 1 },
});

function finishRun(app: RecruitingApplication, runId: string, key: string): void {
  const checkpoint = JSON.stringify({ sourceCursor: "fixture-page-1", committedItems: 1 });
  app.advanceScoutRun({
    runId,
    status: "running",
    phase: "discovery",
    checkpoint,
    expectedStatus: "preflight",
    idempotencyKey: `${key}-running`,
  });
  app.checkpointScoutRun({
    runId,
    phase: "discovery",
    checkpoint,
    idempotencyKey: `${key}-checkpoint`,
  });
  app.advanceScoutRun({
    runId,
    status: "finalizing",
    phase: "finalization",
    checkpoint: JSON.stringify({ sourceCursor: "fixture-page-1", finalized: false }),
    expectedStatus: "running",
    idempotencyKey: `${key}-finalizing`,
  });
  app.advanceScoutRun({
    runId,
    status: "completed",
    phase: "finalization",
    checkpoint: JSON.stringify({ sourceCursor: "fixture-page-1", finalized: true }),
    expectedStatus: "finalizing",
    idempotencyKey: `${key}-completed`,
  });
}

describe("source-built two-Scout OpenRecruit POC", () => {
  test("completes the Candidate loop against SQLite fixtures", async () => {
    const now = 1_756_000_000_000;
    const app = new RecruitingApplication(makeDb(), () => now);
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

    const draft = app.importProfile({
      name: "Synthetic Candidate",
      roleTarget: "Staff Platform Engineer",
      cvText: "Built resilient distributed systems and developer tooling.",
      github: {
        handle: "synthetic-engineer",
        facts: [{ key: "portfolio_focus", value: "Developer tools" }],
      },
      careerInterests: "Developer tools and early-stage infrastructure",
      hardConstraints: ["Remote-first"],
      preferences: ["Small product team"],
      idempotencyKey: "poc-profile-import",
    });
    const profile = app.confirmProfile({
      profileId: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: "poc-profile-confirm",
    });
    expect(profile.state).toBe("confirmed");
    expect(profile.currentVersion?.immutable).toBe(true);
    expect(profile.currentVersion?.facts.some((fact) => fact.source === "github")).toBe(true);
    expect(profile.currentVersion?.facts.some((fact) => fact.section === "hard_constraints")).toBe(
      true,
    );

    const rss = app.createRssSource({
      name: "Fixture RSS",
      url: rssUrl,
      idempotencyKey: "poc-rss-source",
    });
    const x = app.createXSource({
      name: "Fixture official X",
      query: "OpenRecruit hiring",
      maxItems: 10,
      maxPages: 1,
      maxRequestsPerRun: 1,
      idempotencyKey: "poc-x-source",
    });
    const rssProvider = new DeterministicFeedProvider({
      [rssUrl]: { status: 200, body: rssFixture("Remote-first platform team") },
    });
    const xProvider = new DeterministicXProvider({
      readiness: { status: 200, body: xFixture },
      search: { status: 200, body: xFixture },
    });
    expect(
      (await app.checkSourceReadiness({ sourceId: rss.value.id, provider: rssProvider })).readiness,
    ).toBe("ready");
    expect(
      (await app.checkSourceReadiness({ sourceId: x.value.id, provider: xProvider })).readiness,
    ).toBe("ready");
    expect(JSON.stringify(app.listSources())).not.toContain("bearer");

    const rssScout = app.createScout({
      name: "RSS Scout",
      harness: "claude",
      instructionPath: "agents/rss-scout",
      strategyMaterial: "Find remote platform roles in public feeds.",
      policyMaterial: "Use selected public Sources only; never contact anyone.",
      defaultProfileId: profile.id,
      sourceIds: [rss.value.id],
      idempotencyKey: "poc-rss-scout",
    });
    const xScout = app.createScout({
      name: "X Scout",
      harness: "codex",
      instructionPath: "agents/x-scout",
      strategyMaterial: "Find public hiring signals from official X.",
      policyMaterial: "Use selected public Sources only; never contact anyone.",
      defaultProfileId: profile.id,
      sourceIds: [x.value.id],
      idempotencyKey: "poc-x-scout",
    });
    expect(new Set([rssScout.value.id, xScout.value.id]).size).toBe(2);

    const rssRun = app.launchScoutRun({
      scoutId: rssScout.value.id,
      trigger: "manual",
      idempotencyKey: "poc-rss-run",
    });
    const xRun = app.launchScoutRun({
      scoutId: xScout.value.id,
      trigger: "manual",
      idempotencyKey: "poc-x-run",
    });
    expect(rssRun.value.profileVersionId).toBe(profile.currentVersion?.id);
    expect(xRun.value.profileVersionId).toBe(profile.currentVersion?.id);

    const rssAttempt = await app.readSource({
      runId: rssRun.value.id,
      sourceId: rss.value.id,
      provider: rssProvider,
    });
    const xAttempt = await app.readSource({
      runId: xRun.value.id,
      sourceId: x.value.id,
      provider: xProvider,
    });
    expect(rssAttempt.outcome).toBe("succeeded_with_items");
    expect(xAttempt.outcome).toBe("succeeded_with_items");
    finishRun(app, rssRun.value.id, "poc-rss");
    finishRun(app, xRun.value.id, "poc-x");

    const signals = app.listSignals();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.provenance.accessMode === "public")).toBe(true);
    expect(signals.every((signal) => signal.attributions.length === 1)).toBe(true);
    expect(
      signals.every(
        (signal) =>
          signal.provenance.sourceAttemptId === signal.sourceAttemptId &&
          signal.provenance.runId === signal.runId &&
          signal.provenance.scoutId === signal.attributions[0]?.scoutId,
      ),
    ).toBe(true);
    const lead = app.listLeads()[0];
    if (!lead) throw new Error("fixture did not create a Lead");
    expect(app.listLeads()).toHaveLength(1);
    expect(lead.signalIds).toHaveLength(2);
    expect(lead.scoutIds.sort()).toEqual([rssScout.value.id, xScout.value.id].sort());
    expect(lead.sourceIds.sort()).toEqual([rss.value.id, x.value.id].sort());
    expect(new Set(signals.map((signal) => signal.sourceAttemptId)).size).toBe(2);
    expect(app.listSourceAttempts(rssRun.value.id)).toMatchObject([
      { sourceId: rss.value.id, outcome: "succeeded_with_items", itemCount: 1 },
    ]);
    expect(app.listSourceAttempts(xRun.value.id)).toMatchObject([
      { sourceId: x.value.id, outcome: "succeeded_with_items", itemCount: 1 },
    ]);
    const rssSignal = signals.find((signal) => signal.sourceId === rss.value.id);
    const xSignal = signals.find((signal) => signal.sourceId === x.value.id);
    if (!rssSignal || !xSignal) throw new Error("cross-Source signals missing");

    const investigation = app.createInvestigation({
      leadId: lead.id,
      question: "Is this role remote-first?",
      idempotencyKey: "poc-investigation",
    });
    const investigationAttempt = app.recordInvestigationAttempt({
      investigationId: investigation.value.id,
      scoutId: rssScout.value.id,
      runId: rssRun.value.id,
      profileVersionId: profile.currentVersion?.id,
      evidence: [{ signalId: rssSignal.id, claim: "Remote-first team", kind: "fact" }],
      conclusion: "The public posting describes a remote-first team.",
      uncertainty: null,
      outcome: "succeeded",
      idempotencyKey: "poc-investigation-attempt",
    });
    expect(investigationAttempt.value.outcome).toBe("succeeded");

    const evaluation = app.createFitEvaluation({
      leadId: lead.id,
      profileVersionId: profile.currentVersion?.id ?? "",
      runId: rssRun.value.id,
      hardConstraints: [
        {
          key: "remote-first",
          result: "satisfied",
          explanation: "The RSS posting describes a remote-first team.",
          signalIds: [rssSignal.id],
        },
        {
          key: "compensation",
          result: "unknown",
          explanation: "No compensation evidence is present.",
        },
      ],
      preferences: [
        {
          key: "small-product-team",
          result: "satisfied",
          explanation: "The X announcement indicates an early product team.",
          signalIds: [xSignal.id],
          inferred: true,
        },
      ],
      evidence: [
        { signalId: rssSignal.id, claim: "Remote-first", kind: "fact" },
        { signalId: xSignal.id, claim: "Early product team", kind: "inference" },
      ],
      conflicts: ["RSS and X describe the same path with different wording."],
      unknowns: ["Compensation"],
      freshness: "fresh",
      nextReconsiderationAt: now + 86_400_000,
      idempotencyKey: "poc-fit-evaluation",
    });
    expect(evaluation.hardConstraints.map((item) => item.result)).toEqual(["satisfied", "unknown"]);
    expect(evaluation.preferences[0]?.inferred).toBe(true);
    expect(evaluation.conflicts).toHaveLength(1);
    expect(evaluation.evidence.every((item) => item.attribution?.scoutId)).toBe(true);

    const opportunity = app.promoteLead({
      leadId: lead.id,
      title: "Staff Platform Engineer",
      expectedRevision: app.getLead(lead.id)?.revision,
      idempotencyKey: "poc-promotion",
    });
    expect(opportunity.value.leadId).toBe(lead.id);
    expect(app.getLead(lead.id)?.id).toBe(lead.id);

    const plan = app.createRevisitPlan({
      scoutId: rssScout.value.id,
      sourceId: rss.value.id,
      cadence: "PT1H",
      dueAt: now,
      idempotencyKey: "poc-revisit-plan",
    });
    const beforeReconnect = app.reviewScoutRunCenter(rssScout.value.id);
    const revisitRequests = app.processDueRevisits();
    expect(revisitRequests).toHaveLength(1);
    expect(revisitRequests[0]?.trigger).toBe("revisit");
    expect(app.processRunRequests()).toHaveLength(1);
    const revisitRunId = app.getRunRequest(revisitRequests[0]?.id ?? "")?.runId;
    if (!revisitRunId) throw new Error("revisit request did not dispatch a Run");
    expect(wakes).toHaveLength(1);
    app.checkpointScoutRun({
      runId: revisitRunId,
      phase: "discovery",
      checkpoint: JSON.stringify({ resumedFrom: "fixture-page-1" }),
      idempotencyKey: "poc-revisit-resume-checkpoint",
    });
    finishRun(app, revisitRunId, "poc-revisit");
    const afterReconnect = app.reviewScoutRunCenter(rssScout.value.id);
    expect(afterReconnect?.revision).toBeGreaterThan(beforeReconnect?.revision ?? 0);
    expect(
      afterReconnect?.checkpoints.some((checkpoint) =>
        checkpoint.checkpoint.includes("resumedFrom"),
      ),
    ).toBe(true);
    expect(app.getRevisitPlan(plan.value.id)?.dueAt).toBe(now + 3_600_000);

    const dismissal = app.recordCandidateDecision({
      leadId: lead.id,
      kind: "dismissal",
      reason: "Candidate wants to watch this path later.",
      expectedRevision: app.getLead(lead.id)?.revision ?? 0,
      idempotencyKey: "poc-dismissal",
    });
    const retry = app.recordCandidateDecision({
      leadId: lead.id,
      kind: "dismissal",
      reason: "Candidate wants to watch this path later.",
      expectedRevision: lead.revision + 1,
      idempotencyKey: "poc-dismissal",
    });
    expect(retry.replayed).toBe(true);
    expect(retry.value.id).toBe(dismissal.value.id);
    let staleDecisionError: unknown;
    try {
      app.recordCandidateDecision({
        leadId: lead.id,
        kind: "reversal",
        reason: "Stale UI write",
        expectedRevision: lead.revision,
        idempotencyKey: "poc-stale-decision",
      });
    } catch (error) {
      staleDecisionError = error;
    }
    expect(staleDecisionError).toBeInstanceOf(RecruitingError);
    expect(staleDecisionError).toMatchObject({ code: "CONFLICT" });

    const retainedBeforeDeletion = app.inspectEvidence();
    const deleted = app.deleteEvidence({
      scope: { kind: "item", sourceItemId: rssSignal.sourceItemId },
      idempotencyKey: "poc-delete-rss-evidence",
    });
    expect(deleted.value.deletedSignalIds).toEqual([rssSignal.id]);
    expect(app.inspectEvidence().items.map((item) => item.signalId)).toEqual([xSignal.id]);
    expect(app.getLead(lead.id)).not.toBeNull();
    expect(app.getFitEvaluation(evaluation.id)?.hardConstraints[0]?.result).toBe("unknown");
    expect(app.getInvestigationAttempt(investigationAttempt.value.id)?.outcome).toBe("unknown");
    expect(app.listCandidateDecisions(lead.id).some((item) => item.id === dismissal.value.id)).toBe(
      true,
    );
    expect(retainedBeforeDeletion.items.every((item) => item.retentionState === "retained")).toBe(
      true,
    );
    expect(retainedBeforeDeletion.items.every((item) => item.retentionUntil !== null)).toBe(true);
    expect(retainedBeforeDeletion.rawCapturesRetained).toBe(false);
    expect(retainedBeforeDeletion.providerTranscriptsRetained).toBe(false);

    const rereadRun = app.launchScoutRun({
      scoutId: rssScout.value.id,
      trigger: "manual",
      idempotencyKey: "poc-reread-run",
    });
    const unchanged = await app.readSource({
      runId: rereadRun.value.id,
      sourceId: rss.value.id,
      provider: rssProvider,
    });
    expect(unchanged.itemCount).toBe(1);
    expect(app.listSignals().map((signal) => signal.id)).toEqual([xSignal.id]);

    expect(recruitingOperationsFor("claude")).toEqual(recruitingOperationsFor("codex"));
    expect(() => validateRecruitingOperation("execute_sql")).toThrow(/not permitted/i);
    expect(() => validateRecruitingOperation("send_message")).toThrow(/not permitted/i);
    expect(app.reviewSidebar().scouts).toHaveLength(2);
    const panel = app.reviewLeadPanel(lead.id);
    expect(panel).toMatchObject({
      lead: { id: lead.id },
      opportunities: [{ id: opportunity.value.id }],
      investigations: [{ id: investigation.value.id }],
      fitEvaluations: [{ id: evaluation.id }],
      candidateDecisions: [{ id: dismissal.value.id }],
    });
    expect(panel?.signals.some((signal) => signal.id === xSignal.id)).toBe(true);
    expect(panel?.sourceReadiness.every((source) => source.readiness === "ready")).toBe(true);
    expect(JSON.stringify(panel)).not.toMatch(/bearer|transcript|password|cookie/i);
  });
});
