import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  DeterministicWebSearchProvider,
  FirecrawlWebSearchProvider,
  RecruitingApplication,
  WEB_SEARCH_SOURCE_ID,
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

function confirmedProfile(app: RecruitingApplication): string {
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Built useful systems.",
    careerInterests: "Developer tools",
    idempotencyKey: "web-profile-import",
  });
  return app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: "web-profile-confirm",
  }).id;
}

function fixture() {
  const provider = new DeterministicWebSearchProvider({
    '"Forward Deployed Engineer"': [
      {
        title: "Forward Deployed Engineer",
        url: "https://jobs.ashbyhq.com/acme/role#tracking",
        description: "Join the team building useful systems.",
        publishedAt: "2026-08-24T12:00:00Z",
      },
    ],
  });
  const app = new RecruitingApplication(makeDb(), () => 10_000, {
    provider,
    webSearchApiKey: () => "test-key",
  });
  const profileId = confirmedProfile(app);
  const scout = app.createScout({
    name: "Search Scout",
    harness: "codex",
    instructionPath: "agents/search",
    defaultProfileId: profileId,
    sourceIds: [WEB_SEARCH_SOURCE_ID],
    idempotencyKey: "web-scout",
  });
  const run = app.launchScoutRun({ scoutId: scout.value.id, idempotencyKey: "web-run" });
  return { app, provider, scout: scout.value, run: run.value };
}

describe("host-owned WebSearch", () => {
  test("keeps Firecrawl authentication at the provider boundary", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const provider = new FirecrawlWebSearchProvider(
      () => "firecrawl-secret",
      async (url, init) => {
        captured = { url, init };
        return new Response(
          JSON.stringify({
            id: "fc-request-1",
            creditsUsed: 2,
            data: [
              {
                title: "A job",
                url: "https://example.com/job#fragment",
                description: "A bounded description",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const result = await provider.search({ query: "job", limit: 10, includeDomains: [] });
    expect(captured?.url).toBe("https://api.firecrawl.dev/v2/search");
    expect(captured?.init.headers).toMatchObject({ authorization: "Bearer firecrawl-secret" });
    expect(result).toMatchObject({ requestId: "fc-request-1", creditsUsed: 2 });
    expect(JSON.stringify(result)).not.toContain("firecrawl-secret");
  });

  test("requires a configured production key and records the safe rejection", async () => {
    const app = new RecruitingApplication(makeDb());
    const profileId = confirmedProfile(app);
    const scout = app.createScout({
      name: "Production Search Scout",
      harness: "claude",
      instructionPath: "agents/production-search",
      defaultProfileId: profileId,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "production-search-scout",
    }).value;
    const run = app.launchScoutRun({
      scoutId: scout.id,
      idempotencyKey: "production-search-run",
    }).value;

    await expect(app.webSearch({ scoutId: scout.id, query: "query" })).rejects.toThrow(
      /not configured/i,
    );
    expect(app.listSourceAttempts(run.id)).toMatchObject([
      expect.objectContaining({
        sourceId: WEB_SEARCH_SOURCE_ID,
        outcome: "rejected",
        safeFailure: "Web Search Source is not configured",
      }),
    ]);
  });

  test("returns bounded normalized evidence and records a safe Source Attempt", async () => {
    const { app, provider, scout, run } = fixture();
    const result = await app.webSearch({
      scoutId: scout.id,
      query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
      limit: 10,
    });

    expect(provider.requests).toEqual([
      {
        query: '"Forward Deployed Engineer"',
        limit: 10,
        includeDomains: ["jobs.ashbyhq.com"],
      },
    ]);
    expect(result.query).toBe('site:jobs.ashbyhq.com "Forward Deployed Engineer"');
    expect(result.results).toEqual([
      expect.objectContaining({
        title: "Forward Deployed Engineer",
        canonicalUrl: "https://jobs.ashbyhq.com/acme/role",
        excerpt: "Join the team building useful systems.",
        publishedAt: Date.parse("2026-08-24T12:00:00Z"),
        retrievedAt: 10_000,
      }),
    ]);
    expect(result.sourceAttemptId).toBeTruthy();
    expect(result.provenance.provider).toBe("deterministic");
    expect(result.results[0]?.excerpt.length).toBeLessThanOrEqual(1_000);

    const attempt = app.getSourceAttempt(result.sourceAttemptId);
    expect(attempt).toMatchObject({
      runId: run.id,
      sourceId: WEB_SEARCH_SOURCE_ID,
      outcome: "succeeded_with_items",
      itemCount: 1,
      completedAt: 10_000,
    });
    expect(attempt?.requestedScope).toContain('"provider":"deterministic"');
    expect(app.listSignals({ runId: run.id })).toHaveLength(0);
    expect(app.listLeads()).toHaveLength(0);
  });

  test("defaults and rejects result limits instead of clamping", async () => {
    const { app, scout, run } = fixture();
    await app.webSearch({ scoutId: scout.id, query: "Forward Deployed Engineer" });
    await expect(
      app.webSearch({ scoutId: scout.id, query: "Forward Deployed Engineer", limit: 0 }),
    ).rejects.toThrow(/between 1 and 25/i);
    await expect(
      app.webSearch({ scoutId: scout.id, query: "Forward Deployed Engineer", limit: 26 }),
    ).rejects.toThrow(/between 1 and 25/i);
    expect(app.listSourceAttempts(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: run.id, outcome: "rejected", itemCount: 0 }),
      ]),
    );
  });

  test("preserves the Candidate-authored query while normalizing provider input", async () => {
    const { app, provider, scout } = fixture();
    const query = '  site:jobs.ashbyhq.com "Forward Deployed Engineer"  ';
    const result = await app.webSearch({ scoutId: scout.id, query });

    expect(result.query).toBe(query);
    expect(provider.requests[0]).toMatchObject({
      query: '"Forward Deployed Engineer"',
      includeDomains: ["jobs.ashbyhq.com"],
    });
  });

  test("rejects a disabled Scout before calling the provider", async () => {
    const { app, provider, scout } = fixture();
    app.disableSource(WEB_SEARCH_SOURCE_ID);
    await expect(
      app.webSearch({ scoutId: scout.id, query: "Forward Deployed Engineer" }),
    ).rejects.toThrow(/disabled|not enabled|selected|Source/i);
    expect(provider.requests).toHaveLength(0);
  });

  test("exposes the same operation for Claude and Codex Scouts", async () => {
    const provider = new DeterministicWebSearchProvider({
      query: [{ title: "Result", url: "https://example.com", description: "Evidence" }],
    });
    const app = new RecruitingApplication(makeDb(), () => 10_000, {
      provider,
      webSearchApiKey: () => "test-key",
    });
    const profileId = confirmedProfile(app);
    const scouts = ["claude", "codex"].map(
      (harness, index) =>
        app.createScout({
          name: `${harness} Scout`,
          harness: harness as "claude" | "codex",
          instructionPath: `agents/${harness}`,
          defaultProfileId: profileId,
          sourceIds: [WEB_SEARCH_SOURCE_ID],
          idempotencyKey: `scout-${index}`,
        }).value,
    );
    const results = await Promise.all(
      scouts.map(async (scout, index) => {
        const run = app.launchScoutRun({ scoutId: scout.id, idempotencyKey: `run-${index}` });
        return app
          .webSearch({ scoutId: scout.id, query: "query" })
          .then((result) => ({ result, run }));
      }),
    );
    expect(results.map(({ result }) => result.results[0]?.canonicalUrl)).toEqual([
      "https://example.com/",
      "https://example.com/",
    ]);
    expect(
      results.map(({ result }) => app.getSourceAttempt(result.sourceAttemptId)?.runId),
    ).toEqual(results.map(({ run }) => run.value.id));
  });
});
