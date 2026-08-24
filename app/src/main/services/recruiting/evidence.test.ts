import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { DeterministicFeedProvider, RecruitingApplication } from ".";

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

function fixture(app: RecruitingApplication) {
  const profile = app.importProfile({
    name: "Candidate",
    roleTarget: "Staff engineer",
    careerInterests: "Developer tools",
    idempotencyKey: "evidence-profile",
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: "evidence-profile-confirm",
  });
  const source = app.createRssSource({
    name: "Evidence feed",
    url: "https://example.test/evidence.xml",
    idempotencyKey: "evidence-source",
  });
  const scout = app.createScout({
    name: "Evidence scout",
    harness: "claude",
    instructionPath: "agents/evidence",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: "evidence-scout",
  });
  const run = app.launchScoutRun({
    scoutId: scout.value.id,
    idempotencyKey: "evidence-run",
  });
  return { source: source.value, run: run.value };
}

const feed = (title: string, id: string, url: string) =>
  `<rss><channel><title>Evidence</title><link>https://example.test/jobs</link><item><guid>${id}</guid><title>${title}</title><link>${url}</link><description>Public evidence for ${title}</description></item></channel></rss>`;

describe("Candidate evidence control", () => {
  test("inspects retention and deletes one item while preserving independently supported evidence", async () => {
    const app = new RecruitingApplication(makeDb(), () => 1_000);
    const { source, run } = fixture(app);
    await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider: new DeterministicFeedProvider({
        "https://example.test/evidence.xml": {
          status: 200,
          body: `${feed("First", "first", "https://example.test/1")}${feed("Second", "second", "https://example.test/2")}`,
        },
      }),
    });

    const before = app.inspectEvidence();
    expect(before.items).toHaveLength(2);
    expect(
      before.items.every((item) => item.retentionUntil === 30 * 24 * 60 * 60 * 1_000 + 1_000),
    ).toBe(true);
    const first = app.listSignals().find((signal) => signal.providerIdentity === "first");
    if (!first) throw new Error("first Signal was not persisted");

    const deleted = app.deleteEvidence({
      scope: { kind: "item", sourceItemId: first.sourceItemId },
      idempotencyKey: "delete-first",
    });
    expect(deleted.value.deletedSignalIds).toEqual([first.id]);
    expect(app.listSignals()).toHaveLength(1);
    expect(app.inspectEvidence().items).toHaveLength(1);
    expect(
      app.deleteEvidence({
        scope: { kind: "item", sourceItemId: first.sourceItemId },
        idempotencyKey: "delete-first",
      }),
    ).toMatchObject({ replayed: true, value: deleted.value });
  });

  test("blocks unchanged refresh after deletion and permits material replacement", async () => {
    let now = 2_000;
    const app = new RecruitingApplication(makeDb(), () => now);
    const { source, run } = fixture(app);
    const provider = new DeterministicFeedProvider({
      "https://example.test/evidence.xml": [
        { status: 200, body: feed("First", "first", "https://example.test/1") },
        { status: 200, body: feed("First", "first", "https://example.test/1") },
        { status: 200, body: feed("Changed", "first", "https://example.test/1") },
      ],
    });
    await app.readSource({ runId: run.id, sourceId: source.id, provider });
    const signal = app.listSignals()[0];
    if (!signal) throw new Error("Signal was not persisted");
    app.deleteEvidence({
      scope: { kind: "source", sourceId: source.id },
      idempotencyKey: "delete-source",
    });
    now += 1;
    const unchanged = await app.readSource({ runId: run.id, sourceId: source.id, provider });
    expect(unchanged.itemCount).toBe(1);
    expect(app.listSignals()).toHaveLength(0);
    now += 1;
    await app.readSource({ runId: run.id, sourceId: source.id, provider });
    expect(app.listSignals()).toHaveLength(1);
    expect(app.listSignals()[0]?.id).not.toBe(signal.id);
  });

  test("recalculates dependent reviews while preserving a Candidate Decision", async () => {
    const app = new RecruitingApplication(makeDb(), () => 3_000);
    const { source, run } = fixture(app);
    await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider: new DeterministicFeedProvider({
        "https://example.test/evidence.xml": {
          status: 200,
          body: feed("Supported role", "supported", "https://example.test/3"),
        },
      }),
    });
    const signal = app.listSignals()[0];
    const lead = app.listLeads()[0];
    if (!signal || !lead || !run.profileVersionId) {
      throw new Error("Evidence fixture was not persisted");
    }
    const evaluation = app.createFitEvaluation({
      leadId: lead.id,
      profileVersionId: run.profileVersionId,
      runId: run.id,
      hardConstraints: [
        {
          key: "role",
          result: "satisfied",
          explanation: "The role is supported by the public posting.",
          signalIds: [signal.id],
        },
      ],
      preferences: [],
      evidence: [{ signalId: signal.id, claim: "Staff role", kind: "fact" }],
      idempotencyKey: "evidence-fit",
    });
    const investigation = app.createInvestigation({
      leadId: lead.id,
      question: "Is this role still open?",
      idempotencyKey: "evidence-investigation",
    });
    const attempt = app.recordInvestigationAttempt({
      investigationId: investigation.value.id,
      scoutId: run.scoutId,
      runId: run.id,
      profileVersionId: run.profileVersionId,
      evidence: [{ signalId: signal.id, claim: "The posting is public", kind: "fact" }],
      conclusion: "The role is open.",
      outcome: "succeeded",
      idempotencyKey: "evidence-attempt",
    });
    const decision = app.recordCandidateDecision({
      leadId: lead.id,
      kind: "review_outcome",
      evidenceSignalIds: [signal.id],
      detail: { note: "Candidate reviewed this path" },
      expectedRevision: app.getLead(lead.id)?.revision ?? 0,
      idempotencyKey: "evidence-decision",
    });

    const deleted = app.deleteEvidence({
      scope: { kind: "item", sourceItemId: signal.sourceItemId },
      idempotencyKey: "delete-dependent-evidence",
    });

    expect(deleted.value.affectedFitEvaluationIds).toEqual([evaluation.id]);
    expect(deleted.value.affectedInvestigationIds).toEqual([investigation.value.id]);
    expect(app.getFitEvaluation(evaluation.id)?.hardConstraints[0]?.result).toBe("unknown");
    expect(app.getFitEvaluation(evaluation.id)?.evidence).toEqual([]);
    expect(app.getInvestigationAttempt(attempt.value.id)?.evidence).toEqual([]);
    expect(app.getInvestigationAttempt(attempt.value.id)?.outcome).toBe("unknown");
    expect(app.getCandidateDecision(decision.value.id)).toMatchObject({
      id: decision.value.id,
      kind: "review_outcome",
    });
    expect(app.getCandidateDecision(decision.value.id)?.detail.evidenceSignalIds).toEqual([]);
  });
});
