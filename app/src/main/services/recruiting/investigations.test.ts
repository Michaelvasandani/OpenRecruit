import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { DeterministicFeedProvider, RecruitingApplication } from ".";
import { RecruitingError } from "./errors";

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
  const app = new RecruitingApplication(makeDb(), () => 10_000);
  const profile = app.importProfile({
    name: "Candidate",
    roleTarget: "Staff engineer",
    careerInterests: "Developer tools",
    idempotencyKey: "investigation-profile",
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: "investigation-profile-confirm",
  });
  const source = app.createRssSource({
    name: "Jobs",
    url: "https://example.test/investigations.xml",
    idempotencyKey: "investigation-source",
  });
  const scout = app.createScout({
    name: "Investigator",
    harness: "claude",
    instructionPath: "agents/investigator",
    strategyMaterial: "Investigate public job evidence.",
    policyMaterial: "Use public evidence only.",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: "investigation-scout",
  });
  const run = app.launchScoutRun({
    scoutId: scout.value.id,
    idempotencyKey: "investigation-run",
  });
  await app.readSource({
    runId: run.value.id,
    sourceId: source.value.id,
    provider: new DeterministicFeedProvider({
      "https://example.test/investigations.xml": {
        status: 200,
        body: `<rss><channel><title>Jobs</title><item><guid>investigation-job</guid><title>Staff Engineer</title><link>https://example.test/investigation-job</link><description>Remote-first team</description></item></channel></rss>`,
      },
    }),
  });
  const lead = app.listLeads();
  return {
    app,
    scout: scout.value,
    run: run.value,
    profile: confirmed.currentVersion,
    leadId: lead[0]?.id,
  };
}

describe("shared Investigations", () => {
  test("creates one subject-scoped investigation for equivalent normalized questions", async () => {
    const { app, leadId } = await fixture();
    if (!leadId) throw new Error("fixture lead missing");

    const first = app.createInvestigation({
      leadId,
      question: "  Is this role remote-first? ",
      idempotencyKey: "investigation-create-one",
    });
    const second = app.createInvestigation({
      leadId,
      question: "is   this role remote-first?",
      idempotencyKey: "investigation-create-two",
    });

    expect(first.value.id).toBe(second.value.id);
    expect(first.value.questionKey).toBe("is this role remote-first?");
    expect(first.value.leadId).toBe(leadId);
    expect(first.value.opportunityId).toBeNull();
    expect(app.listInvestigations(leadId)).toHaveLength(1);
  });

  test("rejects an investigation without exactly one Lead or Opportunity subject", async () => {
    const { app, leadId } = await fixture();
    if (!leadId) throw new Error("fixture lead missing");

    expect(() =>
      app.createInvestigation({
        leadId,
        opportunityId: "not-a-real-opportunity",
        question: "Can this be investigated?",
        idempotencyKey: "investigation-invalid-subject",
      }),
    ).toThrow(RecruitingError);
    expect(() =>
      app.createInvestigation({
        question: "Can this be investigated?",
        idempotencyKey: "investigation-missing-subject",
      }),
    ).toThrow(RecruitingError);
  });

  test("coalesces one active Attempt and reuses a current unchanged Attempt", async () => {
    const { app, leadId, scout, run, profile } = await fixture();
    if (!leadId || !profile) throw new Error("fixture incomplete");
    const investigation = app.createInvestigation({
      leadId,
      question: "Is the team distributed?",
      idempotencyKey: "investigation-active",
    });
    const input = {
      investigationId: investigation.value.id,
      scoutId: scout.id,
      runId: run.id,
      profileVersionId: profile.id,
      evidence: [{ signalId: "signal-1", claim: "Remote-first", kind: "fact" as const }],
      strategySnapshot: "Investigate public job evidence.",
      policySnapshot: "Use public evidence only.",
      idempotencyKey: "investigation-attempt-one",
    };
    const started = app.startInvestigationAttempt(input);
    const coalesced = app.startInvestigationAttempt({
      ...input,
      idempotencyKey: "investigation-attempt-two",
    });

    expect(started.decision).toBe("started");
    expect(coalesced.decision).toBe("coalesced");
    expect(coalesced.value.id).toBe(started.value.id);
    expect(app.listInvestigationAttempts(investigation.value.id)).toHaveLength(1);

    const completed = app.completeInvestigationAttempt({
      attemptId: started.value.id,
      outcome: "succeeded",
      conclusion: "The listing says the team is distributed.",
      uncertainty: null,
      idempotencyKey: "investigation-attempt-complete",
    });
    const reused = app.startInvestigationAttempt({
      ...input,
      idempotencyKey: "investigation-attempt-three",
    });
    expect(completed.value.outcome).toBe("succeeded");
    expect(reused.decision).toBe("reused");
    expect(reused.value.id).toBe(started.value.id);
    expect(app.listInvestigationAttempts(investigation.value.id)).toHaveLength(1);
  });

  test("requires a reason for a changed context and preserves superseded conflicting history", async () => {
    const { app, leadId, scout, run, profile } = await fixture();
    if (!leadId || !profile) throw new Error("fixture incomplete");
    const investigation = app.createInvestigation({
      leadId,
      question: "Does this role offer sponsorship?",
      idempotencyKey: "investigation-rerun",
    });
    const base = app.recordInvestigationAttempt({
      investigationId: investigation.value.id,
      scoutId: scout.id,
      runId: run.id,
      profileVersionId: profile.id,
      evidence: [],
      conclusion: "Unknown",
      uncertainty: "The listing is silent.",
      outcome: "unknown",
      strategySnapshot: "Investigate public job evidence.",
      policySnapshot: "Use public evidence only.",
      idempotencyKey: "investigation-rerun-base",
    });

    expect(() =>
      app.startInvestigationAttempt({
        investigationId: investigation.value.id,
        scoutId: scout.id,
        runId: run.id,
        profileVersionId: profile.id,
        evidence: [],
        strategySnapshot: "Investigate public job evidence.",
        policySnapshot: "Changed policy.",
        idempotencyKey: "investigation-rerun-without-reason",
      }),
    ).toThrow(RecruitingError);

    const rerun = app.recordInvestigationAttempt({
      investigationId: investigation.value.id,
      scoutId: scout.id,
      runId: run.id,
      profileVersionId: profile.id,
      evidence: [],
      conclusion: "Sponsorship is available.",
      uncertainty: null,
      outcome: "succeeded",
      strategySnapshot: "Investigate public job evidence.",
      policySnapshot: "Changed policy.",
      rerunReason: "policy_changed",
      idempotencyKey: "investigation-rerun-policy",
    });

    expect(rerun.value.id).not.toBe(base.value.id);
    expect(rerun.value.supersedesAttemptId).toBe(base.value.id);
    expect(app.listInvestigationAttempts(investigation.value.id)).toHaveLength(2);
    expect(app.getInvestigation(investigation.value.id)?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: base.value.id, conclusion: "Unknown" }),
        expect.objectContaining({ id: rerun.value.id, conclusion: "Sponsorship is available." }),
      ]),
    );
  });

  test("includes safe Investigation summaries and Attempts in Lead context", async () => {
    const { app, leadId, scout, run } = await fixture();
    if (!leadId) throw new Error("fixture lead missing");
    const investigation = app.createInvestigation({
      leadId,
      question: "What is the work model?",
      idempotencyKey: "investigation-context",
    });
    app.recordInvestigationAttempt({
      investigationId: investigation.value.id,
      scoutId: scout.id,
      runId: run.id,
      evidence: [{ signalId: "signal-1", claim: "Remote", kind: "fact" }],
      conclusion: "Remote-first",
      uncertainty: null,
      outcome: "succeeded",
      idempotencyKey: "investigation-context-attempt",
    });

    const context = app.getLeadContext(leadId);
    expect(context?.investigations).toHaveLength(1);
    expect(context?.investigations[0]?.latestAttempt?.conclusion).toBe("Remote-first");
    expect(context?.investigations[0]?.latestAttempt).not.toHaveProperty("transcript");
  });
});
