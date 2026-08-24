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

const feedWithIdentity = (identity: string, url: string, title: string, content: string) =>
  `<rss><channel><title>Engineering Jobs</title><link>https://example.test/jobs</link><item><guid>${identity}</guid><title>${title}</title><link>${url}</link><description>${content}</description></item></channel></rss>`;

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

  test("converges exact canonical identities across RSS and X-shaped sources while retaining every Scout attribution", async () => {
    const app = new RecruitingApplication(makeDb(), () => 5_000);
    const first = makeRun(app, "canonical-rss");
    const profile = app.listProfiles()[0];
    if (!profile) throw new Error("expected profile");
    const secondSource = app.createRssSource({
      name: "X-shaped mirror",
      url: "https://example.test/canonical-x.xml",
      idempotencyKey: "canonical-x-source",
    });
    const secondScout = app.createScout({
      name: "X Scout",
      harness: "codex",
      instructionPath: "agents/x",
      strategyMaterial: "Find public hiring posts.",
      policyMaterial: "Use public sources only.",
      defaultProfileId: profile.id,
      sourceIds: [secondSource.value.id],
      idempotencyKey: "canonical-x-scout",
    });
    const secondRun = app.launchScoutRun({
      scoutId: secondScout.value.id,
      idempotencyKey: "canonical-x-run",
    });
    const firstProvider = new DeterministicFeedProvider({
      "https://example.test/canonical-rss.xml": {
        status: 200,
        body: feedWithIdentity(
          "rss-job-1",
          "https://example.test/jobs/canonical",
          "Staff Engineer",
          "Build resilient systems",
        ),
      },
    });
    const secondProvider = new DeterministicFeedProvider({
      "https://example.test/canonical-x.xml": {
        status: 200,
        body: feedWithIdentity(
          "x-post-1",
          "https://example.test/jobs/canonical",
          "Hiring Staff Engineer",
          "Build resilient systems",
        ),
      },
    });

    await app.readSource({
      runId: first.run.id,
      sourceId: first.source.id,
      provider: firstProvider,
    });
    await app.readSource({
      runId: secondRun.value.id,
      sourceId: secondSource.value.id,
      provider: secondProvider,
    });

    const signals = app.listSignals();
    expect(signals).toHaveLength(2);
    expect(app.listLeads()).toHaveLength(1);
    expect(app.listLeads()[0]?.signalIds).toEqual(expect.arrayContaining(signals.map((s) => s.id)));
    expect(app.listLeads()[0]?.scoutIds).toEqual(
      expect.arrayContaining([first.scout.id, secondScout.value.id]),
    );
    expect(signals.every((signal) => signal.attributions.length === 1)).toBe(true);
  });

  test("merges ambiguous Leads through an idempotent revisioned operation without dropping evidence", async () => {
    const app = new RecruitingApplication(makeDb(), () => 6_000);
    const first = makeRun(app, "merge-first");
    const second = makeRun(app, "merge-second");
    const firstProvider = new DeterministicFeedProvider({
      "https://example.test/merge-first.xml": {
        status: 200,
        body: feedWithIdentity(
          "merge-job-a",
          "https://example.test/jobs/a",
          "Staff Engineer",
          "Acme platform team",
        ),
      },
    });
    const secondProvider = new DeterministicFeedProvider({
      "https://example.test/merge-second.xml": {
        status: 200,
        body: feedWithIdentity(
          "merge-job-b",
          "https://example.test/jobs/b",
          "Platform Engineer",
          "Acme platform team",
        ),
      },
    });
    await app.readSource({
      runId: first.run.id,
      sourceId: first.source.id,
      provider: firstProvider,
    });
    await app.readSource({
      runId: second.run.id,
      sourceId: second.source.id,
      provider: secondProvider,
    });
    const leads = app.listLeads();
    const firstLead = leads.find((lead) => lead.sourceIds.includes(first.source.id));
    const secondLead = leads.find((lead) => lead.sourceIds.includes(second.source.id));
    if (!firstLead || !secondLead) throw new Error("expected two Leads");

    const merged = app.mergeLeads({
      targetLeadId: firstLead.id,
      sourceLeadId: secondLead.id,
      expectedRevision: firstLead.revision,
      idempotencyKey: "merge-leads-once",
    });
    expect(merged.replayed).toBe(false);
    expect(app.listLeads()).toHaveLength(1);
    expect(merged.value.signalIds).toEqual(
      expect.arrayContaining([...firstLead.signalIds, ...secondLead.signalIds]),
    );
    const replay = app.mergeLeads({
      targetLeadId: firstLead.id,
      sourceLeadId: secondLead.id,
      expectedRevision: firstLead.revision,
      idempotencyKey: "merge-leads-once",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.value.id).toBe(merged.value.id);
    expect(() =>
      app.mergeLeads({
        targetLeadId: firstLead.id,
        sourceLeadId: secondLead.id,
        expectedRevision: firstLead.revision,
        idempotencyKey: "merge-leads-stale-payload",
      }),
    ).toThrow(RecruitingError);
  });

  test("links conflicting evidence without silently moving it and exposes conflict metadata", async () => {
    const app = new RecruitingApplication(makeDb(), () => 7_000);
    const first = makeRun(app, "conflict-first");
    const second = makeRun(app, "conflict-second");
    await app.readSource({
      runId: first.run.id,
      sourceId: first.source.id,
      provider: new DeterministicFeedProvider({
        "https://example.test/conflict-first.xml": {
          status: 200,
          body: feedWithIdentity("conflict-a", "https://example.test/jobs/a", "Acme", "Team A"),
        },
      }),
    });
    await app.readSource({
      runId: second.run.id,
      sourceId: second.source.id,
      provider: new DeterministicFeedProvider({
        "https://example.test/conflict-second.xml": {
          status: 200,
          body: feedWithIdentity("conflict-b", "https://example.test/jobs/b", "Acme", "Team B"),
        },
      }),
    });
    const [firstLead, secondLead] = app.listLeads();
    const secondSignal = app.listSignals().find((signal) => signal.sourceId === second.source.id);
    if (!firstLead || !secondLead || !secondSignal) throw new Error("expected conflict fixtures");
    const linked = app.linkSignalToLead({
      leadId: firstLead.id,
      signalId: secondSignal.id,
      relation: "conflict",
      expectedRevision: firstLead.revision,
      idempotencyKey: "link-conflict-once",
    });
    expect(linked.value.identityState).toBe("conflicted");
    expect(linked.value.conflicts.length).toBeGreaterThan(0);
    expect(linked.value.signalIds).toEqual(expect.arrayContaining([secondSignal.id]));
    expect(app.listLeads()).toHaveLength(2);
    const replay = app.linkSignalToLead({
      leadId: firstLead.id,
      signalId: secondSignal.id,
      relation: "conflict",
      expectedRevision: firstLead.revision,
      idempotencyKey: "link-conflict-once",
    });
    expect(replay.replayed).toBe(true);
    expect(() =>
      app.linkSignalToLead({
        leadId: firstLead.id,
        signalId: secondSignal.id,
        relation: "conflict",
        expectedRevision: firstLead.revision,
        idempotencyKey: "link-conflict-stale",
      }),
    ).toThrow(RecruitingError);
  });
});
