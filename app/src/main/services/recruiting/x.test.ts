import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  DeterministicXProvider,
  RecruitingApplication,
  type XApiResponse,
  xConfigFromSource,
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

function makeRun(app: RecruitingApplication, suffix = "x") {
  const profile = app.importProfile({
    name: "Candidate",
    roleTarget: "Staff engineer",
    careerInterests: "Developer tools",
    idempotencyKey: `x-profile-${suffix}`,
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: `x-profile-confirm-${suffix}`,
  });
  const source = app.createXSource({
    name: "Public X discovery",
    query: "(hiring OR jobs) -is:retweet",
    idempotencyKey: `x-source-${suffix}`,
  });
  const scout = app.createScout({
    name: "X Scout",
    harness: "claude",
    instructionPath: "agents/x",
    strategyMaterial: "Find public engineering hiring evidence.",
    policyMaterial: "Use public sources only.",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: `x-scout-${suffix}`,
  });
  const run = app.launchScoutRun({ scoutId: scout.value.id, idempotencyKey: `x-run-${suffix}` });
  return { source: source.value, scout: scout.value, run: run.value };
}

const post = (text = "We are hiring a staff engineer") => ({
  id: "1900000000000000001",
  text,
  created_at: "2026-08-23T15:00:00.000Z",
  author_id: "42",
  edit_history_tweet_ids: ["1900000000000000001"],
});

const successfulSearch: XApiResponse = {
  status: 200,
  body: JSON.stringify({
    data: [post()],
    includes: { users: [{ id: "42", username: "openrecruit", name: "OpenRecruit" }] },
    meta: { result_count: 1 },
  }),
};

describe("official X API v2 Source", () => {
  test("uses Discovery Strategy terminology in Candidate-facing configuration guidance", async () => {
    expect(() => xConfigFromSource("{}")).toThrow(
      "X Source requires recent-search terms derived from the Discovery Strategy or public Post IDs",
    );
    expect(() => xConfigFromSource(JSON.stringify({ query: "x".repeat(513) }))).toThrow(
      "X recent-search terms derived from the Discovery Strategy exceed the bounded length",
    );

    const db = makeDb();
    const app = new RecruitingApplication(db, () => Date.parse("2026-08-23T16:00:00Z"));
    const source = app.createXSource({
      name: "X",
      query: "hiring",
      idempotencyKey: "x-domain-language",
    });
    db.update(schema.sources)
      .set({ config: "{}" })
      .where(eq(schema.sources.id, source.value.id))
      .run();
    const access = await app.checkSourceReadiness({ sourceId: source.value.id });
    expect(access.nextAction).toBe(
      "Configure bounded recent-search terms from the Discovery Strategy or public Post IDs",
    );
  });

  test("keeps bearer configuration out of Source data and reports readiness", async () => {
    const app = new RecruitingApplication(makeDb(), () => Date.parse("2026-08-23T16:00:00Z"));
    const source = app.createXSource({
      name: "X",
      query: "from:openrecruit",
      bearerToken: "Bearer should-never-persist",
      idempotencyKey: "x-secret",
    });
    expect(JSON.stringify(app.getSource(source.value.id))).not.toContain("should-never-persist");
    const provider = new DeterministicXProvider({
      readiness: { status: 200, body: JSON.stringify({ data: [], meta: { result_count: 0 } }) },
    });
    const access = await app.checkSourceReadiness({ sourceId: source.value.id, provider });
    expect(access.readiness).toBe("ready");
    expect(provider.requests[0]?.operation).toBe("search_recent");
    expect(JSON.stringify(provider.requests)).not.toContain("should-never-persist");
  });

  test("normalizes bounded recent search into attributable public Signals", async () => {
    const app = new RecruitingApplication(makeDb(), () => Date.parse("2026-08-23T16:00:00Z"));
    const { source, scout, run } = makeRun(app);
    const provider = new DeterministicXProvider({ search: successfulSearch });

    const attempt = await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider,
      budget: { maxItems: 1, maxPages: 1, maxWallClockMs: 10_000, maxSpendCents: 1 },
    });

    expect(attempt.outcome).toBe("succeeded_with_items");
    expect(provider.requests[0]).toMatchObject({ operation: "search_recent", maxResults: 10 });
    const signal = app.listSignals()[0];
    expect(signal).toMatchObject({
      sourceId: source.id,
      runId: run.id,
      scoutId: scout.id,
      providerIdentity: "1900000000000000001",
      canonicalUrl: "https://x.com/openrecruit/status/1900000000000000001",
      accessMode: "public",
      adapterVersion: "x-api-v2",
      processor: "openrecruit-x-api",
      publicationAt: Date.parse("2026-08-23T15:00:00Z"),
    });
    expect(signal?.evidence).toMatchObject({
      content: "We are hiring a staff engineer",
      providerIdentity: "1900000000000000001",
      author: { id: "42", username: "openrecruit", name: "OpenRecruit" },
      editHistory: ["1900000000000000001"],
    });
    expect(signal?.provenance).toMatchObject({
      sourceKind: "x",
      accessMode: "public",
      authMode: "app_only",
    });
  });

  test("deduplicates unchanged public Posts despite a new compliance retention deadline", async () => {
    let now = Date.parse("2026-08-23T16:00:00Z");
    const app = new RecruitingApplication(makeDb(), () => now);
    const { source, run } = makeRun(app, "dedupe");
    const provider = new DeterministicXProvider({ search: [successfulSearch, successfulSearch] });
    await app.readSource({ runId: run.id, sourceId: source.id, provider });
    now += 60_000;
    await app.readSource({ runId: run.id, sourceId: source.id, provider });
    expect(app.listSignals()).toHaveLength(1);
  });

  test("supports post lookup and makes rate, HTTP, malformed, and budget outcomes explicit", async () => {
    let now = 10_000;
    const app = new RecruitingApplication(makeDb(), () => now);
    const { source, run } = makeRun(app, "outcomes");
    const rateLimited = new DeterministicXProvider({
      search: { status: 429, retryAfterMs: 2_000, body: "{}" },
    });
    const limited = await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider: rateLimited,
    });
    expect(limited.outcome).toBe("rate_limited");
    expect(limited.retryAt).toBe(12_000);

    now = 13_000;
    const malformed = new DeterministicXProvider({ search: { status: 200, body: "not-json" } });
    const malformedAttempt = await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider: malformed,
    });
    expect(malformedAttempt.outcome).toBe("malformed_content");

    const budget = new DeterministicXProvider({ search: { ...successfulSearch, costCents: 2 } });
    const budgetAttempt = await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider: budget,
      budget: { maxSpendCents: 1 },
    });
    expect(budgetAttempt.outcome).toBe("budget_exhausted");

    const lookupSource = app.createXSource({
      name: "X lookup",
      postIds: ["1900000000000000001"],
      idempotencyKey: "x-lookup-source",
    });
    const lookupScout = app.createScout({
      name: "X lookup Scout",
      harness: "codex",
      instructionPath: "agents/x-lookup",
      defaultProfileId: app.listProfiles()[0]?.id,
      sourceIds: [lookupSource.value.id],
      idempotencyKey: "x-lookup-scout",
    });
    const lookupRun = app.launchScoutRun({
      scoutId: lookupScout.value.id,
      idempotencyKey: "x-lookup-run",
    });
    const lookupProvider = new DeterministicXProvider({ lookup: { ...successfulSearch } });
    const lookedUp = await app.readSource({
      runId: lookupRun.value.id,
      sourceId: lookupSource.value.id,
      provider: lookupProvider,
    });
    expect(lookedUp.outcome).toBe("succeeded_with_items");
    expect(lookupProvider.requests[0]?.operation).toBe("lookup");
  });

  test("appends material edits and removes deleted/protected/withheld evidence", async () => {
    let now = 20_000;
    const app = new RecruitingApplication(makeDb(), () => now);
    const { source, run } = makeRun(app, "compliance");
    const provider = new DeterministicXProvider({
      search: [
        successfulSearch,
        {
          status: 200,
          body: JSON.stringify({ data: [post("Edited hiring post")], meta: { result_count: 1 } }),
        },
        {
          status: 200,
          body: JSON.stringify({ data: [{ ...post(), deleted: true }], meta: { result_count: 1 } }),
        },
      ],
    });
    await app.readSource({ runId: run.id, sourceId: source.id, provider });
    now += 100;
    await app.readSource({ runId: run.id, sourceId: source.id, provider });
    expect(app.listSignals()).toHaveLength(2);
    now += 100;
    const deleted = await app.readSource({ runId: run.id, sourceId: source.id, provider });
    expect(deleted.outcome).toBe("succeeded_empty");
    expect(deleted.quarantinedCount).toBe(1);
    expect(app.listSignals()).toHaveLength(0);
    expect(app.listLeads()).toHaveLength(0);
  });
});
