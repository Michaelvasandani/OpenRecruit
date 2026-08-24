import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { DeterministicFeedProvider, RecruitingApplication, RecruitingError } from ".";

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
    cvText: "Built distributed systems",
    careerInterests: "Developer tools",
    hardConstraints: ["Remote-first"],
    preferences: ["Small team"],
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
    strategyMaterial: "Find thoughtful engineering teams",
    policyMaterial: "Use public evidence",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: "scout",
  });
  const run = app.launchScoutRun({ scoutId: scout.value.id, idempotencyKey: "run" });
  const provider = new DeterministicFeedProvider({
    "https://example.test/jobs.xml": {
      status: 200,
      body: `<rss><channel><title>Jobs</title><link>https://example.test</link><item><guid>job-1</guid><title>Staff Engineer</title><link>https://example.test/job-1</link><description>Remote-first team</description></item></channel></rss>`,
    },
  });
  await app.readSource({
    runId: run.value.id,
    sourceId: source.value.id,
    provider,
  });
  const lead = app.listLeads()[0];
  if (!lead || !confirmed.currentVersion) throw new Error("fixture incomplete");
  const signal = app.listSignals()[0];
  if (!signal) throw new Error("fixture signal missing");
  return { app, profile: confirmed, run: run.value, lead, signal };
}

describe("transparent Fit Evaluations and non-destructive Promotion", () => {
  test("stores separate constraint and preference results with attributable evidence and run metadata", async () => {
    const { app, profile, run, lead, signal } = await fixture();
    const evaluation = app.createFitEvaluation({
      leadId: lead.id,
      profileVersionId: profile.currentVersion?.id ?? "",
      runId: run.id,
      hardConstraints: [
        {
          key: "remote-first",
          result: "satisfied",
          explanation: "The listing explicitly describes a remote-first team.",
          signalIds: [signal.id],
        },
        {
          key: "visa-sponsorship",
          result: "unknown",
          explanation: "The listing does not state sponsorship policy.",
          signalIds: [],
        },
      ],
      preferences: [
        {
          key: "small-team",
          result: "not_applicable",
          explanation: "Team size is not stated.",
          signalIds: [],
        },
      ],
      evidence: [
        {
          signalId: signal.id,
          claim: "The role is described as remote-first.",
          kind: "fact",
        },
      ],
      conflicts: [],
      unknowns: ["visa-sponsorship"],
      freshness: "fresh",
      nextReconsiderationAt: 20_000,
      idempotencyKey: "evaluation",
    });

    expect(evaluation).toMatchObject({
      leadId: lead.id,
      opportunityId: null,
      profileVersionId: profile.currentVersion?.id,
      runId: run.id,
      freshness: "fresh",
      hardConstraints: expect.arrayContaining([
        expect.objectContaining({ key: "remote-first", result: "satisfied" }),
        expect.objectContaining({ key: "visa-sponsorship", result: "unknown" }),
      ]),
      preferences: [expect.objectContaining({ key: "small-team", result: "not_applicable" })],
      evidence: [expect.objectContaining({ signalId: signal.id, kind: "fact" })],
      strategyMaterial: expect.stringContaining("thoughtful"),
      policyMaterial: expect.stringContaining("public"),
      nextReconsiderationAt: 20_000,
    });
    expect("score" in evaluation).toBe(false);
    expect(app.listFitEvaluations(lead.id)).toHaveLength(1);
    expect(app.getLeadContext(lead.id)?.fitEvaluations).toHaveLength(1);
  });

  test("rejects a satisfied hard constraint when all cited evidence is stale", async () => {
    const { app, profile, run, lead, signal } = await fixture();
    expect(() =>
      app.createFitEvaluation({
        leadId: lead.id,
        profileVersionId: profile.currentVersion?.id ?? "",
        runId: run.id,
        hardConstraints: [
          {
            key: "remote-first",
            result: "satisfied",
            explanation: "Only old evidence supports this.",
            signalIds: [signal.id],
          },
        ],
        preferences: [],
        evidence: [{ signalId: signal.id, claim: "Old claim", kind: "fact", freshness: "stale" }],
        freshness: "stale",
        idempotencyKey: "stale-evaluation",
      }),
    ).toThrow(RecruitingError);
  });

  test("does not let stale evidence for another Signal invalidate a fresh hard constraint", async () => {
    const { app, profile, run, lead, signal } = await fixture();
    const source = app.listSources()[0];
    if (!source) throw new Error("fixture source missing");
    await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider: new DeterministicFeedProvider({
        "https://example.test/jobs.xml": {
          status: 200,
          body: `<rss><channel><title>Jobs</title><item><guid>job-2</guid><title>Unrelated Signal</title><link>https://example.test/job-2</link><description>Unrelated stale context</description></item></channel></rss>`,
        },
      }),
    });
    const unrelatedSignal = app.listSignals().find((candidate) => candidate.id !== signal.id);
    if (!unrelatedSignal) throw new Error("fixture unrelated signal missing");

    const evaluation = app.createFitEvaluation({
      leadId: lead.id,
      profileVersionId: profile.currentVersion?.id ?? "",
      runId: run.id,
      hardConstraints: [
        {
          key: "remote-first",
          result: "satisfied",
          explanation: "The hard constraint has fresh supporting evidence.",
          signalIds: [signal.id],
        },
      ],
      preferences: [],
      evidence: [
        { signalId: signal.id, claim: "Remote-first team", kind: "fact" },
        {
          signalId: unrelatedSignal.id,
          claim: "Unrelated stale context",
          kind: "fact",
          freshness: "stale",
        },
      ],
      freshness: "fresh",
      idempotencyKey: "unrelated-stale-evidence",
    });

    expect(evaluation.hardConstraints[0]).toMatchObject({
      key: "remote-first",
      result: "satisfied",
      signalIds: [signal.id],
    });
  });

  test("requires each settled hard constraint to cite its own attributable Signals", async () => {
    const { app, profile, run, lead, signal } = await fixture();

    expect(() =>
      app.createFitEvaluation({
        leadId: lead.id,
        profileVersionId: profile.currentVersion?.id ?? "",
        runId: run.id,
        hardConstraints: [
          {
            key: "remote-first",
            result: "satisfied",
            explanation: "The listing explicitly describes a remote-first team.",
            signalIds: [signal.id],
          },
          {
            key: "visa-sponsorship",
            result: "contradicted",
            explanation: "The listing says sponsorship is unavailable.",
            signalIds: [],
          },
        ],
        preferences: [],
        evidence: [
          {
            signalId: signal.id,
            claim: "The role is described as remote-first.",
            kind: "fact",
          },
        ],
        idempotencyKey: "constraint-attribution",
      }),
    ).toThrow(RecruitingError);
  });

  test("requires each settled preference to cite its own attributable Signals", async () => {
    const { app, profile, run, lead, signal } = await fixture();

    expect(() =>
      app.createFitEvaluation({
        leadId: lead.id,
        profileVersionId: profile.currentVersion?.id ?? "",
        runId: run.id,
        hardConstraints: [],
        preferences: [
          {
            key: "small-team",
            result: "satisfied",
            explanation: "The listing describes a small team.",
            signalIds: [],
          },
        ],
        evidence: [
          {
            signalId: signal.id,
            claim: "The listing describes a small team.",
            kind: "fact",
          },
        ],
        idempotencyKey: "preference-attribution",
      }),
    ).toThrow(RecruitingError);
  });

  test("confirming a new profile version stales current evaluations without changing run snapshots", async () => {
    const { app, profile, run, lead, signal } = await fixture();
    const first = app.createFitEvaluation({
      leadId: lead.id,
      profileVersionId: profile.currentVersion?.id ?? "",
      runId: run.id,
      hardConstraints: [],
      preferences: [],
      evidence: [{ signalId: signal.id, claim: "Listing claim", kind: "fact" }],
      freshness: "fresh",
      idempotencyKey: "stale-profile-evaluation",
    });
    const edited = app.updateProfileDraft({
      profileId: profile.id,
      expectedRevision: profile.revision,
      addFacts: [
        {
          section: "preferences",
          key: "team-size",
          value: "Small team",
          source: "manual",
          sourceLabel: "Candidate",
        },
      ],
      idempotencyKey: "profile-edit",
    });
    const updated = app.confirmProfile({
      profileId: profile.id,
      expectedRevision: edited.revision,
      idempotencyKey: "profile-reconfirm",
    });
    const current = app.getFitEvaluation(first.id);
    expect(current).toMatchObject({
      freshness: "stale",
      staleReason: "candidate_profile_changed",
      staleAt: 10_000,
      currentProfileVersionId: updated.currentVersion?.id,
    });
    expect(app.getScoutRun(run.id)?.profileVersionId).toBe(profile.currentVersion?.id);
  });

  test("promotes a Lead to multiple Opportunities without replacing the Lead", async () => {
    const { app, lead } = await fixture();
    const first = app.promoteLead({
      leadId: lead.id,
      title: "Staff Engineer — Platform",
      idempotencyKey: "promotion-one",
    });
    const second = app.promoteLead({
      leadId: lead.id,
      title: "Staff Engineer — Developer Experience",
      idempotencyKey: "promotion-two",
    });
    expect(first.value.leadId).toBe(lead.id);
    expect(second.value.leadId).toBe(lead.id);
    expect(first.value.id).not.toBe(second.value.id);
    expect(app.getLead(lead.id)?.id).toBe(lead.id);
    expect(app.getLeadContext(lead.id)?.opportunities).toHaveLength(2);
    expect(app.listOpportunities(lead.id).map((item) => item.title)).toEqual(
      expect.arrayContaining([
        "Staff Engineer — Platform",
        "Staff Engineer — Developer Experience",
      ]),
    );
  });
});
