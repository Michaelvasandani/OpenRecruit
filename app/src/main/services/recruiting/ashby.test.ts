import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { RecruitingApplication } from ".";
import { HttpAshbyBoardProvider } from "./ashby";
import type { PostingFitInput, PostingFitJudge, PostingFitJudgment } from "./posting-fit";

const JOB_ID = "eeeb9757-78e0-4776-889e-507a013e1fcf";
const SECOND_JOB_ID = "7d6ae2be-cd53-466c-8151-2dae2e87aace";

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

function ashbyFixture(
  provider: { fetchBoard(request: { boardHandle: string }): Promise<unknown> },
  now: () => number = () => 10_000,
  policyMaterial?: string,
  postingFitJudge?: PostingFitJudge,
  scoutOverrides: { strategyMaterial?: string } = {},
) {
  const db = makeDb();
  const app = new RecruitingApplication(db, now, {
    ashbyProvider: provider,
    postingFitJudge,
  } as never);
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Built useful systems.",
    careerInterests: "AI engineering",
    idempotencyKey: `ashby-profile-import-${crypto.randomUUID()}`,
  });
  const profile = app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: `ashby-profile-confirm-${crypto.randomUUID()}`,
  });
  const scout = app.createScout({
    name: "Ashby Scout",
    harness: "codex",
    instructionPath: "agents/ashby",
    defaultProfileId: profile.id,
    sourceIds: ["source-ashby"],
    ...(policyMaterial === undefined ? {} : { policyMaterial }),
    ...scoutOverrides,
    idempotencyKey: `ashby-scout-${crypto.randomUUID()}`,
  }).value;
  const run = app.launchScoutRun({
    scoutId: scout.id,
    idempotencyKey: `ashby-run-${crypto.randomUUID()}`,
  }).value;
  return { app, db, scout, run };
}

function ashbyJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    title: "Forward Deployed Engineer (New Grad)",
    location: "San Francisco, CA",
    address: null,
    secondaryLocations: [],
    department: null,
    team: "Agents",
    employmentType: "FullTime",
    workplaceType: "OnSite",
    isRemote: false,
    publishedAt: "2026-09-16T00:15:28.633Z",
    isListed: true,
    jobUrl: `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`,
    applyUrl: `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}/application`,
    descriptionPlain:
      "Qualifications\n0-2 years of software engineering experience. Bonus: 4+ years using TypeScript.",
    descriptionHtml: "<p>Qualifications</p>",
    ...overrides,
  };
}

function fitJudgment(
  level: PostingFitJudgment["requiredExperience"]["level"],
  minimumYears: number | null,
  confidence = 0.9,
): PostingFitJudgment {
  return {
    model: "jev-test",
    requiredExperience: { level, minimumYears, confidence, probabilities: { [level]: confidence } },
    // The default fixture Scout has no Discovery Strategy, so no fit is judged.
    scoutFitProbability: null,
    worthKeepingProbability: null,
  };
}

function fakeJudge(
  answer: (input: PostingFitInput) => PostingFitJudgment | null,
): PostingFitJudge & { inputs: PostingFitInput[] } {
  const inputs: PostingFitInput[] = [];
  return {
    inputs,
    isConfigured: () => true,
    async judge(input) {
      inputs.push(input);
      return answer(input);
    },
  };
}

// The real posting text that the pattern matcher excluded on 2026-09-18.
const SABBATICAL_DESCRIPTION =
  "Build clinical AI products.\nBenefits\n - Sabbatical Leave: Paid Sabbatical Leave after 5 years of employment.";

describe("Ashby posting fit judgments", () => {
  const board = (jobs: unknown[]) => ({
    async fetchBoard() {
      return { status: 200, body: { jobs } };
    },
  });
  const url = `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`;

  test("pattern matching alone excludes a junior role over a sabbatical perk", async () => {
    const { app, scout } = ashbyFixture(
      board([
        ashbyJob({ title: "Junior Software Engineer", descriptionPlain: SABBATICAL_DESCRIPTION }),
      ]),
    );

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [url],
      policy: { maximumExplicitRequiredYears: 2 },
    });

    expect(result.results[0]).toMatchObject({ fitJudgment: null, policy: { decision: "exclude" } });
  });

  test("a Jev judgment overrides the misread perk and is kept with the evidence", async () => {
    const judge = fakeJudge(() => fitJudgment("entry_level", 0));
    const { app, scout } = ashbyFixture(
      board([
        ashbyJob({ title: "Junior Software Engineer", descriptionPlain: SABBATICAL_DESCRIPTION }),
      ]),
      undefined,
      undefined,
      judge,
    );

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [url],
      policy: { maximumExplicitRequiredYears: 2 },
    });

    expect(judge.inputs).toEqual([
      {
        title: "Junior Software Engineer",
        organization: null,
        department: null,
        team: "Agents",
        employmentType: "FullTime",
        location: "San Francisco, CA",
        descriptionPlain: SABBATICAL_DESCRIPTION,
        scoutBrief: null,
        scoutPolicy: null,
        // Every Run pins a Candidate Profile, so Jev always sees who it screens for.
        candidateProfile: expect.stringContaining("Target role:"),
      },
    ]);
    expect(result.results[0]).toMatchObject({
      fitJudgment: {
        requiredExperience: { level: "entry_level" },
        scoutFitProbability: null,
      },
      policy: {
        decision: "include",
        reasons: [
          {
            rule: "maximum_explicit_required_years",
            outcome: "pass",
            code: "judged_minimum_within_limit",
          },
        ],
      },
    });
  });

  test("keeps the Jev judgment with the recorded Signal", async () => {
    const { app, scout, run } = ashbyFixture(
      board([ashbyJob({ descriptionPlain: SABBATICAL_DESCRIPTION })]),
      undefined,
      undefined,
      fakeJudge(() => fitJudgment("entry_level", 0)),
    );
    const inspected = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [url],
      policy: { maximumExplicitRequiredYears: 2 },
    });

    app.recordSignalForScout({
      scoutId: scout.id,
      evidenceReference: inspected.results[0].evidenceReference,
    });

    expect(app.listSignals({ runId: run.id })[0].evidence.fitJudgment).toEqual(
      fitJudgment("entry_level", 0),
    );
  });

  test("treats a posting with no stated experience as early career", async () => {
    const { app, scout } = ashbyFixture(
      board([ashbyJob({ title: "Software Engineer", descriptionPlain: "Build agents with us." })]),
      undefined,
      undefined,
      fakeJudge(() => fitJudgment("not_stated", null)),
    );

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [url],
      policy: { maximumExplicitRequiredYears: 2 },
    });

    expect(result.results[0].policy).toEqual({
      decision: "include",
      reasons: [
        {
          rule: "maximum_explicit_required_years",
          outcome: "pass",
          code: "judged_experience_not_stated",
        },
      ],
    });
  });

  test("excludes a judged senior role and sends uncertain judgments to review", async () => {
    const senior = ashbyFixture(
      board([ashbyJob({ descriptionPlain: "Lead our platform." })]),
      undefined,
      undefined,
      fakeJudge(() => fitJudgment("five_plus_years", 5)),
    );
    const uncertain = ashbyFixture(
      board([ashbyJob({ descriptionPlain: "Lead our platform." })]),
      undefined,
      undefined,
      fakeJudge(() => fitJudgment("five_plus_years", 5, 0.4)),
    );
    const policy = { maximumExplicitRequiredYears: 2 };

    const excluded = await senior.app.ashbyInspect({
      scoutId: senior.scout.id,
      urls: [url],
      policy,
    });
    const review = await uncertain.app.ashbyInspect({
      scoutId: uncertain.scout.id,
      urls: [url],
      policy,
    });

    expect(excluded.results[0].policy).toMatchObject({
      decision: "exclude",
      reasons: [{ code: "judged_minimum_exceeds_limit" }],
    });
    expect(review.results[0].policy).toMatchObject({
      decision: "review",
      reasons: [{ code: "judged_experience_uncertain" }],
    });
  });

  test("judges every posting against the Scout's own brief, whatever its field", async () => {
    // A marketing Scout: the same rule, no marketing-specific code.
    const fits: Record<string, number> = {
      "Growth Marketing Manager": 0.96,
      "Software Engineer, Compute Foundations": 0.02,
      "Marketing Operations Analyst": 0.45,
    };
    const ids = [JOB_ID, SECOND_JOB_ID, "3b1f0c52-6f0e-4d0c-9d57-0a2f6c1d9e11"];
    const jobs = Object.keys(fits).map((title, index) =>
      ashbyJob({ id: ids[index], title, descriptionPlain: "Join us." }),
    );
    const judge = fakeJudge((input) => ({
      ...fitJudgment("not_stated", null),
      scoutFitProbability: fits[input.title],
    }));
    const { app, scout } = ashbyFixture(board(jobs), undefined, undefined, judge, {
      strategyMaterial: "# Discovery Strategy\nTarget roles: Marketing Manager.",
    });

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: ids.map((id) => `https://jobs.ashbyhq.com/Roadrunner/${id}`),
      policy: { targetRoles: ["Growth Marketer"] },
    });

    expect(judge.inputs[0].scoutBrief).toBe(
      "# Discovery Strategy\nTarget roles: Marketing Manager.\nTarget roles also include: Growth Marketer.",
    );
    expect(result.appliedPolicy.scoutFitJudged).toBe(true);
    expect(
      result.results.map((entry) => [
        entry.posting.title,
        entry.policy.decision,
        entry.policy.reasons.find((reason) => reason.rule === "scout_fit")?.code,
      ]),
    ).toEqual([
      ["Growth Marketing Manager", "include", "judged_within_scout_brief"],
      ["Software Engineer, Compute Foundations", "exclude", "judged_outside_scout_brief"],
      ["Marketing Operations Analyst", "review", "judged_fit_uncertain"],
    ]);
  });

  test("applies no fit rule without a judge and validates targetRoles", async () => {
    const job = ashbyJob({ title: "Office Coordinator", descriptionPlain: "Join us." });
    const unjudged = ashbyFixture(board([job]));

    const noJudge = await unjudged.app.ashbyInspect({ scoutId: unjudged.scout.id, urls: [url] });

    expect(noJudge.appliedPolicy.scoutFitJudged).toBe(false);
    expect(noJudge.results[0].policy).toEqual({ decision: "include", reasons: [] });
    await expect(
      unjudged.app.ashbyInspect({
        scoutId: unjudged.scout.id,
        urls: [url],
        policy: { targetRoles: "Marketing" } as never,
      }),
    ).rejects.toThrow(/targetRoles must be/);
  });

  test("a failed judgment downgrades a pattern-matched exclusion to review", async () => {
    const { app, scout } = ashbyFixture(
      board([ashbyJob({ descriptionPlain: SABBATICAL_DESCRIPTION })]),
      undefined,
      undefined,
      fakeJudge(() => null),
    );

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [url],
      policy: { maximumExplicitRequiredYears: 2 },
    });

    expect(result.results[0]).toMatchObject({
      fitJudgment: null,
      policy: {
        decision: "review",
        reasons: [
          { code: "experience_judgment_unavailable" },
          { rule: "worth_keeping", code: "worth_judgment_unavailable" },
        ],
      },
    });
  });

  test("does not spend judgments on postings the freshness gate already excludes", async () => {
    const judge = fakeJudge(() => fitJudgment("entry_level", 0));
    const { app, scout } = ashbyFixture(
      board([ashbyJob({ publishedAt: "2020-01-01T00:00:00.000Z" })]),
      () => Date.parse("2026-09-18T00:00:00.000Z"),
      undefined,
      judge,
    );

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [url],
      policy: { publishedAfter: "2026-09-11T00:00:00.000Z", maximumExplicitRequiredYears: 2 },
    });

    expect(judge.inputs).toEqual([]);
    expect(result.results[0].policy.decision).toBe("exclude");
  });
});

describe("Ashby inspection", () => {
  test("defines durable Ashby posting observations", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(SCHEMA_DDL);

    expect(
      sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ashby_posting_observations'",
        )
        .get(),
    ).toEqual({ name: "ashby_posting_observations" });
  });

  test("provides a live Ashby board HTTP adapter", () => {
    expect(typeof HttpAshbyBoardProvider).toBe("function");
  });

  test("fetches the encoded board endpoint and retries one transient response", async () => {
    const calls: string[] = [];
    const responses = [
      new Response("temporary", { status: 503 }),
      new Response(JSON.stringify({ jobs: [] }), {
        status: 200,
        headers: { etag: "board-v1", "last-modified": "Wed, 16 Sep 2026 00:00:00 GMT" },
      }),
    ];
    const provider = new HttpAshbyBoardProvider(async (url) => {
      calls.push(String(url));
      return responses.shift() ?? new Response("unexpected", { status: 500 });
    });

    const result = await provider.fetchBoard({ boardHandle: "Roadrunner" });

    expect(calls).toEqual([
      "https://api.ashbyhq.com/posting-api/job-board/Roadrunner",
      "https://api.ashbyhq.com/posting-api/job-board/Roadrunner",
    ]);
    expect(result).toMatchObject({
      status: 200,
      body: { jobs: [] },
      etag: "board-v1",
      lastModified: "Wed, 16 Sep 2026 00:00:00 GMT",
      retryCount: 1,
    });
  });

  test("honors Retry-After while capping interactive wait at five seconds", async () => {
    const delays: number[] = [];
    const responses = [
      new Response("limited", { status: 429, headers: { "retry-after": "10" } }),
      new Response(JSON.stringify({ jobs: [] }), { status: 200 }),
    ];
    const provider = new HttpAshbyBoardProvider(
      async () => responses.shift() ?? new Response("unexpected", { status: 500 }),
      () => 1_000,
      async (ms) => void delays.push(ms),
    );

    const result = await provider.fetchBoard({ boardHandle: "Roadrunner" });

    expect(delays).toEqual([5_000]);
    expect(result).toMatchObject({ status: 200, retryCount: 1, retryAt: 11_000 });
  });

  test("provisions a built-in public Ashby Source", () => {
    const db = makeDb();

    expect(
      db.select().from(schema.sources).where(eq(schema.sources.id, "source-ashby")).get(),
    ).toMatchObject({
      id: "source-ashby",
      kind: "ashby",
      name: "Ashby",
      readiness: "ready",
    });
  });

  test("is exposed through the Recruiting application seam", () => {
    const app = new RecruitingApplication(makeDb(), () => 10_000);

    expect(typeof (app as unknown as { ashbyInspect?: unknown }).ashbyInspect).toBe("function");
  });

  test("groups a board request, verifies by stable id, and applies safe policy", async () => {
    const db = makeDb();
    const provider = {
      requests: [] as Array<{ boardHandle: string }>,
      async fetchBoard(request: { boardHandle: string }) {
        this.requests.push(request);
        return {
          status: 200,
          etag: "board-v1",
          lastModified: null,
          body: {
            jobs: [
              {
                id: JOB_ID,
                title: "Forward Deployed Engineer (New Grad)",
                location: "San Francisco, CA",
                address: null,
                secondaryLocations: [],
                department: null,
                team: "Agents",
                employmentType: "FullTime",
                workplaceType: "OnSite",
                isRemote: false,
                publishedAt: "2026-09-16T00:15:28.633Z",
                isListed: true,
                jobUrl: `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`,
                applyUrl: `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}/application`,
                descriptionPlain:
                  "Qualifications\n0-2 years of software engineering experience. Bonus: 4+ years using TypeScript.",
                descriptionHtml: "<p>Qualifications</p>",
              },
            ],
          },
        };
      },
    };
    const app = new RecruitingApplication(db, () => 10_000, {
      ashbyProvider: provider,
    } as never);
    const draft = app.importProfile({
      name: "Candidate",
      roleTarget: "Engineer",
      cvText: "Built useful systems.",
      careerInterests: "AI engineering",
      idempotencyKey: "ashby-profile-import",
    });
    const profile = app.confirmProfile({
      profileId: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: "ashby-profile-confirm",
    });
    const scout = app.createScout({
      name: "Ashby Scout",
      harness: "codex",
      instructionPath: "agents/ashby",
      defaultProfileId: profile.id,
      sourceIds: ["source-ashby"],
      idempotencyKey: "ashby-scout",
    }).value;
    const run = app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "ashby-run" }).value;

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [
        `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`,
        `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}?utm_source=search`,
      ],
      policy: {
        publishedAfter: "2026-09-14T00:00:00.000Z",
        listedOnly: true,
        maximumExplicitRequiredYears: 2,
      },
    });

    expect(provider.requests).toEqual([{ boardHandle: "Roadrunner" }]);
    expect(result).toMatchObject({
      observedAt: 10_000,
      provider: "ashby",
      trust: "untrusted_evidence",
      summary: {
        inputCount: 2,
        uniquePostingCount: 1,
        verifiedCount: 1,
        errorCount: 0,
        includeCount: 1,
      },
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      inputIndexes: [0, 1],
      status: "verified",
      posting: {
        provider: "ashby",
        providerJobId: JOB_ID,
        boardHandle: "Roadrunner",
        title: "Forward Deployed Engineer (New Grad)",
        publishedAt: Date.parse("2026-09-16T00:15:28.633Z"),
        isListed: true,
        observedAt: 10_000,
        firstSeenAt: 10_000,
        descriptionAvailable: true,
      },
      experienceStatus: "explicit",
      policy: { decision: "include" },
    });
    expect(result.results[0].posting).not.toHaveProperty("descriptionPlain");
    expect(result.results[0].experienceRequirements).toEqual([
      expect.objectContaining({
        minimumYears: 0,
        maximumYears: 2,
        necessity: "required",
        evidenceText: "0-2 years of software engineering experience",
      }),
      expect.objectContaining({
        minimumYears: 4,
        maximumYears: null,
        necessity: "preferred",
        evidenceText: "4+ years using TypeScript",
      }),
    ]);
    expect(result.results[0].evidenceReference).toMatch(/^ashby-evidence:/);
    expect(app.getSourceAttempt(result.sourceAttemptId)).toMatchObject({
      runId: run.id,
      sourceId: "source-ashby",
      outcome: "succeeded_with_items",
      itemCount: 1,
      pageCount: 1,
    });
    expect(app.listSignals({ runId: run.id })).toHaveLength(0);
    expect(app.listLeads()).toHaveLength(0);
  });

  test("returns invalid and missing URLs as ordered per-input errors", async () => {
    const requests: string[] = [];
    const { app, scout } = ashbyFixture({
      async fetchBoard(request) {
        requests.push(request.boardHandle);
        return { status: 200, body: { jobs: [] } };
      },
    });

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [
        `https://example.com/Roadrunner/${JOB_ID}`,
        `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`,
      ],
    });

    expect(requests).toEqual(["Roadrunner"]);
    expect(result.results).toEqual([]);
    expect(result.errors).toMatchObject([
      { inputIndexes: [0], code: "unsupported_host", retryable: false },
      { inputIndexes: [1], code: "job_not_found", retryable: false },
    ]);
  });

  test("reuses a fresh board snapshot while preserving the first verified observation", async () => {
    let now = 10_000;
    let calls = 0;
    const { app, scout } = ashbyFixture(
      {
        async fetchBoard() {
          calls += 1;
          return { status: 200, body: { jobs: [ashbyJob()] } };
        },
      },
      () => now,
    );

    const first = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
    });
    now = 11_000;
    const second = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
    });

    expect(calls).toBe(1);
    expect(first.results[0]?.posting.firstSeenAt).toBe(10_000);
    expect(second.results[0]?.posting).toMatchObject({ firstSeenAt: 10_000, observedAt: 11_000 });
  });

  test("revalidates an expired cached board with provider validators", async () => {
    let now = 10_000;
    const requests: Array<{ boardHandle: string; etag?: string; lastModified?: string }> = [];
    const { app, scout } = ashbyFixture(
      {
        async fetchBoard(request: { boardHandle: string; etag?: string; lastModified?: string }) {
          requests.push(request);
          return requests.length === 1
            ? {
                status: 200,
                body: { jobs: [ashbyJob()] },
                etag: "board-v1",
                lastModified: "Wed, 16 Sep 2026 00:00:00 GMT",
              }
            : { status: 304, body: null };
        },
      },
      () => now,
    );
    const inspect = () =>
      app.ashbyInspect({
        scoutId: scout.id,
        urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
      });

    await inspect();
    now += 301_000;
    const revalidated = await inspect();

    expect(requests).toEqual([
      { boardHandle: "Roadrunner" },
      {
        boardHandle: "Roadrunner",
        etag: "board-v1",
        lastModified: "Wed, 16 Sep 2026 00:00:00 GMT",
      },
    ]);
    expect(revalidated.results).toHaveLength(1);
    expect(revalidated.errors).toEqual([]);
  });

  test("coalesces concurrent requests for the same board", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, scout } = ashbyFixture({
      async fetchBoard() {
        calls += 1;
        await gate;
        return { status: 200, body: { jobs: [ashbyJob()] } };
      },
    });
    const inspect = () =>
      app.ashbyInspect({
        scoutId: scout.id,
        urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
      });

    const first = inspect();
    const second = inspect();
    await Promise.resolve();
    release?.();
    const results = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(results.every((result) => result.results.length === 1)).toBe(true);
  });

  test("marks the Source Attempt cancelled when the caller aborts", async () => {
    const { app, db, scout } = ashbyFixture({
      async fetchBoard(request: { boardHandle: string; signal?: AbortSignal }) {
        return await new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();
    const pending = app.ashbyInspect({
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(db.select().from(schema.sourceAttempts).get()).toMatchObject({
      outcome: "cancelled",
      safeFailure: "Ashby inspection was cancelled",
      completedAt: 10_000,
    });
  });

  test("keeps successful boards when another board drifts or is rate limited", async () => {
    const { app, scout } = ashbyFixture({
      async fetchBoard(request) {
        if (request.boardHandle === "Roadrunner") {
          return { status: 200, body: { jobs: [ashbyJob()] } };
        }
        if (request.boardHandle === "RateLimited") {
          return { status: 429, body: null, retryAt: 20_000, retryCount: 1 };
        }
        return { status: 200, body: { postings: [] } };
      },
    });

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [
        `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`,
        `https://jobs.ashbyhq.com/Broken/${JOB_ID}`,
        `https://jobs.ashbyhq.com/RateLimited/${JOB_ID}`,
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.errors).toMatchObject([
      { inputIndexes: [1], code: "schema_changed", retryable: false },
      { inputIndexes: [2], code: "rate_limited", retryable: true, retryAt: 20_000 },
    ]);
    expect(app.getSourceAttempt(result.sourceAttemptId)).toMatchObject({
      outcome: "partial",
      itemCount: 1,
      quarantinedCount: 2,
      pageCount: 3,
      retryAt: 20_000,
    });
  });

  test("quarantines a malformed requested record without hiding its valid board peer", async () => {
    const { app, scout } = ashbyFixture({
      async fetchBoard() {
        return {
          status: 200,
          body: {
            jobs: [ashbyJob(), { ...ashbyJob({ id: SECOND_JOB_ID }), title: null }],
          },
        };
      },
    });

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [
        `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`,
        `https://jobs.ashbyhq.com/Roadrunner/${SECOND_JOB_ID}`,
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.errors).toMatchObject([
      { inputIndexes: [1], code: "schema_changed", retryable: false },
    ]);
  });

  test("routes conditional education-or-experience language to review", async () => {
    const { app, scout } = ashbyFixture({
      async fetchBoard() {
        return {
          status: 200,
          body: {
            jobs: [
              ashbyJob({
                id: SECOND_JOB_ID,
                descriptionPlain:
                  "Qualifications\nBachelor's degree or 3+ years of software engineering experience.",
              }),
            ],
          },
        };
      },
    });

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${SECOND_JOB_ID}`],
      policy: { maximumExplicitRequiredYears: 2 },
    });

    expect(result.results[0]).toMatchObject({
      experienceStatus: "explicit",
      experienceRequirements: [{ minimumYears: 3, necessity: "ambiguous" }],
      policy: { decision: "review" },
    });
  });

  test("honors the Source selection frozen into the active Scout Run", async () => {
    const { app, db, scout } = ashbyFixture({
      async fetchBoard() {
        return { status: 200, body: { jobs: [ashbyJob()] } };
      },
    });
    db.delete(schema.scoutSources).where(eq(schema.scoutSources.scoutId, scout.id)).run();

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
    });

    expect(result.results).toHaveLength(1);
  });

  test("fails before network access when the Candidate disables Ashby", async () => {
    let calls = 0;
    const { app, db, scout } = ashbyFixture({
      async fetchBoard() {
        calls += 1;
        return { status: 200, body: { jobs: [ashbyJob()] } };
      },
    });
    db.update(schema.sourceAccess)
      .set({ readiness: "candidate_disabled" })
      .where(eq(schema.sourceAccess.sourceId, "source-ashby"))
      .run();

    await expect(
      app.ashbyInspect({
        scoutId: scout.id,
        urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
      }),
    ).rejects.toThrow(/disabled/i);
    expect(calls).toBe(0);
  });

  test("rejects unknown request and policy fields before network access", async () => {
    let calls = 0;
    const { app, scout } = ashbyFixture({
      async fetchBoard() {
        calls += 1;
        return { status: 200, body: { jobs: [ashbyJob()] } };
      },
    });
    const base = {
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
    };

    await expect(
      app.ashbyInspect({ ...base, locations: ["San Francisco"] } as never),
    ).rejects.toThrow(/unknown/i);
    await expect(
      app.ashbyInspect({ ...base, policy: { listedOnly: true, semanticMatch: true } } as never),
    ).rejects.toThrow(/unknown/i);
    expect(calls).toBe(0);
  });

  test("includes descriptions only on request and rejects an insecure apply URL", async () => {
    const { app, scout } = ashbyFixture({
      async fetchBoard() {
        return {
          status: 200,
          body: { jobs: [ashbyJob({ applyUrl: "http://example.com/apply" })] },
        };
      },
    });

    const result = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
      includeDescription: true,
    });

    expect(result.results[0]?.posting).toMatchObject({
      applyUrl: null,
      descriptionPlain:
        "Qualifications\n0-2 years of software engineering experience. Bonus: 4+ years using TypeScript.",
      descriptionHtml: "<p>Qualifications</p>",
    });
  });

  test("records changed observations and an explicit unlisted-to-listed relisting", async () => {
    let now = 10_000;
    const states = [false, true, true];
    const { app, db, scout } = ashbyFixture(
      {
        async fetchBoard() {
          return {
            status: 200,
            body: { jobs: [ashbyJob({ isListed: states.shift() ?? true })] },
          };
        },
      },
      () => now,
    );
    const inspect = () =>
      app.ashbyInspect({
        scoutId: scout.id,
        urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
      });

    await inspect();
    now += 301_000;
    await inspect();
    now += 301_000;
    await inspect();

    const observations = db
      .select()
      .from(schema.ashbyPostingObservations)
      .orderBy(schema.ashbyPostingObservations.observedAt)
      .all();
    expect(observations).toHaveLength(2);
    expect(observations).toMatchObject([
      { isListed: false, relisting: false, observedAt: 10_000, lastObservedAt: 10_000 },
      { isListed: true, relisting: true, observedAt: 311_000, lastObservedAt: 612_000 },
    ]);
  });

  test("promotes an Ashby evidence reference through the Scout-facing RecordSignal path", async () => {
    const { app, scout, run } = ashbyFixture({
      async fetchBoard() {
        return { status: 200, body: { jobs: [ashbyJob()] } };
      },
    });
    const inspected = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
    });
    const evidenceReference = inspected.results[0]?.evidenceReference;
    if (!evidenceReference) throw new Error("fixture evidence reference missing");

    // The agent MCP tool reaches the host through this method, not recordSignal.
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference });

    expect(app.listSignals({ runId: run.id })).toMatchObject([
      { sourceId: "source-ashby", providerIdentity: JOB_ID },
    ]);
  });

  test("promotes an opaque Ashby evidence reference with the exact full description", async () => {
    const { app, scout, run } = ashbyFixture({
      async fetchBoard() {
        return { status: 200, body: { jobs: [ashbyJob()] } };
      },
    });
    const inspected = await app.ashbyInspect({
      scoutId: scout.id,
      urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
      includeDescription: false,
    });

    const evidenceReference = inspected.results[0]?.evidenceReference;
    if (!evidenceReference) throw new Error("fixture evidence reference missing");
    app.recordSignal({
      scoutId: scout.id,
      evidenceReference,
    });

    expect(app.listSignals({ runId: run.id })).toMatchObject([
      {
        sourceId: "source-ashby",
        providerIdentity: JOB_ID,
        publicationAt: Date.parse("2026-09-16T00:15:28.633Z"),
        evidence: {
          title: "Forward Deployed Engineer (New Grad)",
          content:
            "Qualifications\n0-2 years of software engineering experience. Bonus: 4+ years using TypeScript.",
        },
        provenance: { provider: "ashby" },
      },
    ]);
    expect(app.listLeads()).toHaveLength(1);
  });
  describe("host-owned listing window", () => {
    const NOW = Date.parse("2026-09-18T12:00:00.000Z");
    const POLICY = "# Scout Policy\n\nOnly surface job listings published within the past 7 days.";
    const THIRD_JOB_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
    const board = {
      async fetchBoard() {
        return {
          status: 200,
          body: {
            jobs: [
              ashbyJob(),
              ashbyJob({
                id: SECOND_JOB_ID,
                title: "Stale Engineer",
                publishedAt: "2026-08-14T00:00:00.000Z",
                jobUrl: `https://jobs.ashbyhq.com/Roadrunner/${SECOND_JOB_ID}`,
              }),
              ashbyJob({
                id: THIRD_JOB_ID,
                title: "Unlisted Engineer",
                publishedAt: "2026-09-17T00:00:00.000Z",
                isListed: false,
                jobUrl: `https://jobs.ashbyhq.com/Roadrunner/${THIRD_JOB_ID}`,
              }),
            ],
          },
        };
      },
    };

    test("applies the pinned cutoff when publishedAfter is omitted or too early", async () => {
      const { app, scout } = ashbyFixture(board, () => NOW, POLICY);
      for (const policy of [undefined, { publishedAfter: "2026-06-01T00:00:00Z" }]) {
        const inspected = await app.ashbyInspect({
          scoutId: scout.id,
          urls: [
            `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`,
            `https://jobs.ashbyhq.com/Roadrunner/${SECOND_JOB_ID}`,
          ],
          ...(policy ? { policy } : {}),
        });
        expect(inspected.appliedPolicy).toMatchObject({
          publishedAfter: "2026-09-11T12:00:00.000Z",
          publishedAfterSource: "scout_policy",
        });
        expect(inspected.observedAtIso).toBe("2026-09-18T12:00:00.000Z");
        expect(inspected.results.map((result) => [result.ageDays, result.policy.decision])).toEqual(
          [
            [2, "include"],
            [35, "exclude"],
          ],
        );
      }
    });

    test("keeps a stricter requested cutoff", async () => {
      const { app, scout } = ashbyFixture(board, () => NOW, POLICY);
      const inspected = await app.ashbyInspect({
        scoutId: scout.id,
        urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
        policy: { publishedAfter: "2026-09-17T00:00:00Z" },
      });
      expect(inspected.appliedPolicy.publishedAfterSource).toBe("request");
      expect(inspected.results[0]?.policy.decision).toBe("exclude");
    });

    test("refuses to promote a posting the policy excluded", async () => {
      const { app, scout, run } = ashbyFixture(board, () => NOW, POLICY);
      const inspected = await app.ashbyInspect({
        scoutId: scout.id,
        urls: [`https://jobs.ashbyhq.com/Roadrunner/${SECOND_JOB_ID}`],
      });
      const evidenceReference = inspected.results[0]?.evidenceReference ?? "";
      expect(() => app.recordSignal({ scoutId: scout.id, evidenceReference })).toThrow(
        /excluded this Ashby posting/,
      );
      expect(app.listSignals({ runId: run.id })).toHaveLength(0);
    });

    test("enumerates a board for listed postings inside the window", async () => {
      const { app, scout } = ashbyFixture(board, () => NOW, POLICY);
      const inspected = await app.ashbyInspect({
        scoutId: scout.id,
        boards: ["https://jobs.ashbyhq.com/Roadrunner"],
      });
      expect(
        inspected.results.map((result) => [result.posting.title, result.discoveredVia]),
      ).toEqual([["Forward Deployed Engineer (New Grad)", "board"]]);
      expect(inspected.summary).toMatchObject({
        boardCount: 1,
        boardOutsideWindowCount: 1,
        boardTruncatedCount: 0,
      });
      const evidenceReference = inspected.results[0]?.evidenceReference ?? "";
      app.recordSignal({ scoutId: scout.id, evidenceReference });
      expect(app.listLeads()).toHaveLength(1);
    });

    test("reports an invalid board reference and requires some input", async () => {
      const { app, scout } = ashbyFixture(board, () => NOW, POLICY);
      const inspected = await app.ashbyInspect({
        scoutId: scout.id,
        boards: ["https://example.com/Roadrunner"],
      });
      expect(inspected.errors).toMatchObject([{ code: "unsupported_host" }]);
      await expect(app.ashbyInspect({ scoutId: scout.id })).rejects.toThrow(/between one and 50/);
    });

    test("exposes the host clock and cutoff in the Run context", () => {
      const { app, scout } = ashbyFixture(board, () => NOW, POLICY);
      expect(app.readRunContextForScout(scout.id).clock).toEqual({
        now: "2026-09-18T12:00:00.000Z",
        listingLookbackDays: 7,
        listingPublishedAfter: "2026-09-11T12:00:00.000Z",
      });
    });
  });
});
