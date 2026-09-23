import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  DeterministicWebSearchProvider,
  FirecrawlWebSearchProvider,
  normalizeFilters,
  normalizeQuery,
  RecruitingApplication,
  WEB_SEARCH_SOURCE_ID,
  type WebSearchProvider,
  type WebSearchProviderRequest,
  type WebSearchProviderResult,
} from ".";
import { ASHBY_SOURCE_ID } from "./ashby";

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

function fixture(sourceIds: string[] = [WEB_SEARCH_SOURCE_ID]) {
  const results = [
    {
      title: "Forward Deployed Engineer",
      url: "https://jobs.ashbyhq.com/acme/role#tracking",
      description: "Join the team building useful systems.",
      publishedAt: "2026-08-24T12:00:00Z",
    },
  ];
  const provider = new DeterministicWebSearchProvider({
    '"Forward Deployed Engineer"': results,
    'site:jobs.ashbyhq.com "Forward Deployed Engineer"': results,
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
    sourceIds,
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
    const result = await provider.search({ query: "job", limit: 10 });
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

    const result = await provider.search({ query: "recovered", limit: 10 });

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

    await expect(provider.search({ query: "bad", limit: 10 })).rejects.toMatchObject({
      category: "invalid_request",
      retryCount: 0,
    });
    expect(calls).toBe(1);
  });

  test("rejects malformed non-empty Firecrawl result arrays", async () => {
    const provider = new FirecrawlWebSearchProvider(
      () => "firecrawl-secret",
      async () =>
        new Response(JSON.stringify({ id: "safe-malformed", creditsUsed: 2, data: [{}] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(provider.search({ query: "job", limit: 10 })).rejects.toMatchObject({
      category: "provider_failure",
      requestId: "safe-malformed",
      creditsUsed: 2,
      retryCount: 0,
    });
  });

  test("retains safe retry provenance when Firecrawl returns malformed JSON", async () => {
    const responses = [
      new Response("outage", { status: 503 }),
      new Response("{not-json", {
        status: 200,
        headers: { "x-request-id": "safe-invalid-json" },
      }),
    ];
    const provider = new FirecrawlWebSearchProvider(
      () => "firecrawl-secret",
      async () => responses.shift() ?? new Response("unexpected", { status: 500 }),
    );

    await expect(provider.search({ query: "job", limit: 10 })).rejects.toMatchObject({
      category: "provider_failure",
      requestId: "safe-invalid-json",
      retryCount: 1,
      retryAt: expect.any(Number),
    });
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

    // site: stays in the query: Firecrawl caps includeDomains searches at 10.
    expect(provider.requests).toEqual([
      { query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"', limit: 10 },
    ]);
    expect(result.appliedDomainRestrictions).toEqual(["jobs.ashbyhq.com"]);
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
    await app.webSearch({ scoutId: scout.id, query: "Forward Deployed Engineer", limit: 100 });
    await expect(
      app.webSearch({ scoutId: scout.id, query: "Forward Deployed Engineer", limit: 0 }),
    ).rejects.toThrow(/between 1 and 100/i);
    await expect(
      app.webSearch({ scoutId: scout.id, query: "Forward Deployed Engineer", limit: 101 }),
    ).rejects.toThrow(/between 1 and 100/i);
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
      query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
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
      'site:jobs.ashbyhq.com "Forward Deployed Engineer" -intern filetype:pdf inurl:jobs allinurl:careers intitle:Engineer allintitle:Engineering related:ashbyhq.com before:2026 cache:jobs',
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
      'site:jobs.ashbyhq.com "Forward Deployed Engineer"': [
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

describe("WebSearch discovery filters", () => {
  const now = Date.parse("2026-09-22T18:00:00Z");

  test("sends limit, tbs, and location in the Firecrawl request body", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new FirecrawlWebSearchProvider(
      () => "key",
      async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ data: { web: [] } }), { status: 200 });
      },
    );
    await provider.search({
      query: 'site:jobs.ashbyhq.com "New Grad"',
      limit: 100,
      tbs: "sbd:1,qdr:w",
      location: "San Francisco,California,United States",
    });
    // Never includeDomains: Firecrawl caps those searches at 10 results.
    expect(body).toEqual({
      query: 'site:jobs.ashbyhq.com "New Grad"',
      limit: 100,
      tbs: "sbd:1,qdr:w",
      location: "San Francisco,California,United States",
    });

    await provider.search({ query: "job", limit: 10 });
    expect(body).toEqual({ query: "job", limit: 10 });
  });

  test("maps typed filters to tbs on the host clock", () => {
    expect(normalizeFilters({}, now)).toEqual({ tbs: null, location: null, compact: false });
    expect(normalizeFilters({ recency: "day" }, now).tbs).toBe("qdr:d");
    expect(normalizeFilters({ recency: "year", sortByDate: true }, now).tbs).toBe("sbd:1,qdr:y");
    expect(normalizeFilters({ publishedAfter: "2026-09-01T00:00:00.000Z" }, now).tbs).toBe(
      "cdr:1,cd_min:09/01/2026,cd_max:09/22/2026",
    );
    expect(normalizeFilters({ publishedAfter: "2026-09-15", sortByDate: true }, now).tbs).toBe(
      "sbd:1,cdr:1,cd_min:09/15/2026,cd_max:09/22/2026",
    );
    expect(
      normalizeFilters({ location: "  Kansas City,Missouri,United States ", compact: true }, now),
    ).toEqual({ tbs: null, location: "Kansas City,Missouri,United States", compact: true });
  });

  test("rejects malformed filters with a clear message", () => {
    const invalid = (request: Record<string, unknown>) =>
      expect(() => normalizeFilters(request as never, now));
    invalid({ recency: "hour" }).toThrow(/day, week, month, or year/);
    invalid({ recency: "week", publishedAfter: "2026-09-01" }).toThrow(/not both/);
    invalid({ publishedAfter: "last week" }).toThrow(/ISO date/);
    invalid({ publishedAfter: "2026-13-45" }).toThrow(/ISO date/);
    invalid({ publishedAfter: "2026-10-01" }).toThrow(/future/);
    invalid({ sortByDate: "yes" }).toThrow(/sortByDate/);
    invalid({ compact: 1 }).toThrow(/compact/);
    invalid({ location: "" }).toThrow(/location/);
    invalid({ location: "x".repeat(101) }).toThrow(/location/);
    invalid({ location: "qdr:w,sbd:1" }).toThrow(/location/);
  });

  test("records the filters on the Source Attempt and passes them to the provider", async () => {
    const { app, provider, scout, run } = fixture();
    const result = await app.webSearch({
      scoutId: scout.id,
      query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
      limit: 100,
      publishedAfter: "1970-01-01",
      sortByDate: true,
      location: "San Francisco,California,United States",
    });
    expect(provider.requests[0]).toEqual({
      query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
      limit: 100,
      tbs: "sbd:1,cdr:1,cd_min:01/01/1970,cd_max:01/01/1970",
      location: "San Francisco,California,United States",
    });
    expect(result.appliedFilters).toEqual({
      tbs: "sbd:1,cdr:1,cd_min:01/01/1970,cd_max:01/01/1970",
      location: "San Francisco,California,United States",
    });
    const scope = JSON.parse(app.getSourceAttempt(result.sourceAttemptId)?.requestedScope ?? "{}");
    expect(scope).toMatchObject({
      limit: 100,
      tbs: "sbd:1,cdr:1,cd_min:01/01/1970,cd_max:01/01/1970",
      location: "San Francisco,California,United States",
    });

    await expect(
      app.webSearch({ scoutId: scout.id, query: "query", recency: "hour" as never }),
    ).rejects.toThrow(/recency/);
    expect(
      app
        .listSourceAttempts(run.id)
        .map((attempt) => attempt.outcome)
        .sort(),
    ).toEqual(["rejected", "succeeded_with_items"]);
    expect(provider.requests).toHaveLength(1);
  });

  test("retries an empty date-filtered search once", async () => {
    const answers: WebSearchProviderResult[][] = [
      [],
      [{ title: "Role", url: "https://jobs.ashbyhq.com/acme/role", description: "Role" }],
    ];
    const requests: WebSearchProviderRequest[] = [];
    const provider: WebSearchProvider = {
      async search(request) {
        requests.push(request);
        const results = answers.shift() ?? [];
        return { requestId: null, creditsUsed: results.length === 0 ? 0 : 2, results };
      },
    };
    const app = new RecruitingApplication(makeDb(), () => 10_000, {
      provider,
      webSearchApiKey: () => "test-key",
    });
    const scout = app.createScout({
      name: "Retry Scout",
      harness: "claude",
      instructionPath: "agents/retry",
      defaultProfileId: confirmedProfile(app),
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "retry-scout",
    }).value;
    const run = app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "retry-run" }).value;

    const dated = await app.webSearch({ scoutId: scout.id, query: "role", recency: "week" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(dated.results).toHaveLength(1);
    expect(
      JSON.parse(app.getSourceAttempt(dated.sourceAttemptId)?.requestedScope ?? "{}"),
    ).toMatchObject({ emptyResultRetried: true, creditsUsed: 2 });

    // Still empty after the retry: an empty success, not a failure.
    const empty = await app.webSearch({ scoutId: scout.id, query: "role", recency: "week" });
    expect(requests).toHaveLength(4);
    expect(app.getSourceAttempt(empty.sourceAttemptId)).toMatchObject({
      outcome: "succeeded_empty",
    });

    // Without a date filter an empty answer is taken as is.
    await app.webSearch({ scoutId: scout.id, query: "role" });
    expect(requests).toHaveLength(5);
    expect(app.listSourceAttempts(run.id)).toHaveLength(3);
  });

  test("returns compact excerpts and the deduplicated job boards behind the results", async () => {
    const provider = new DeterministicWebSearchProvider({
      '"New Grad"': [
        {
          title: "New Grad Engineer",
          url: "https://jobs.ashbyhq.com/acme/0b6a3c1e-2f4d-4c8e-9a7b-1d2e3f4a5b6c",
          description: "x".repeat(900),
        },
        { title: "Acme board", url: "https://jobs.ashbyhq.com/acme", description: "Jobs" },
        {
          title: "Beta role",
          url: "https://job-boards.greenhouse.io/beta/jobs/12345",
          description: "Role",
        },
        { title: "Gamma role", url: "https://jobs.lever.co/gamma/abc-123", description: "Role" },
        {
          title: "Workday role",
          url: "https://delta.wd5.myworkdayjobs.com/en-US/careers/job/SF/Engineer_R1",
          description: "Role",
        },
        { title: "Blog", url: "https://example.com/post", description: "Not a board" },
      ],
    });
    const app = new RecruitingApplication(makeDb(), () => 10_000, {
      provider,
      webSearchApiKey: () => "test-key",
    });
    const scout = app.createScout({
      name: "Compact Scout",
      harness: "claude",
      instructionPath: "agents/compact",
      defaultProfileId: confirmedProfile(app),
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "compact-scout",
    }).value;
    app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "compact-run" });

    const result = await app.webSearch({ scoutId: scout.id, query: '"New Grad"', compact: true });
    expect(result.results[0]?.excerpt).toHaveLength(200);
    expect(result.jobBoards).toEqual([
      {
        source: "ashby",
        board: "acme",
        boardUrl: "https://jobs.ashbyhq.com/acme",
        resultCount: 2,
      },
      {
        source: "greenhouse",
        board: "beta",
        boardUrl: "https://job-boards.greenhouse.io/beta",
        resultCount: 1,
      },
      { source: "lever", board: "gamma", boardUrl: "https://jobs.lever.co/gamma", resultCount: 1 },
    ]);

    const full = await app.webSearch({ scoutId: scout.id, query: '"New Grad"' });
    expect(full.results[0]?.excerpt).toHaveLength(900);
  });
});

describe("WebSearch for job-board Scouts", () => {
  test("requires the Web Search Source even for site-restricted board searches", async () => {
    const { app, provider, scout } = fixture([ASHBY_SOURCE_ID]);
    await expect(
      app.webSearch({
        scoutId: scout.id,
        query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
      }),
    ).rejects.toThrow("Web Search is not enabled for this Scout");
    expect(provider.requests).toHaveLength(0);
  });

  test("allows board searches when the Web Search Source is selected alongside a board", async () => {
    const { app, provider, scout } = fixture([ASHBY_SOURCE_ID, WEB_SEARCH_SOURCE_ID]);
    const result = await app.webSearch({
      scoutId: scout.id,
      query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
      limit: 100,
      recency: "week",
      compact: true,
    });
    expect(result.jobBoards).toEqual([
      { source: "ashby", board: "acme", boardUrl: "https://jobs.ashbyhq.com/acme", resultCount: 1 },
    ]);
    expect(provider.requests).toHaveLength(1);
  });
});
