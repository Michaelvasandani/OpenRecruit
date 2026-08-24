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

describe("Candidate review projections", () => {
  test("compose safe sidebar, Run Center, and Lead panel projections from authoritative data", async () => {
    const app = new RecruitingApplication(makeDb(), () => 10_000);
    const profile = app.importProfile({
      name: "Candidate",
      roleTarget: "Staff engineer",
      careerInterests: "Developer tools",
      idempotencyKey: "review-profile",
    });
    const confirmed = app.confirmProfile({
      profileId: profile.id,
      expectedRevision: profile.revision,
      idempotencyKey: "review-profile-confirm",
    });
    const source = app.createRssSource({
      name: "Public jobs",
      url: "https://example.test/jobs.xml",
      idempotencyKey: "review-source",
    });
    const scout = app.createScout({
      name: "Staff Scout",
      harness: "claude",
      instructionPath: "agents/staff",
      defaultProfileId: confirmed.id,
      sourceIds: [source.value.id],
      idempotencyKey: "review-scout",
    });
    const run = app.launchScoutRun({
      scoutId: scout.value.id,
      idempotencyKey: "review-run",
    });
    await app.readSource({
      runId: run.value.id,
      sourceId: source.value.id,
      provider: new DeterministicFeedProvider({
        "https://example.test/jobs.xml": {
          status: 200,
          body: "<rss><channel><title>Jobs</title><item><guid>job-1</guid><title>Staff Engineer</title><link>https://example.test/jobs/1</link><description>Build resilient systems</description></item></channel></rss>",
        },
      }),
    });
    const lead = app.listLeads()[0];
    if (!lead) throw new Error("expected a Lead");
    app.createRevisitPlan({
      scoutId: scout.value.id,
      leadId: lead.id,
      cadence: "PT1H",
      dueAt: 10_000,
      idempotencyKey: "review-revisit",
    });

    const sidebar = app.reviewSidebar();
    expect(sidebar.scouts).toHaveLength(1);
    expect(sidebar.scouts[0]).toMatchObject({
      scout: { id: scout.value.id },
      activeRun: { id: run.value.id },
      latestRun: { id: run.value.id },
      freshLeadCount: 1,
      dueRevisitCount: 1,
      sourceReadiness: { total: 1, ready: 1 },
    });

    const center = app.reviewScoutRunCenter(scout.value.id);
    expect(center).toMatchObject({
      scoutId: scout.value.id,
      activeRun: { id: run.value.id },
      recentRuns: [{ id: run.value.id }],
      signals: [{ runId: run.value.id }],
      sourceAttempts: [{ runId: run.value.id, sourceId: source.value.id }],
      freshLeads: [{ id: lead.id }],
    });
    expect(center.activity.some((item) => item.kind === "source_attempt_completed")).toBe(true);
    expect(center.activity.some((item) => item.kind === "lead_linked")).toBe(true);
    expect(center.sources[0]).not.toHaveProperty("config");
    expect(center.sources[0]).not.toHaveProperty("token");

    const panel = app.reviewLeadPanel(lead.id);
    expect(panel).toMatchObject({
      lead: { id: lead.id, scoutIds: [scout.value.id] },
      signals: [{ id: expect.any(String) }],
      revisitPlans: [{ leadId: lead.id }],
      sourceReadiness: [{ id: source.value.id, readiness: "ready" }],
    });
    expect(panel).not.toHaveProperty("transcript");
    expect(panel).not.toHaveProperty("secrets");
  });
});
