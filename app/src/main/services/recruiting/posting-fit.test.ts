import { describe, expect, test } from "bun:test";
import { JevPostingFitJudge, type PostingFitFetch } from "./posting-fit";

const POSTING = {
  title: "Junior Software Engineer",
  organization: "Roadrunner",
  department: null,
  team: null,
  employmentType: "FullTime",
  location: "San Francisco, CA",
  descriptionPlain: "Build things. Paid Sabbatical Leave after 5 years of employment.",
  scoutBrief: "Target roles: New Grad AI Engineer.",
};

function jevResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      required_experience: {
        type: "choice",
        choice: "entry_level",
        probabilities: { entry_level: 0.9, five_plus_years: 0.1 },
        confidence: 0.85,
      },
      scout_fit: { type: "noul", noul: 0.97 },
      ...overrides,
    },
    usage: { input_tokens: 400, output_tokens: 0 },
  };
}

function respond(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name] ?? null },
  };
}

describe("Jev posting fit judge", () => {
  test("stays silent and makes no request without a configured key", async () => {
    let calls = 0;
    const judge = new JevPostingFitJudge(() => undefined, (async () => {
      calls += 1;
      return respond(200, jevResponse());
    }) as PostingFitFetch);

    expect(judge.isConfigured()).toBe(false);
    expect(await judge.judge(POSTING)).toBeNull();
    expect(calls).toBe(0);
  });

  test("sends the posting as state and maps typed answers", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const judge = new JevPostingFitJudge(() => "ts-secret", (async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return respond(200, jevResponse());
    }) as PostingFitFetch);

    const judgment = await judge.judge(POSTING);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(requests[0].headers.authorization).toBe("Bearer ts-secret");
    expect(requests[0].body).toMatchObject({
      model: "jev-latest",
      state: {
        posting: { title: "Junior Software Engineer" },
        scoutBrief: "Target roles: New Grad AI Engineer.",
      },
      questions: {
        required_experience: { type: "choice" },
        scout_fit: { type: "noul" },
      },
    });
    expect(judgment).toEqual({
      model: "jev-1.13.0",
      requiredExperience: {
        level: "entry_level",
        minimumYears: 0,
        confidence: 0.85,
        probabilities: { entry_level: 0.9, five_plus_years: 0.1 },
      },
      scoutFitProbability: 0.97,
    });
    expect(JSON.stringify(judgment)).not.toContain("ts-secret");
  });

  test("asks only about experience when the Scout has no brief", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const judge = new JevPostingFitJudge(() => "ts-secret", (async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return respond(200, jevResponse({ scout_fit: undefined }));
    }) as PostingFitFetch);

    const judgment = await judge.judge({ ...POSTING, scoutBrief: null });

    expect(Object.keys(bodies[0].questions as object)).toEqual(["required_experience"]);
    expect(bodies[0].state).not.toHaveProperty("scoutBrief");
    expect(judgment?.scoutFitProbability).toBeNull();
  });

  test("judges the same posting again for a Scout with a different brief", async () => {
    let calls = 0;
    const judge = new JevPostingFitJudge(() => "ts-secret", (async () => {
      calls += 1;
      return respond(200, jevResponse());
    }) as PostingFitFetch);

    await judge.judge(POSTING);
    await judge.judge({ ...POSTING, scoutBrief: "Target roles: Marketing Manager." });

    expect(calls).toBe(2);
  });

  test("reuses the judgment for unchanged posting content", async () => {
    let calls = 0;
    const judge = new JevPostingFitJudge(() => "ts-secret", (async () => {
      calls += 1;
      return respond(200, jevResponse());
    }) as PostingFitFetch);

    await judge.judge(POSTING);
    await judge.judge({ ...POSTING });
    await judge.judge({ ...POSTING, descriptionPlain: "Changed." });

    expect(calls).toBe(2);
  });

  test("retries rate limits with backoff and then succeeds", async () => {
    const delays: number[] = [];
    const responses = [
      respond(429, {}, { "retry-after": "2" }),
      respond(529),
      respond(200, jevResponse()),
    ];
    const judge = new JevPostingFitJudge(
      () => "ts-secret",
      (async () => responses.shift() ?? respond(500)) as PostingFitFetch,
      async (ms) => void delays.push(ms),
    );

    expect((await judge.judge(POSTING))?.requiredExperience.level).toBe("entry_level");
    expect(delays).toEqual([2_000, 1_000]);
  });

  test("returns no judgment for rejected keys, network errors, and malformed answers", async () => {
    const rejected = new JevPostingFitJudge(() => "ts-secret", (async () =>
      respond(401)) as PostingFitFetch);
    const offline = new JevPostingFitJudge(() => "ts-secret", (async () => {
      throw new Error("offline");
    }) as PostingFitFetch);
    const malformed = new JevPostingFitJudge(() => "ts-secret", (async () =>
      respond(
        200,
        jevResponse({
          required_experience: { type: "choice", choice: "wizard", confidence: 0.9 },
        }),
      )) as PostingFitFetch);

    expect(await rejected.judge(POSTING)).toBeNull();
    expect(await offline.judge(POSTING)).toBeNull();
    expect(await malformed.judge(POSTING)).toBeNull();
  });
});
