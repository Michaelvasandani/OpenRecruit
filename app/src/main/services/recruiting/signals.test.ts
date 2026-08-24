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

function makeRun(app: RecruitingApplication, suffix = "one") {
  const profile = app.importProfile({
    name: `Candidate ${suffix}`,
    roleTarget: "Staff engineer",
    careerInterests: "Developer tools",
    idempotencyKey: `signal-profile-${suffix}`,
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: `signal-profile-confirm-${suffix}`,
  });
  const source = app.createRssSource({
    name: `Engineering feed ${suffix}`,
    url: `https://example.test/${suffix}.xml`,
    idempotencyKey: `signal-source-${suffix}`,
  });
  const scout = app.createScout({
    name: `Signal Scout ${suffix}`,
    harness: "claude",
    instructionPath: "agents/signals",
    strategyMaterial: "Find staff engineering roles.",
    policyMaterial: "Use public sources only.",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: `signal-scout-${suffix}`,
  });
  const run = app.launchScoutRun({
    scoutId: scout.value.id,
    idempotencyKey: `signal-run-${suffix}`,
  });
  return { source: source.value, scout: scout.value, run: run.value };
}

const feed = (title: string, content: string, extra = "") =>
  `<rss><channel><title>Engineering Jobs</title><link>https://example.test/jobs</link><item><guid>job-1</guid><title>${title}</title><link>https://example.test/jobs/1</link><description>${content}</description>${extra}</item></channel></rss>`;

describe("RSS Signal and Lead pipeline", () => {
  test("records attributable immutable Signals and a durable Lead", async () => {
    const app = new RecruitingApplication(makeDb(), () => 1_000);
    const { source, scout, run } = makeRun(app);
    const provider = new DeterministicFeedProvider({
      "https://example.test/one.xml": {
        status: 200,
        body: feed("Staff Engineer", "Build resilient systems"),
        etag: '"v1"',
      },
    });

    const attempt = await app.readSource({ runId: run.id, sourceId: source.id, provider });

    expect(attempt.outcome).toBe("succeeded_with_items");
    const signals = app.listSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      sourceId: source.id,
      sourceAttemptId: attempt.id,
      runId: run.id,
      scoutId: scout.id,
      canonicalUrl: "https://example.test/jobs/1",
      providerIdentity: "job-1",
      accessMode: "public",
      publicationAt: null,
      retrievedAt: 1_000,
      adapterVersion: "rss-atom-v1",
      processor: "openrecruit-rss-atom",
    });
    expect(signals[0]?.evidence).toMatchObject({ title: "Staff Engineer" });
    expect(signals[0]?.provenance).toMatchObject({ sourceIdentity: "https://example.test/jobs" });
    expect(signals[0]?.evidence.sourceIdentity).toBe("https://example.test/jobs");

    const leads = app.listLeads();
    expect(leads).toHaveLength(1);
    expect(leads[0]?.signalIds).toEqual([signals[0]?.id]);
    expect(leads[0]?.canonicalUrl).toBe("https://example.test/jobs/1");
    expect(leads[0]?.sourceIds).toEqual([source.id]);
    expect(leads[0]?.scoutIds).toEqual([scout.id]);
    expect(app.getScoutRun(run.id)?.signalIds).toEqual([signals[0]?.id]);
    expect(app.getScoutRun(run.id)?.leadIds).toEqual([leads[0]?.id]);
  });

  test("deduplicates unchanged observations but appends material immutable history", async () => {
    let now = 2_000;
    const app = new RecruitingApplication(makeDb(), () => now);
    const { source, run } = makeRun(app, "history");
    const provider = new DeterministicFeedProvider({
      "https://example.test/history.xml": [
        { status: 200, body: feed("Staff Engineer", "Build resilient systems") },
        { status: 200, body: feed("Staff Engineer", "Build resilient systems") },
        { status: 200, body: feed("Principal Engineer", "Build resilient systems") },
      ],
    });

    await app.readSource({ runId: run.id, sourceId: source.id, provider });
    now += 100;
    const leadRevision = app.listLeads()[0]?.revision;
    await app.readSource({ runId: run.id, sourceId: source.id, provider });
    expect(app.listSignals()).toHaveLength(1);
    expect(app.listLeads()[0]?.revision).toBe(leadRevision);
    now += 100;
    await app.readSource({ runId: run.id, sourceId: source.id, provider });

    const signals = app.listSignals();
    expect(signals).toHaveLength(2);
    expect(signals[1]?.supersededSignalId).toBe(signals[0]?.id);
    expect(app.listLeads()).toHaveLength(1);
    expect(app.listLeads()[0]?.signalIds).toHaveLength(2);
  });

  test("retains cross-run attribution without duplicating unchanged evidence", async () => {
    const app = new RecruitingApplication(makeDb(), () => 2_500);
    const first = makeRun(app, "cross-run");
    app.advanceScoutRun({
      runId: first.run.id,
      status: "running",
      expectedStatus: "preflight",
      idempotencyKey: "cross-run-start",
    });
    app.advanceScoutRun({
      runId: first.run.id,
      status: "finalizing",
      expectedStatus: "running",
      idempotencyKey: "cross-run-finalizing",
    });
    app.advanceScoutRun({
      runId: first.run.id,
      status: "completed",
      expectedStatus: "finalizing",
      idempotencyKey: "cross-run-complete",
    });

    const profile = app.listProfiles()[0];
    if (!profile) throw new Error("expected profile");
    const secondScout = app.createScout({
      name: "Second Signal Scout",
      harness: "codex",
      instructionPath: "agents/signals-second",
      defaultProfileId: profile.id,
      sourceIds: [first.source.id],
      idempotencyKey: "cross-run-second-scout",
    });
    const secondRun = app.launchScoutRun({
      scoutId: secondScout.value.id,
      idempotencyKey: "cross-run-second-run",
    });
    const provider = new DeterministicFeedProvider({
      "https://example.test/cross-run.xml": {
        status: 200,
        body: feed("Staff Engineer", "Build resilient systems"),
      },
    });

    await app.readSource({ runId: first.run.id, sourceId: first.source.id, provider });
    await app.readSource({ runId: secondRun.value.id, sourceId: first.source.id, provider });

    expect(app.listSignals()).toHaveLength(1);
    expect(app.listLeads()).toHaveLength(1);
    expect(app.getLead(app.listLeads()[0]?.id ?? "")?.scoutIds).toEqual(
      expect.arrayContaining([first.scout.id, secondScout.value.id]),
    );
  });

  test("quarantines malformed and unattributable items without creating Signals", async () => {
    const app = new RecruitingApplication(makeDb(), () => 3_000);
    const { source, run } = makeRun(app, "quarantine");
    const provider = new DeterministicFeedProvider({
      "https://example.test/quarantine.xml": {
        status: 200,
        body: `<rss><channel><title>Engineering Jobs</title><item><title>No stable identity</title><description>Some content</description></item></channel></rss>`,
      },
    });

    const attempt = await app.readSource({ runId: run.id, sourceId: source.id, provider });

    expect(attempt.outcome).toBe("succeeded_empty");
    expect(attempt.quarantinedCount).toBe(1);
    expect(app.listSignals()).toHaveLength(0);
    expect(app.listLeads()).toHaveLength(0);
  });

  test("commits accepted first-page evidence when a later page fails", async () => {
    const app = new RecruitingApplication(makeDb(), () => 4_000);
    const { source, run } = makeRun(app, "partial");
    const provider = new DeterministicFeedProvider({
      "https://example.test/partial.xml": [
        {
          status: 200,
          nextCursor: "page-2",
          body: feed("Staff Engineer", "First page"),
        },
        { status: 503, body: "unavailable" },
      ],
    });

    const attempt = await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider,
      budget: { maxPages: 2, maxItems: 10 },
    });

    expect(attempt.outcome).toBe("partial");
    expect(attempt.quarantinedCount).toBe(0);
    expect(app.listSignals()).toHaveLength(1);
    expect(app.listLeads()).toHaveLength(1);
  });
});
