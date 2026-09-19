import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  DeterministicHackerNewsProvider,
  HACKER_NEWS_SOURCE_ID,
  type HackerNewsProviderResponse,
  RecruitingApplication,
  WEB_SEARCH_SOURCE_ID,
} from ".";
import { htmlToText, normalizeHackerNewsRequest } from "./hacker-news";
import type { PostingFitInput, PostingFitJudge, PostingFitJudgment } from "./posting-fit";

const BASE = "https://hn.algolia.com/api/v1/search_by_date";
const THREADS_URL = `${BASE}?tags=story,author_whoishiring&hitsPerPage=10`;
const commentsUrl = (query: string, page = 0) =>
  `${BASE}?${new URLSearchParams({
    tags: "comment,story_4100",
    query,
    hitsPerPage: "100",
    page: String(page),
  })}`;
const jobsUrl = (query: string, limit: number) =>
  `${BASE}?${new URLSearchParams({ tags: "job", query, hitsPerPage: String(limit), page: "0" })}`;

const THREADS: HackerNewsProviderResponse = {
  status: 200,
  json: {
    hits: [
      { objectID: "4200", title: "Ask HN: Who wants to be hired? (September 2026)" },
      { objectID: "4100", title: "Ask HN: Who is hiring? (September 2026)", created_at_i: 1_000 },
      { objectID: "3900", title: "Ask HN: Who is hiring? (August 2026)", created_at_i: 900 },
    ],
  },
};

const COMMENTS: HackerNewsProviderResponse = {
  status: 200,
  json: {
    hits: [
      {
        objectID: "4101",
        parent_id: 4100,
        author: "founder",
        created_at_i: 1_100,
        comment_text:
          "Acme Robotics | Rust Engineer | Remote (US) | $150k&#x2F;yr<p>We build arms &amp; grippers. " +
          'Apply: <a href="https://acme.example/jobs" rel="nofollow">https://acme.example/j...</a>',
      },
      { objectID: "4102", parent_id: 4101, author: "reply", comment_text: "Is this still open?" },
      { objectID: "4103", parent_id: 4100, author: "other", comment_text: "Beta | Designer" },
    ],
  },
};

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

function fakeJudge(answer: (input: PostingFitInput) => PostingFitJudgment | null) {
  const inputs: PostingFitInput[] = [];
  const judge: PostingFitJudge = {
    isConfigured: () => true,
    judge: async (input) => {
      inputs.push(input);
      return answer(input);
    },
  };
  return Object.assign(judge, { inputs });
}

function judgment(worthKeepingProbability: number, scoutFitProbability = 0.9): PostingFitJudgment {
  return {
    model: "jev-test",
    requiredExperience: {
      level: "not_stated",
      minimumYears: null,
      confidence: 0.9,
      probabilities: { not_stated: 0.9 },
    },
    scoutFitProbability,
    worthKeepingProbability,
  };
}

function fixture(
  fixtures: Record<string, HackerNewsProviderResponse>,
  sourceIds: string[] = [HACKER_NEWS_SOURCE_ID],
  postingFitJudge?: PostingFitJudge,
) {
  const provider = new DeterministicHackerNewsProvider(fixtures);
  const app = new RecruitingApplication(makeDb(), () => 10_000, {
    hackerNewsProvider: provider,
    postingFitJudge,
  });
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Built useful systems.",
    careerInterests: "Robotics",
    idempotencyKey: "hn-profile-import",
  });
  const profile = app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: "hn-profile-confirm",
  });
  const scout = app.createScout({
    name: "HN Scout",
    harness: "claude",
    instructionPath: "agents/hn",
    defaultProfileId: profile.id,
    sourceIds,
    strategyMaterial: "# Discovery Strategy\nTarget roles: Rust robotics engineer.",
    policyMaterial: "# Scout Policy\nRemote roles only.",
    idempotencyKey: "hn-scout",
  }).value;
  const run = app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "hn-run" }).value;
  return { app, provider, scout, run };
}

describe("HackerNewsJobs", () => {
  test("reads top-level postings from the latest Who is hiring thread", async () => {
    const { app, provider, scout, run } = fixture({
      [THREADS_URL]: THREADS,
      [commentsUrl("rust")]: COMMENTS,
    });

    const result = await app.hackerNewsJobs({ scoutId: scout.id, query: "  rust " });

    expect(provider.requests).toEqual([THREADS_URL, commentsUrl("rust")]);
    expect(result.thread).toEqual({
      id: "4100",
      title: "Ask HN: Who is hiring? (September 2026)",
      canonicalUrl: "https://news.ycombinator.com/item?id=4100",
      publishedAt: 1_000_000,
    });
    expect(result.results.map((posting) => posting.id)).toEqual(["4101", "4103"]);
    expect(result.results[0]).toEqual({
      id: "4101",
      kind: "hiring_comment",
      canonicalUrl: "https://news.ycombinator.com/item?id=4101",
      externalUrl: null,
      title: "Acme Robotics | Rust Engineer | Remote (US) | $150k/yr",
      content:
        "Acme Robotics | Rust Engineer | Remote (US) | $150k/yr\n\n" +
        "We build arms & grippers. Apply: https://acme.example/jobs",
      author: "founder",
      publishedAt: 1_100_000,
      fitJudgment: null,
      screening: null,
    });
    expect(result.screened).toBe(false);
    expect(result.provenance).toEqual({
      provider: "hn-algolia",
      sourceId: HACKER_NEWS_SOURCE_ID,
      runId: run.id,
      scoutId: scout.id,
    });
    const attempt = app.getSourceAttempt(result.sourceAttemptId);
    expect(attempt?.outcome).toBe("succeeded_with_items");
    expect(attempt?.itemCount).toBe(2);
  });

  test("reads YC job stories and honours the limit", async () => {
    const { app, scout } = fixture({
      [jobsUrl("", 1)]: {
        status: 200,
        json: {
          hits: [
            {
              objectID: "5001",
              title: "Gamma (YC W26) is hiring a founding engineer",
              url: "https://gamma.example/careers",
              author: "gamma",
              created_at_i: 2_000,
            },
            { objectID: "5002", title: "Second posting" },
          ],
        },
      },
    });

    const result = await app.hackerNewsJobs({ scoutId: scout.id, mode: "job_stories", limit: 1 });

    expect(result.thread).toBeNull();
    expect(result.results).toEqual([
      {
        id: "5001",
        kind: "job_story",
        canonicalUrl: "https://news.ycombinator.com/item?id=5001",
        externalUrl: "https://gamma.example/careers",
        title: "Gamma (YC W26) is hiring a founding engineer",
        content: "Gamma (YC W26) is hiring a founding engineer\n\nhttps://gamma.example/careers",
        author: "gamma",
        publishedAt: 2_000_000,
        fitJudgment: null,
        screening: null,
      },
    ]);
  });

  test("promotes only postings returned by the Attempt into Signals", async () => {
    const { app, scout } = fixture({ [THREADS_URL]: THREADS, [commentsUrl("")]: COMMENTS });
    const result = await app.hackerNewsJobs({ scoutId: scout.id });

    expect(() =>
      app.recordSourceOutcomeForScout({
        scoutId: scout.id,
        sourceAttemptId: result.sourceAttemptId,
        items: [{ canonicalUrl: "https://news.ycombinator.com/item?id=9999" }],
      }),
    ).toThrow("was not returned by this HackerNewsJobs Attempt");

    const recorded = app.recordSourceOutcomeForScout({
      scoutId: scout.id,
      sourceAttemptId: result.sourceAttemptId,
      items: [{ canonicalUrl: "https://news.ycombinator.com/item?id=4101" }],
    });
    expect(recorded.signalIds).toHaveLength(1);
    expect(recorded.leadIds).toHaveLength(1);
  });

  test("Jev screens postings against the Profile, Discovery Strategy, and Scout Policy", async () => {
    const judge = fakeJudge((input) => judgment(input.title.startsWith("Acme") ? 0.92 : 0.1));
    const { app, scout } = fixture(
      { [THREADS_URL]: THREADS, [commentsUrl("")]: COMMENTS },
      undefined,
      judge,
    );

    const result = await app.hackerNewsJobs({ scoutId: scout.id });

    expect(judge.inputs[0]).toEqual({
      title: "Acme Robotics | Rust Engineer | Remote (US) | $150k/yr",
      organization: null,
      department: null,
      team: null,
      employmentType: null,
      location: null,
      descriptionPlain: expect.stringContaining("We build arms & grippers."),
      scoutBrief: expect.stringContaining("Rust robotics engineer"),
      scoutPolicy: expect.stringContaining("Remote roles only"),
      candidateProfile: expect.stringContaining("Target role: Engineer"),
    });
    expect(result.screened).toBe(true);
    expect(result.summary).toEqual({ includeCount: 1, reviewCount: 0, excludeCount: 1 });
    expect(result.results[0]).toMatchObject({
      id: "4101",
      fitJudgment: { worthKeepingProbability: 0.92 },
      screening: {
        decision: "include",
        reasons: [
          { rule: "scout_fit", outcome: "pass", code: "judged_within_scout_brief" },
          { rule: "worth_keeping", outcome: "pass", code: "judged_worth_keeping" },
        ],
      },
    });
    expect(result.results[1]).toMatchObject({
      id: "4103",
      screening: {
        decision: "exclude",
        reasons: expect.arrayContaining([
          { rule: "worth_keeping", outcome: "fail", code: "judged_not_worth_keeping" },
        ]),
      },
    });
  });

  test("a posting Jev judged not worth keeping cannot become a Signal", async () => {
    const judge = fakeJudge((input) => judgment(input.title.startsWith("Acme") ? 0.92 : 0.1));
    const { app, scout } = fixture(
      { [THREADS_URL]: THREADS, [commentsUrl("")]: COMMENTS },
      undefined,
      judge,
    );
    const result = await app.hackerNewsJobs({ scoutId: scout.id });

    expect(() =>
      app.recordSourceOutcomeForScout({
        scoutId: scout.id,
        sourceAttemptId: result.sourceAttemptId,
        items: [{ canonicalUrl: "https://news.ycombinator.com/item?id=4103" }],
      }),
    ).toThrow("not worth keeping");

    const recorded = app.recordSourceOutcomeForScout({
      scoutId: scout.id,
      sourceAttemptId: result.sourceAttemptId,
      items: [{ canonicalUrl: "https://news.ycombinator.com/item?id=4101" }],
    });
    const signal = app.getSignal(recorded.signalIds[0] as string);
    expect(signal?.evidence.fitJudgment).toMatchObject({ worthKeepingProbability: 0.92 });
  });

  test("an uncertain or failed judgment leaves the posting for review, still promotable", async () => {
    const judge = fakeJudge((input) => (input.title.startsWith("Acme") ? judgment(0.45) : null));
    const { app, scout } = fixture(
      { [THREADS_URL]: THREADS, [commentsUrl("")]: COMMENTS },
      undefined,
      judge,
    );

    const result = await app.hackerNewsJobs({ scoutId: scout.id });

    expect(result.results.map((posting) => posting.screening?.decision)).toEqual([
      "review",
      "review",
    ]);
    expect(result.results[1]?.screening?.reasons).toEqual([
      { rule: "scout_fit", outcome: "review", code: "fit_judgment_unavailable" },
      { rule: "worth_keeping", outcome: "review", code: "worth_judgment_unavailable" },
    ]);
    expect(
      app.recordSourceOutcomeForScout({
        scoutId: scout.id,
        sourceAttemptId: result.sourceAttemptId,
        items: [{ canonicalUrl: "https://news.ycombinator.com/item?id=4103" }],
      }).signalIds,
    ).toHaveLength(1);
  });

  test("rejects a Scout that has not selected the Hacker News Source", async () => {
    const { app, provider, scout } = fixture({}, [WEB_SEARCH_SOURCE_ID]);

    await expect(app.hackerNewsJobs({ scoutId: scout.id })).rejects.toMatchObject({
      code: "CONFLICT",
      category: "disabled_source_access",
    });
    expect(provider.requests).toEqual([]);
  });

  test("records invalid input and rate limits as safe Attempt outcomes", async () => {
    const { app, scout, run } = fixture({ [THREADS_URL]: { status: 429, json: null } });

    await expect(app.hackerNewsJobs({ scoutId: scout.id, limit: 500 })).rejects.toMatchObject({
      code: "VALIDATION",
      category: "invalid_input",
    });
    await expect(app.hackerNewsJobs({ scoutId: scout.id })).rejects.toMatchObject({
      code: "CONFLICT",
      category: "rate_limited",
    });
    const outcomes = app
      .listSourceAttempts(run.id)
      .map((attempt) => [attempt.outcome, attempt.retryAt]);
    expect(outcomes).toContainEqual(["rejected", null]);
    expect(outcomes).toContainEqual(["rate_limited", 70_000]);
  });

  test("returns an empty result when no hiring thread exists", async () => {
    const { app, scout } = fixture({ [THREADS_URL]: { status: 200, json: { hits: [] } } });

    const result = await app.hackerNewsJobs({ scoutId: scout.id });

    expect(result.thread).toBeNull();
    expect(result.results).toEqual([]);
    expect(app.getSourceAttempt(result.sourceAttemptId)?.outcome).toBe("succeeded_empty");
  });

  test("the canonical Source cannot be duplicated", () => {
    const { app } = fixture({});
    expect(() =>
      app.createSource({ kind: "hacker_news", name: "Another HN", idempotencyKey: "hn-dup" }),
    ).toThrow("canonical Source");
  });
});

describe("Hacker News request and content normalization", () => {
  test("applies defaults and bounds", () => {
    expect(normalizeHackerNewsRequest({})).toEqual({
      mode: "who_is_hiring",
      query: "",
      limit: 20,
      page: 0,
    });
    expect(() => normalizeHackerNewsRequest({ mode: "front_page" as never })).toThrow("mode");
    expect(() => normalizeHackerNewsRequest({ query: "x".repeat(201) })).toThrow("200");
    expect(() => normalizeHackerNewsRequest({ page: 21 })).toThrow("page");
  });

  test("converts HN comment HTML to bounded text", () => {
    expect(htmlToText("A &lt;b&gt; &#38; <i>C</i><p>D<br>E&#x27;s", 100)).toBe(
      "A <b> & C\n\nD\nE's",
    );
    expect(htmlToText("abcdef", 3)).toBe("abc");
    expect(htmlToText(null, 10)).toBe("");
  });
});
