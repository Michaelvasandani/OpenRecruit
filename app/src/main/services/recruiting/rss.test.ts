import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { DeterministicFeedProvider, RecruitingApplication, type SourceAttemptOutcome } from ".";

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

function makeRun(app: RecruitingApplication) {
  const profile = app.importProfile({
    name: "Candidate",
    roleTarget: "Staff engineer",
    careerInterests: "Developer tools",
    idempotencyKey: "rss-profile-import",
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: "rss-profile-confirm",
  });
  const source = app.createRssSource({
    name: "OpenRecruit feed",
    url: "https://example.test/feed.xml",
    idempotencyKey: "rss-source",
  });
  const scout = app.createScout({
    name: "RSS Scout",
    harness: "claude",
    instructionPath: "agents/rss",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: "rss-scout",
  });
  const run = app.launchScoutRun({ scoutId: scout.value.id, idempotencyKey: "rss-run" });
  return { source: source.value, run: run.value };
}

describe("RSS/Atom Source access and bounded attempts", () => {
  test("rejects feed URLs that would smuggle authentication material", () => {
    const app = new RecruitingApplication(makeDb());
    expect(() =>
      app.createRssSource({
        name: "Private feed",
        url: "https://example.test/feed.xml?api_key=should-not-persist",
        idempotencyKey: "rss-private-url",
      }),
    ).toThrow(/authentication material/i);
  });

  test("onboards a feed URL with separate public Source Access and validates identity", async () => {
    const app = new RecruitingApplication(makeDb(), () => 1_000);
    const provider = new DeterministicFeedProvider({
      "https://example.test/feed.xml": {
        status: 200,
        etag: '"v1"',
        body: `<?xml version="1.0"?><rss><channel><title>Example Jobs</title><link>https://example.test/</link><item><guid>job-1</guid><title>Staff Engineer</title><link>https://example.test/jobs/1</link></item></channel></rss>`,
      },
    });

    const source = app.createRssSource({
      name: "Example Jobs",
      url: "https://example.test/feed.xml",
      idempotencyKey: "source-onboard",
    });
    expect(source.value.readiness).toBe("not_configured");
    expect(app.getSourceAccess(source.value.id)).toMatchObject({
      sourceId: source.value.id,
      accessMode: "public",
      readiness: "not_configured",
    });

    const checked = await app.checkSourceReadiness({
      sourceId: source.value.id,
      provider,
    });
    expect(checked.readiness).toBe("ready");
    expect(checked.lastSuccessAt).toBe(1_000);
    expect(checked.nextAction).toMatch(/run/i);
    expect(JSON.stringify(checked)).not.toMatch(/Example Jobs|Staff Engineer|v1/);
  });

  test("uses validators, stable cursors, conditional retrieval, and host budgets", async () => {
    let now = 2_000;
    const app = new RecruitingApplication(makeDb(), () => now);
    const { source, run } = makeRun(app);
    const provider = new DeterministicFeedProvider({
      "https://example.test/feed.xml": [
        {
          status: 200,
          etag: '"v1"',
          body: `<?xml version="1.0"?><feed><title>Example</title><id>feed-1</id><entry><id>job-1</id><title>One</title><link href="https://example.test/jobs/1" /></entry><entry><id>job-2</id><title>Two</title><link href="https://example.test/jobs/2" /></entry></feed>`,
        },
        { status: 304, etag: '"v1"', body: "" },
      ],
    });

    const first = await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider,
      budget: { maxItems: 1, maxPages: 1, maxWallClockMs: 10_000, maxSpendCents: 0 },
    });
    expect(first.outcome).toBe("budget_exhausted");
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.identityKey).toBe("job-1");
    expect(first.cursor).toBeTruthy();

    now += 100;
    const second = await app.readSource({ runId: run.id, sourceId: source.id, provider });
    expect(second.outcome).toBe("not_modified");
    expect(provider.requests[1]?.headers).toMatchObject({
      "if-none-match": '"v1"',
    });
    expect(provider.requests[1]?.cursor).toBeNull();
    expect(second.itemCount).toBe(0);
  });

  test("maps transient provider failures to bounded retries and explicit outcomes", async () => {
    const now = 3_000;
    const app = new RecruitingApplication(makeDb(), () => now);
    const { source, run } = makeRun(app);
    const provider = new DeterministicFeedProvider({
      "https://example.test/feed.xml": [
        { status: 503, body: "unavailable" },
        { status: 503, body: "still unavailable" },
        { status: 503, body: "still unavailable" },
      ],
    });

    const result = await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 10 },
    });
    expect(result.outcome satisfies SourceAttemptOutcome).toBe("transient_failure");
    expect(provider.requests).toHaveLength(2);
    expect(result.retryAt).toBe(3_010);
    expect(app.getSource(source.id)?.readiness).toBe("degraded");
  });

  test("preserves Candidate-disabled readiness and cancels without a provider call", async () => {
    const app = new RecruitingApplication(makeDb(), () => 4_000);
    const { source, run } = makeRun(app);
    const provider = new DeterministicFeedProvider({
      "https://example.test/feed.xml": { status: 200, body: "<rss />" },
    });
    const disabled = app.disableSource(source.id);
    expect(disabled.readiness).toBe("candidate_disabled");
    const attempt = await app.readSource({ runId: run.id, sourceId: source.id, provider });
    expect(attempt.outcome).toBe("cancelled");
    expect(provider.requests).toHaveLength(0);
  });

  test("stops paginated reads at the host page budget and keeps partial progress", async () => {
    const app = new RecruitingApplication(makeDb(), () => 5_000);
    const { source, run } = makeRun(app);
    const provider = new DeterministicFeedProvider({
      "https://example.test/feed.xml": [
        {
          status: 200,
          nextCursor: "page-2",
          body: `<rss><channel><title>Example</title><item><guid>job-1</guid><title>One</title></item></channel></rss>`,
        },
        {
          status: 200,
          nextCursor: "page-3",
          body: `<rss><channel><title>Example</title><item><guid>job-2</guid><title>Two</title></item></channel></rss>`,
        },
      ],
    });
    const result = await app.readSource({
      runId: run.id,
      sourceId: source.id,
      provider,
      budget: { maxPages: 2, maxItems: 10, maxWallClockMs: 10_000, maxSpendCents: 0 },
    });
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.itemCount).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(provider.requests.map((request) => request.cursor)).toEqual([null, "page-2"]);
  });
});
