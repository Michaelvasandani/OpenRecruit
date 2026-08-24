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

async function fixture() {
  let now = 10_000;
  const app = new RecruitingApplication(makeDb(), () => now);
  const profile = app.importProfile({
    name: "Candidate",
    roleTarget: "Staff engineer",
    cvText: "Built distributed systems",
    careerInterests: "Developer tools",
    hardConstraints: [],
    preferences: [],
    idempotencyKey: "profile-import",
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: "profile-confirm",
  });
  const source = app.createRssSource({
    name: "Jobs",
    url: "https://example.test/jobs.xml",
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
  const run = app.launchScoutRun({ scoutId: scout.value.id, idempotencyKey: "run" });
  const provider = new (await import(".")).DeterministicFeedProvider({
    "https://example.test/jobs.xml": {
      status: 200,
      body: `<rss><channel><item><guid>job-1</guid><title>Staff Engineer</title><link>https://example.test/job-1</link><description>Remote-first team</description></item></channel></rss>`,
    },
  });
  await app.readSource({ runId: run.value.id, sourceId: source.value.id, provider });
  const lead = app.listLeads()[0];
  if (!lead) throw new Error("fixture lead missing");
  return {
    app,
    lead,
    setNow: (value: number) => (now = value),
    run: run.value,
    source: source.value.id,
    scoutId: scout.value.id,
  };
}

describe("Candidate Decisions", () => {
  test("appends one-target decisions, replays identical commands, and exposes history", async () => {
    const { app, lead } = await fixture();
    const first = app.recordCandidateDecision({
      leadId: lead.id,
      kind: "dismissal",
      detail: { reason: "not a fit" },
      expectedRevision: lead.revision,
      idempotencyKey: "dismiss-1",
    });
    const retry = app.recordCandidateDecision({
      leadId: lead.id,
      kind: "dismissal",
      detail: { reason: "not a fit" },
      expectedRevision: lead.revision,
      idempotencyKey: "dismiss-1",
    });

    expect(retry).toMatchObject({ replayed: true, value: first.value });
    expect(app.listCandidateDecisions(lead.id)).toHaveLength(1);
    expect(app.getLeadContext(lead.id)?.candidateDecisions).toHaveLength(1);
    expect(app.getLeadContext(lead.id)?.decisionState).toMatchObject({
      resurfacingSuppressed: true,
    });
  });

  test("rejects changed retries, stale revisions, and two-target decisions", async () => {
    const { app, lead } = await fixture();
    app.recordCandidateDecision({
      leadId: lead.id,
      kind: "correction",
      detail: { correction: "Title is wrong", protected: true },
      expectedRevision: lead.revision,
      idempotencyKey: "correction-1",
    });
    expect(() =>
      app.recordCandidateDecision({
        leadId: lead.id,
        kind: "correction",
        detail: { correction: "Changed payload" },
        expectedRevision: lead.revision,
        idempotencyKey: "correction-1",
      }),
    ).toThrow(RecruitingError);
    expect(() =>
      app.recordCandidateDecision({
        leadId: lead.id,
        kind: "reversal",
        expectedRevision: lead.revision,
        idempotencyKey: "stale-1",
      }),
    ).toThrow(/expected/);
    expect(() =>
      app.recordCandidateDecision({
        leadId: lead.id,
        opportunityId: "missing",
        kind: "review_outcome",
        expectedRevision: lead.revision + 1,
        idempotencyKey: "two-target-1",
      }),
    ).toThrow(RecruitingError);
  });

  test("does not remove evidence and requires new support before promotion after dismissal", async () => {
    const { app, lead } = await fixture();
    app.recordCandidateDecision({
      leadId: lead.id,
      kind: "dismissal",
      detail: { reason: "no longer relevant" },
      expectedRevision: lead.revision,
      idempotencyKey: "dismiss-2",
    });
    expect(app.listSignals()).not.toHaveLength(0);
    expect(() =>
      app.promoteLead({ leadId: lead.id, idempotencyKey: "promotion-after-dismissal" }),
    ).toThrow(RecruitingError);
  });

  test("allows transparent reconsideration only for material new evidence and preserves reversal history", async () => {
    const { app, lead, setNow, run, source } = await fixture();
    const dismissed = app.recordCandidateDecision({
      leadId: lead.id,
      kind: "dismissal",
      detail: { reason: "not now" },
      expectedRevision: lead.revision,
      idempotencyKey: "dismiss-3",
    });
    setNow(20_000);
    const provider = new (await import(".")).DeterministicFeedProvider({
      "https://example.test/jobs.xml": {
        status: 200,
        body: `<rss><channel><item><guid>job-1</guid><title>Staff Engineer</title><link>https://example.test/job-1</link><description>New evidence</description></item></channel></rss>`,
      },
    });
    await app.readSource({ runId: run.id, sourceId: source, provider });
    const signal = app.listSignals().find((item) => item.createdAt > dismissed.value.createdAt);
    if (!signal) throw new Error("new signal missing");
    const reconsidered = app.requestCandidateReconsideration({
      leadId: lead.id,
      evidenceSignalIds: [signal.id],
      expectedRevision: app.getLead(lead.id)?.revision ?? 0,
      idempotencyKey: "reconsider-1",
    });
    expect(reconsidered.value.kind).toBe("reconsideration");
    const reversed = app.recordCandidateDecision({
      leadId: lead.id,
      kind: "reversal",
      detail: { reason: "Candidate changed review outcome" },
      expectedRevision: app.getLead(lead.id)?.revision ?? 0,
      idempotencyKey: "reverse-1",
    });
    expect(reversed.value.kind).toBe("reversal");
    expect(app.listCandidateDecisions(lead.id).map((item) => item.kind)).toEqual([
      "dismissal",
      "reconsideration",
      "reversal",
    ]);
    expect(app.getLeadContext(lead.id)?.decisionState.resurfacingSuppressed).toBe(false);
    expect(() =>
      app.promoteLead({ leadId: lead.id, idempotencyKey: "promotion-needs-current-evidence" }),
    ).toThrow(/current supporting evidence/);
  });

  test("records Opportunity decisions independently while retaining Lead and Opportunity history", async () => {
    const { app, lead } = await fixture();
    const opportunity = app.promoteLead({
      leadId: lead.id,
      idempotencyKey: "promotion-for-decision",
    });
    const decision = app.recordCandidateDecision({
      opportunityId: opportunity.value.id,
      kind: "review_outcome",
      detail: { outcome: "watch" },
      expectedRevision: opportunity.value.revision,
      idempotencyKey: "opportunity-review-1",
    });
    expect(decision.value).toMatchObject({
      leadId: null,
      opportunityId: opportunity.value.id,
      kind: "review_outcome",
    });
    expect(app.listCandidateDecisions(opportunity.value.id)).toHaveLength(1);
    expect(app.getLeadContext(lead.id)?.candidateDecisions).toHaveLength(1);
  });

  test("blocks ordinary scheduled resurfacing after dismissal without deleting the Lead", async () => {
    const { app, lead, scoutId } = await fixture();
    app.recordCandidateDecision({
      leadId: lead.id,
      kind: "dismissal",
      expectedRevision: lead.revision,
      idempotencyKey: "dismiss-scheduled",
    });
    const request = app.requestScheduledRefresh({
      scoutId,
      leadId: lead.id,
      requestKey: "scheduled-dismissed-lead",
      idempotencyKey: "scheduled-dismissed-lead-command",
    });
    expect(request.value.status).toBe("pending");
    expect(app.processRunRequests()).toHaveLength(0);
    expect(app.getRunRequest(request.value.id)?.status).toBe("blocked");
    expect(app.getLead(lead.id)).not.toBeNull();
  });
});
