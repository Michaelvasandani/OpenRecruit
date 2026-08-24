import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  DeterministicWebSearchProvider,
  FirecrawlWebSearchProvider,
  normalizeQuery,
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

  test("records a recovered transient search retry without exposing provider details", async () => {
    const responses = [
      new Response("temporary outage", { status: 503 }),
      new Response(
        JSON.stringify({
          id: "safe-request-1",
          creditsUsed: 2,
          data: [{ title: "Recovered", url: "https://example.com/recovered" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ];
    let calls = 0;
    const provider = new FirecrawlWebSearchProvider(
      () => "firecrawl-secret",
      async () => {
        calls += 1;
        return responses.shift() ?? new Response("unexpected", { status: 500 });
      },
    );

    const result = await provider.search({ query: "recovered", limit: 10, includeDomains: [] });

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      requestId: "safe-request-1",
      creditsUsed: 2,
      retryCount: 1,
    });
    expect(result.retryAt).toEqual(expect.any(Number));
    expect(JSON.stringify(result)).not.toContain("firecrawl-secret");
  });

  test("does not retry deterministic search input failures", async () => {
    let calls = 0;
    const provider = new FirecrawlWebSearchProvider(
      () => "firecrawl-secret",
      async () => {
        calls += 1;
        return new Response("invalid input", { status: 422 });
      },
    );

    await expect(
      provider.search({ query: "bad", limit: 10, includeDomains: [] }),
    ).rejects.toMatchObject({
      category: "invalid_request",
      retryCount: 0,
    });
    expect(calls).toBe(1);
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
    expect(app.listSourceAttempts(run.id)[0]?.requestedScope).toContain(
      '"errorCategory":"not_configured"',
    );
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
    expect(attempt?.requestedScope).toContain('"retryDisposition":"not_retried"');
    expect(attempt?.requestedScope).toContain('"errorCategory":null');
    expect(attempt).toMatchObject({
      provider: "deterministic",
      retryDisposition: "not_retried",
      errorCategory: null,
      attemptCount: 1,
    });
    expect(app.listSignals({ runId: run.id })).toHaveLength(0);
    expect(app.listLeads()).toHaveLength(0);
  });

  test("distinguishes an empty search success from exhausted transient failure", async () => {
    const empty = new DeterministicWebSearchProvider({});
    const emptyApp = new RecruitingApplication(makeDb(), () => 10_000, {
      provider: empty,
      webSearchApiKey: () => "test-key",
    });
    const profileId = confirmedProfile(emptyApp);
    const emptyScout = emptyApp.createScout({
      name: "Empty Search Scout",
      harness: "codex",
      instructionPath: "agents/empty-search",
      defaultProfileId: profileId,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "empty-search-scout",
    }).value;
    const emptyRun = emptyApp.launchScoutRun({
      scoutId: emptyScout.id,
      idempotencyKey: "empty-search-run",
    }).value;
    const emptyResult = await emptyApp.webSearch({ scoutId: emptyScout.id, query: "nothing" });
    expect(emptyResult.results).toHaveLength(0);
    expect(emptyApp.getSourceAttempt(emptyResult.sourceAttemptId)).toMatchObject({
      outcome: "succeeded_empty",
      errorCategory: null,
      attemptCount: 1,
      runId: emptyRun.id,
    });

    const responses = [
      new Response("outage", { status: 503 }),
      new Response("outage", { status: 503 }),
    ];
    const transientApp = new RecruitingApplication(makeDb(), () => 10_000, {
      provider: new FirecrawlWebSearchProvider(
        () => "test-key",
        async () => responses.shift() ?? new Response("outage", { status: 503 }),
      ),
      webSearchApiKey: () => "test-key",
    });
    const transientProfileId = confirmedProfile(transientApp);
    const transientScout = transientApp.createScout({
      name: "Transient Search Scout",
      harness: "codex",
      instructionPath: "agents/transient-search",
      defaultProfileId: transientProfileId,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "transient-search-scout",
    }).value;
    const transientRun = transientApp.launchScoutRun({
      scoutId: transientScout.id,
      idempotencyKey: "transient-search-run",
    }).value;
    await expect(
      transientApp.webSearch({ scoutId: transientScout.id, query: "outage" }),
    ).rejects.toMatchObject({
      category: "exhausted_transient_failure",
    });
    expect(transientApp.listSourceAttempts(transientRun.id)[0]).toMatchObject({
      outcome: "transient_failure",
      errorCategory: "transient_failure",
      retryDisposition: "exhausted",
      attemptCount: 2,
    });
  });

  test("rejects a non-empty provider payload when every result is malformed", async () => {
    const app = new RecruitingApplication(makeDb(), () => 10_000, {
      provider: {
        async search() {
          return {
            requestId: "safe-malformed-response",
            creditsUsed: 2,
            results: [{ title: "Broken result", url: "not-a-public-url" }],
          };
        },
      },
      webSearchApiKey: () => "test-key",
    });
    const profileId = confirmedProfile(app);
    const scout = app.createScout({
      name: "Malformed Search Scout",
      harness: "codex",
      instructionPath: "agents/malformed-search",
      defaultProfileId: profileId,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "malformed-search-scout",
    }).value;
    const run = app.launchScoutRun({
      scoutId: scout.id,
      idempotencyKey: "malformed-search-run",
    }).value;

    await expect(app.webSearch({ scoutId: scout.id, query: "broken" })).rejects.toMatchObject({
      category: "provider_failure",
    });
    expect(app.listSourceAttempts(run.id)[0]).toMatchObject({
      outcome: "rejected",
      errorCategory: "provider_failure",
      retryDisposition: "not_retried",
      attemptCount: 1,
    });
  });

  test("records a transient retry followed by authentication failure as mixed", async () => {
    const responses = [
      new Response("outage", { status: 503 }),
      new Response("invalid key", { status: 401 }),
    ];
    const app = new RecruitingApplication(makeDb(), () => 10_000, {
      provider: new FirecrawlWebSearchProvider(
        () => "test-key",
        async () => responses.shift() ?? new Response("unexpected", { status: 500 }),
      ),
      webSearchApiKey: () => "test-key",
    });
    const profileId = confirmedProfile(app);
    const scout = app.createScout({
      name: "Mixed Failure Search Scout",
      harness: "codex",
      instructionPath: "agents/mixed-failure-search",
      defaultProfileId: profileId,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "mixed-failure-search-scout",
    }).value;
    const run = app.launchScoutRun({
      scoutId: scout.id,
      idempotencyKey: "mixed-failure-search-run",
    }).value;

    await expect(app.webSearch({ scoutId: scout.id, query: "query" })).rejects.toMatchObject({
      category: "invalid_authentication",
    });
    expect(app.listSourceAttempts(run.id)[0]).toMatchObject({
      outcome: "rejected",
      errorCategory: "authentication",
      retryDisposition: "mixed",
      attemptCount: 2,
    });
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

  test("preserves a quoted phrase that contains site-like text", () => {
    const normalized = normalizeQuery('"site:jobs.ashbyhq.com" "Forward Deployed Engineer"');

    expect(normalized.providerQuery).toBe('"site:jobs.ashbyhq.com" "Forward Deployed Engineer"');
    expect(normalized.includeDomains).toEqual([]);
  });

  test("does not rewrite whitespace inside a balanced quoted phrase", () => {
    const query = 'Find roles near "Forward   Deployed Engineer" in New York';
    const normalized = normalizeQuery(query);

    expect(normalized.providerQuery).toBe(query);
  });

  test("rejects a site operator without a hostname", () => {
    expect(() => normalizeQuery('site: "Forward Deployed Engineer"')).toThrow(
      /site: restrictions must be hostnames/i,
    );
  });

  test("rejects site values that contain a scheme or path", () => {
    expect(() => normalizeQuery("site:https://jobs.ashbyhq.com Engineer")).toThrow(
      /site: restrictions must be hostnames/i,
    );
    expect(() => normalizeQuery("site:jobs.ashbyhq.com/careers Engineer")).toThrow(
      /site: restrictions must be hostnames/i,
    );
  });

  test("leaves excluded site syntax in the provider query", () => {
    const normalized = normalizeQuery("-site:jobs.ashbyhq.com Engineer");

    expect(normalized.providerQuery).toBe("-site:jobs.ashbyhq.com Engineer");
    expect(normalized.includeDomains).toEqual([]);
  });

  test("preserves unsupported operator syntax and reports only its operator names", () => {
    const normalized = normalizeQuery(
      'site:jobs.ashbyhq.com "Forward Deployed Engineer" -intern filetype:pdf inurl:jobs allinurl:careers intitle:Engineer allintitle:Engineering related:ashbyhq.com before:2026 cache:jobs',
    );

    expect(normalized.providerQuery).toBe(
      '"Forward Deployed Engineer" -intern filetype:pdf inurl:jobs allinurl:careers intitle:Engineer allintitle:Engineering related:ashbyhq.com before:2026 cache:jobs',
    );
    expect(normalized.unsupportedOperators).toEqual(["before", "cache"]);
  });

  test("warns for unsupported operators attached to punctuation", () => {
    const normalized = normalizeQuery("Engineer,before:2026");

    expect(normalized.providerQuery).toBe("Engineer,before:2026");
    expect(normalized.unsupportedOperators).toEqual(["before"]);
  });

  test("filters provider results that violate a structured site restriction", async () => {
    const provider = new DeterministicWebSearchProvider({
      '"Forward Deployed Engineer"': [
        {
          title: "Ashby role",
          url: "https://jobs.ashbyhq.com/acme/role",
          description: "Allowed",
        },
        {
          title: "Unrelated role",
          url: "https://example.com/jobs/role",
          description: "Must not escape site restriction",
        },
        {
          title: "Lookalike role",
          url: "https://jobs.ashbyhq.com.evil.example/jobs/role",
          description: "Must not match a domain suffix",
        },
      ],
    });
    const app = new RecruitingApplication(makeDb(), () => 10_000, {
      provider,
      webSearchApiKey: () => "test-key",
    });
    const profileId = confirmedProfile(app);
    const scout = app.createScout({
      name: "Restricted Search Scout",
      harness: "codex",
      instructionPath: "agents/restricted-search",
      defaultProfileId: profileId,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "restricted-search-scout",
    }).value;
    app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "restricted-search-run" });

    const result = await app.webSearch({
      scoutId: scout.id,
      query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
      limit: 10,
    });

    expect(result.results.map((item) => item.canonicalUrl)).toEqual([
      "https://jobs.ashbyhq.com/acme/role",
    ]);
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
