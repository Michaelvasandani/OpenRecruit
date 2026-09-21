import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ATS_BOARDS } from "@shared/agent";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { RecruitingApplication } from ".";
import { ATS_ADAPTERS, ATS_PROVIDERS, routeBoard, routeJobUrl } from "./ats-boards";
import type { AtsHttp, AtsHttpResponse } from "./job-posting-inspect";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const LEVER_ID = "7394d5b9-e8cd-4559-8e8b-6a7e25ea5cf5";
const RIPPLING_ID = "82c13e8f-ae96-4c60-a872-c0ddf9eb0781";

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

/** Answers each public API URL from a table; anything else is a 404. */
function fakeHttp(routes: Record<string, AtsHttpResponse>): AtsHttp & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async getJson({ url }) {
      requested.push(url);
      return routes[url] ?? { status: 404, body: null };
    },
  };
}

function fixture(
  http: AtsHttp,
  sourceIds: string[] = ATS_PROVIDERS.map((provider) => `source-${provider}`),
  policyMaterial?: string,
) {
  const app = new RecruitingApplication(makeDb(), () => NOW, { atsHttp: http } as never);
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Built useful systems.",
    careerInterests: "AI engineering",
    idempotencyKey: `ats-profile-import-${crypto.randomUUID()}`,
  });
  const profile = app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: `ats-profile-confirm-${crypto.randomUUID()}`,
  });
  const scout = app.createScout({
    name: "Board Scout",
    harness: "codex",
    instructionPath: "agents/boards",
    defaultProfileId: profile.id,
    sourceIds,
    ...(policyMaterial === undefined ? {} : { policyMaterial }),
    idempotencyKey: `ats-scout-${crypto.randomUUID()}`,
  }).value;
  const run = app.launchScoutRun({
    scoutId: scout.id,
    idempotencyKey: `ats-run-${crypto.randomUUID()}`,
  }).value;
  return { app, scout, run };
}

const GREENHOUSE_JOB = {
  id: 4835292007,
  title: "Software Engineer - New Grad",
  company_name: "Together AI",
  absolute_url: "https://job-boards.greenhouse.io/togetherai/jobs/4835292007",
  location: { name: "San Francisco" },
  offices: [{ name: "San Francisco" }, { name: "Amsterdam" }],
  departments: [{ name: "Engineering" }],
  first_published: "2026-09-17T12:32:15-04:00",
  updated_at: "2026-09-18T12:00:00-04:00",
  content:
    "&lt;p&gt;Build inference systems.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;0-2 years of experience&lt;/li&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;",
};
const GREENHOUSE_JOB_URL = "https://boards-api.greenhouse.io/v1/boards/togetherai/jobs/4835292007";
const GREENHOUSE_BOARD_URL =
  "https://boards-api.greenhouse.io/v1/boards/togetherai/jobs?content=true";

const LEVER_JOB = {
  id: LEVER_ID,
  text: "Software Engineer",
  createdAt: Date.parse("2026-09-18T00:00:00Z"),
  categories: {
    commitment: "Full-time",
    department: "Engineering",
    team: "Core",
    location: "San Francisco",
    allLocations: ["San Francisco", "New York"],
  },
  description: "<div>About Finix</div>",
  lists: [{ text: "Requirements", content: "<li>1+ years of backend experience</li>" }],
  additional: "<div>Benefits</div>",
  hostedUrl: `https://jobs.lever.co/finix/${LEVER_ID}`,
  applyUrl: `https://jobs.lever.co/finix/${LEVER_ID}/apply`,
  workplaceType: "hybrid",
};

describe("job board URL routing", () => {
  test("routes every supported posting URL form to its board", () => {
    const cases: Array<[string, string, string, string]> = [
      [
        "https://job-boards.greenhouse.io/affirm/jobs/7485068003",
        "greenhouse",
        "affirm",
        "7485068003",
      ],
      [
        "https://boards.greenhouse.io/Figma/jobs/4595288004?gh_src=x",
        "greenhouse",
        "figma",
        "4595288004",
      ],
      [`https://jobs.lever.co/finix/${LEVER_ID}/apply`, "lever", "finix", LEVER_ID],
      [
        "https://jobs.smartrecruiters.com/SquareTrade1/744000130852434-software-engineering-manager?oga=true",
        "smartrecruiters",
        "SquareTrade1",
        "744000130852434",
      ],
      ["https://apply.workable.com/fuku/j/0EC6CA6D3E", "workable", "fuku", "0EC6CA6D3E"],
      [
        "https://apply.workable.com/pronexus-1/j/C75CE70CD7/apply/",
        "workable",
        "pronexus-1",
        "C75CE70CD7",
      ],
      [
        `https://ats.rippling.com/rippling/jobs/${RIPPLING_ID}`,
        "rippling",
        "rippling",
        RIPPLING_ID,
      ],
      [
        `https://ats.rippling.com/en-GB/rippling/jobs/${RIPPLING_ID}`,
        "rippling",
        "rippling",
        RIPPLING_ID,
      ],
      [
        "https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site/job/California---San-Francisco/Lead-Software-Engineer_JR271939/apply/useMyLastApplication",
        "workday",
        "salesforce.wd12.myworkdayjobs.com/External_Career_Site",
        "California---San-Francisco/Lead-Software-Engineer_JR271939",
      ],
      [
        "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/Software-Engineer--AI-Applications_JR357086",
        "workday",
        "salesforce.wd12.myworkdayjobs.com/External_Career_Site",
        "Software-Engineer--AI-Applications_JR357086",
      ],
    ];
    for (const [url, provider, board, jobId] of cases) {
      const routed = routeJobUrl(url);
      expect(routed).toMatchObject({ ok: true, reference: { board, jobId } });
      if (routed.ok) expect(routed.adapter.provider).toBe(provider as never);
    }
  });

  test("rejects unsupported hosts, non-posting pages, and unsafe URLs", () => {
    expect(routeJobUrl("https://example.com/jobs/1")).toMatchObject({ code: "unsupported_host" });
    expect(routeJobUrl("https://jobs.lever.co/finix")).toMatchObject({ code: "invalid_url" });
    expect(routeJobUrl(`http://jobs.lever.co/finix/${LEVER_ID}`)).toMatchObject({
      code: "invalid_url",
    });
    expect(routeJobUrl("https://evil.myworkdayjobs.com.attacker.io/x/job/y")).toMatchObject({
      code: "unsupported_host",
    });
  });

  test("routes board URLs and names the boards that cannot be enumerated", () => {
    expect(routeBoard("https://jobs.lever.co/finix")).toMatchObject({ ok: true, board: "finix" });
    expect(routeBoard("https://job-boards.greenhouse.io/togetherai/jobs/1")).toMatchObject({
      ok: true,
      board: "togetherai",
    });
    expect(routeBoard("https://ats.rippling.com/rippling/jobs")).toMatchObject({
      code: "enumeration_unsupported",
    });
    expect(routeBoard("finix")).toMatchObject({ code: "invalid_url" });
  });

  test("workday requests stay on the validated tenant host", () => {
    const routed = routeJobUrl(
      "https://autodesk.wd1.myworkdayjobs.com/en-US/ext/job/San-Francisco-CA-USA/Software-Engineer_26WD100686",
    );
    expect(routed.ok && routed.adapter.jobRequest(routed.reference).url).toBe(
      "https://autodesk.wd1.myworkdayjobs.com/wday/cxs/autodesk/ext/job/San-Francisco-CA-USA/Software-Engineer_26WD100686",
    );
  });

  test("the prompt's search sites match the adapters", () => {
    for (const provider of ATS_PROVIDERS) {
      expect(ATS_BOARDS[provider].site).toBe(ATS_ADAPTERS[provider].searchSite);
      expect(ATS_BOARDS[provider].enumerable).toBe(
        ATS_ADAPTERS[provider].boardRequest("acme") !== null,
      );
    }
  });
});

describe("board response normalization", () => {
  test("smartrecruiters joins its description sections and reads inactive as unlisted", () => {
    const posting = ATS_ADAPTERS.smartrecruiters.parseJob(
      {
        id: "744000130852434",
        name: "Software Engineer",
        active: false,
        company: { name: "SquareTrade", identifier: "SquareTrade1" },
        location: { city: "San Francisco", region: "CA", country: "us", remote: false },
        releasedDate: "2026-09-17T20:19:06.430Z",
        typeOfEmployment: { id: "permanent", label: "Full-time" },
        department: { label: "Engineering" },
        jobAd: {
          sections: {
            jobDescription: { title: "Job Description", text: "<p>Ship things.</p>" },
            qualifications: { title: "Qualifications", text: "<ul><li>2+ years</li></ul>" },
          },
        },
      },
      { board: "SquareTrade1", jobId: "744000130852434" },
    );
    expect(posting).toMatchObject({
      organization: "SquareTrade",
      location: "San Francisco, CA, US",
      isListed: false,
      needsDetail: false,
      publishedAt: Date.parse("2026-09-17T20:19:06.430Z"),
    });
    expect(posting.descriptionPlain).toContain("Ship things.");
    expect(posting.descriptionPlain).toContain("- 2+ years");
  });

  test("workable, rippling, and workday map their own field names", () => {
    const workable = ATS_ADAPTERS.workable.parseJob(
      {
        shortcode: "0EC6CA6D3E",
        title: "Software Engineer",
        state: "published",
        published: "2026-09-15T00:00:00.000Z",
        location: { city: "San Francisco", region: "California", country: "United States" },
        workplace: "on_site",
        remote: false,
        description: "<p>Role</p>",
        requirements: "<p>Reqs</p>",
      },
      { board: "fuku", jobId: "0EC6CA6D3E" },
    );
    expect(workable).toMatchObject({
      publishedAtPrecision: "day",
      isListed: true,
      location: "San Francisco, California, United States",
      canonicalUrl: "https://apply.workable.com/fuku/j/0EC6CA6D3E/",
    });

    const rippling = ATS_ADAPTERS.rippling.parseJob(
      {
        uuid: RIPPLING_ID,
        name: "ML Software Engineer Intern",
        companyName: "Rippling",
        createdOn: "2026-05-13T02:44:09.324000-07:00",
        workLocations: ["San Francisco, CA", "New York, NY"],
        department: { name: "Eng Interns", base_department: "Engineering" },
        employmentType: { label: "TEMP", id: "Temporary / Intern" },
        description: { company: "<p>About</p>", role: "<p>The role</p>" },
        unlistedFromSearch: false,
      },
      { board: "rippling", jobId: RIPPLING_ID },
    );
    expect(rippling).toMatchObject({
      organization: "Rippling",
      location: "San Francisco, CA",
      secondaryLocations: ["New York, NY"],
      department: "Engineering",
      team: "Eng Interns",
      publishedAt: Date.parse("2026-05-13T09:44:09.324Z"),
    });

    const workday = ATS_ADAPTERS.workday.parseJob(
      {
        jobPostingInfo: {
          title: "Senior backend Engineer - Java",
          jobDescription: "<p>Build</p>",
          location: "California - San Francisco",
          additionalLocations: ["California - Palo Alto"],
          startDate: "2026-09-18",
          timeType: "Full time",
          posted: true,
          externalUrl:
            "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/California---San-Francisco/Senior-backend-Engineer---Java_JR360326",
        },
        hiringOrganization: { name: "Salesforce, Inc." },
      },
      {
        board: "salesforce.wd12.myworkdayjobs.com/External_Career_Site",
        jobId: "California---San-Francisco/Senior-backend-Engineer---Java_JR360326",
      },
    );
    expect(workday).toMatchObject({
      organization: "Salesforce, Inc.",
      publishedAtPrecision: "day",
      publishedAt: Date.parse("2026-09-18"),
      secondaryLocations: ["California - Palo Alto"],
    });
  });
});

describe("JobPostingInspect", () => {
  test("verifies a mix of boards in one call and records a Signal from the reference", async () => {
    const http = fakeHttp({
      [GREENHOUSE_JOB_URL]: { status: 200, body: GREENHOUSE_JOB },
      [`https://api.lever.co/v0/postings/finix/${LEVER_ID}`]: { status: 200, body: LEVER_JOB },
    });
    const { app, scout, run } = fixture(http);

    const result = await app.jobPostingInspect({
      scoutId: scout.id,
      urls: [
        "https://job-boards.greenhouse.io/togetherai/jobs/4835292007",
        `https://jobs.lever.co/finix/${LEVER_ID}`,
        // The same posting through the legacy host is one posting, not two.
        "https://boards.greenhouse.io/togetherai/jobs/4835292007",
      ],
      includeDescription: true,
    });

    expect(result.summary).toMatchObject({ inputCount: 3, verifiedCount: 2, errorCount: 0 });
    expect(result.sourceAttempts.map((attempt) => attempt.provider)).toEqual([
      "greenhouse",
      "lever",
    ]);
    const [greenhouse, lever] = result.results;
    expect(greenhouse).toMatchObject({
      inputIndexes: [0, 2],
      discoveredVia: "url",
      ageDays: 2,
      experienceStatus: "explicit",
      posting: {
        provider: "greenhouse",
        boardHandle: "togetherai",
        organization: "Together AI",
        title: "Software Engineer - New Grad",
        location: "San Francisco",
        secondaryLocations: ["Amsterdam"],
        canonicalJobUrl: "https://job-boards.greenhouse.io/togetherai/jobs/4835292007",
      },
    });
    expect(greenhouse.posting.descriptionPlain).toContain("- 0-2 years of experience");
    expect(lever.posting).toMatchObject({
      provider: "lever",
      // Lever states no employer name; the board handle stands in.
      organization: "Finix",
      workplaceType: "hybrid",
      team: "Core",
    });
    expect(lever.posting.descriptionPlain).toContain("1+ years of backend experience");
    expect(http.requested).toHaveLength(2);

    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: lever.evidenceReference });
    expect(app.listSignals({ runId: run.id })).toMatchObject([
      {
        provider: "lever",
        sourceId: "source-lever",
        canonicalUrl: `https://jobs.lever.co/finix/${LEVER_ID}`,
        adapterVersion: "lever-posting-v1",
      },
    ]);
  });

  test("the pinned listing window excludes an old posting and blocks its promotion", async () => {
    const http = fakeHttp({
      [GREENHOUSE_JOB_URL]: {
        status: 200,
        body: { ...GREENHOUSE_JOB, first_published: "2026-07-13T12:32:15-04:00" },
      },
    });
    const { app, scout } = fixture(
      http,
      ["source-greenhouse"],
      "Only surface job listings published within the past 7 days.",
    );

    const result = await app.jobPostingInspect({
      scoutId: scout.id,
      urls: ["https://job-boards.greenhouse.io/togetherai/jobs/4835292007"],
    });

    expect(result.appliedPolicy).toMatchObject({
      publishedAfter: new Date(NOW - 7 * 86_400_000).toISOString(),
      publishedAfterSource: "scout_policy",
    });
    expect(result.results[0].policy).toMatchObject({
      decision: "exclude",
      reasons: [{ rule: "published_after", code: "published_before_window" }],
    });
    expect(() =>
      app.recordSignalForScout({
        scoutId: scout.id,
        evidenceReference: result.results[0].evidenceReference,
      }),
    ).toThrow(/excluded/);
  });

  test("a date-only board keeps a posting from the cutoff day inside the window", async () => {
    const url =
      "https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/job/Software-Engineer_JR1";
    const http = fakeHttp({
      [url]: {
        status: 200,
        body: {
          jobPostingInfo: { title: "Software Engineer", startDate: "2026-09-13", posted: true },
        },
      },
    });
    const { app, scout } = fixture(http, ["source-workday"]);

    const result = await app.jobPostingInspect({
      scoutId: scout.id,
      urls: [
        "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/Software-Engineer_JR1",
      ],
      // Noon on the cutoff day: the posting's exact hour is unknown.
      policy: { publishedAfter: "2026-09-13T12:00:00Z" },
    });

    expect(result.results[0].policy.reasons).toContainEqual({
      rule: "published_after",
      outcome: "pass",
      code: "published_in_window",
    });
  });

  test("enumerates a board for in-window postings beyond the searched URLs", async () => {
    const http = fakeHttp({
      [GREENHOUSE_BOARD_URL]: {
        status: 200,
        body: {
          jobs: [
            GREENHOUSE_JOB,
            {
              ...GREENHOUSE_JOB,
              id: 2,
              title: "Old Role",
              first_published: "2026-01-01T00:00:00Z",
            },
            {
              ...GREENHOUSE_JOB,
              id: 3,
              title: "Fresh Role",
              first_published: "2026-09-19T00:00:00Z",
            },
          ],
        },
      },
    });
    const { app, scout } = fixture(http, ["source-greenhouse"]);

    const result = await app.jobPostingInspect({
      scoutId: scout.id,
      boards: ["https://job-boards.greenhouse.io/togetherai"],
      policy: { publishedAfter: "2026-09-13T00:00:00Z" },
    });

    expect(result.results.map((entry) => entry.posting.title)).toEqual([
      "Fresh Role",
      "Software Engineer - New Grad",
    ]);
    expect(result.results.every((entry) => entry.discoveredVia === "board")).toBe(true);
    expect(result.summary).toMatchObject({ boardCount: 1, boardOutsideWindowCount: 1 });
  });

  test("a listing without descriptions fetches detail only for in-window postings", async () => {
    const listed = (id: string, releasedDate: string) => ({
      id,
      name: `Engineer ${id}`,
      releasedDate,
      company: { name: "Acme" },
    });
    const http = fakeHttp({
      "https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100": {
        status: 200,
        body: {
          content: [listed("1", "2026-09-19T00:00:00Z"), listed("2", "2026-01-01T00:00:00Z")],
        },
      },
      "https://api.smartrecruiters.com/v1/companies/Acme/postings/1": {
        status: 200,
        body: {
          ...listed("1", "2026-09-19T00:00:00Z"),
          active: true,
          jobAd: { sections: { jobDescription: { title: "Role", text: "<p>Detail text</p>" } } },
        },
      },
    });
    const { app, scout } = fixture(http, ["source-smartrecruiters"]);

    const result = await app.jobPostingInspect({
      scoutId: scout.id,
      boards: ["https://jobs.smartrecruiters.com/Acme"],
      includeDescription: true,
      policy: { publishedAfter: "2026-09-13T00:00:00Z" },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].posting.descriptionPlain).toContain("Detail text");
    expect(http.requested).toHaveLength(2);
  });

  test("a removed posting, an unselected board, and a foreign host are per-input errors", async () => {
    const http = fakeHttp({
      [GREENHOUSE_JOB_URL]: { status: 200, body: GREENHOUSE_JOB },
      "https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/Site/job/Gone_JR9": {
        status: 403,
        body: { errorCode: "S22" },
      },
    });
    const { app, scout } = fixture(http, ["source-greenhouse", "source-workday"]);

    const result = await app.jobPostingInspect({
      scoutId: scout.id,
      urls: [
        "https://job-boards.greenhouse.io/togetherai/jobs/4835292007",
        "https://salesforce.wd12.myworkdayjobs.com/Site/job/Gone_JR9",
        `https://jobs.lever.co/finix/${LEVER_ID}`,
        "https://www.linkedin.com/jobs/view/1",
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.errors.map((error) => [error.inputIndexes[0], error.code])).toEqual([
      [1, "job_not_found"],
      [2, "source_not_enabled"],
      [3, "unsupported_host"],
    ]);
    // The unselected board was never contacted.
    expect(http.requested.some((url) => url.includes("lever"))).toBe(false);
  });

  test("a Scout without any job board Source cannot inspect", async () => {
    const { app, scout } = fixture(fakeHttp({}), ["source-ashby"]);
    await expect(
      app.jobPostingInspect({
        scoutId: scout.id,
        urls: ["https://job-boards.greenhouse.io/togetherai/jobs/4835292007"],
      }),
    ).rejects.toThrow(/No job board Source is enabled/);
  });

  test("an unsupported response shape is reported, not thrown", async () => {
    const http = fakeHttp({ [GREENHOUSE_JOB_URL]: { status: 200, body: { unexpected: true } } });
    const { app, scout } = fixture(http, ["source-greenhouse"]);
    const result = await app.jobPostingInspect({
      scoutId: scout.id,
      urls: ["https://job-boards.greenhouse.io/togetherai/jobs/4835292007"],
    });
    expect(result.errors).toMatchObject([{ code: "schema_changed", provider: "greenhouse" }]);
  });
});
