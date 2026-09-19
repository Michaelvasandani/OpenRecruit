import { describe, expect, test } from "bun:test";
import type { PostingFitInput, PostingFitJudge, PostingFitJudgment } from "./posting-fit";
import {
  decide,
  judgedExperienceReason,
  judgedFitReasons,
  PostingScreener,
  type ScreeningContext,
  screeningContextForRun,
} from "./posting-screen";

const CONTEXT: ScreeningContext = {
  scoutBrief: "Target roles: AI Engineer.",
  scoutPolicy: "Remote only.",
  candidateProfile: "Target role: AI Engineer",
};
const NO_CONTEXT: ScreeningContext = {
  scoutBrief: null,
  scoutPolicy: null,
  candidateProfile: null,
};

function judgment(overrides: Partial<PostingFitJudgment> = {}): PostingFitJudgment {
  return {
    model: "jev-test",
    requiredExperience: {
      level: "two_years",
      minimumYears: 2,
      confidence: 0.9,
      probabilities: { two_years: 0.9 },
    },
    scoutFitProbability: 0.9,
    worthKeepingProbability: 0.9,
    ...overrides,
  };
}

const POSTING = {
  key: "a",
  title: "AI Engineer",
  organization: null,
  department: null,
  team: null,
  employmentType: null,
  location: null,
  descriptionPlain: "Build agents.",
};

describe("PostingScreener", () => {
  test("judges nothing when no judge is configured", async () => {
    const screener = new PostingScreener();
    expect(screener.isConfigured()).toBe(false);
    expect((await screener.judgeAll([POSTING], CONTEXT)).size).toBe(0);
  });

  test("hands every posting the Run's context and degrades failures to unavailable", async () => {
    const inputs: PostingFitInput[] = [];
    const judge: PostingFitJudge = {
      isConfigured: () => true,
      judge: async (input) => {
        inputs.push(input);
        if (input.title === "Broken") throw new Error("provider down");
        return judgment();
      },
    };
    const screener = new PostingScreener({ postingFitJudge: judge });

    const judgments = await screener.judgeAll(
      [POSTING, { ...POSTING, key: "b", title: "Broken" }],
      CONTEXT,
    );

    const { key: _key, ...facts } = POSTING;
    expect(inputs[0]).toEqual({ ...facts, ...CONTEXT });
    expect(judgments.get("a")).toMatchObject({ worthKeepingProbability: 0.9 });
    expect(judgments.get("b")).toBe("unavailable");
  });
});

describe("screening context", () => {
  test("reads the pinned Strategy, Policy, and Profile snapshots", () => {
    expect(
      screeningContextForRun(
        {
          strategySnapshot: JSON.stringify({ material: " Find AI roles. " }),
          policySnapshot: JSON.stringify({ material: "Remote only." }),
          profileSnapshot: JSON.stringify({ roleTarget: "AI Engineer", markdown: "# CV\nAgents." }),
        },
        [" Forward Deployed Engineer ", ""],
      ),
    ).toEqual({
      scoutBrief: "Find AI roles.\nTarget roles also include: Forward Deployed Engineer.",
      scoutPolicy: "Remote only.",
      candidateProfile: "Target role: AI Engineer\n\n# CV\nAgents.",
    });
  });

  test("tolerates missing and malformed snapshots", () => {
    expect(
      screeningContextForRun({
        strategySnapshot: null,
        policySnapshot: "{",
        profileSnapshot: "[]",
      }),
    ).toEqual(NO_CONTEXT);
  });
});

describe("judged reasons", () => {
  test("applies one set of thresholds to every probability", () => {
    const codes = (fit: number, worth: number) =>
      judgedFitReasons(
        judgment({ scoutFitProbability: fit, worthKeepingProbability: worth }),
        CONTEXT,
      ).map((reason) => reason.code);

    expect(codes(0.9, 0.9)).toEqual(["judged_within_scout_brief", "judged_worth_keeping"]);
    expect(codes(0.45, 0.45)).toEqual(["judged_fit_uncertain", "judged_worth_uncertain"]);
    expect(codes(0.1, 0.1)).toEqual(["judged_outside_scout_brief", "judged_not_worth_keeping"]);
  });

  test("adds no rule without a judgment, and asks for review when Jev was unavailable", () => {
    expect(judgedFitReasons(undefined, CONTEXT)).toEqual([]);
    expect(judgedFitReasons("unavailable", NO_CONTEXT)).toEqual([]);
    expect(judgedFitReasons("unavailable", CONTEXT).map((reason) => reason.outcome)).toEqual([
      "review",
      "review",
    ]);
  });

  test("reads Signals judged before worth_keeping existed", () => {
    const legacy = { ...judgment(), worthKeepingProbability: undefined } as never;
    expect(judgedFitReasons(legacy, CONTEXT).map((reason) => reason.rule)).toEqual(["scout_fit"]);
  });

  test("judges experience against the limit, or defers when there is no judgment", () => {
    expect(judgedExperienceReason(undefined, 2)).toBeNull();
    expect(judgedExperienceReason("unavailable", 2)).toBeNull();
    expect(judgedExperienceReason(judgment(), 1)?.code).toBe("judged_minimum_exceeds_limit");
    expect(judgedExperienceReason(judgment(), 2)?.code).toBe("judged_minimum_within_limit");
  });

  test("any failure excludes, any review otherwise asks for review", () => {
    const pass = { rule: "r", outcome: "pass" as const, code: "c" };
    const review = { rule: "r", outcome: "review" as const, code: "c" };
    const fail = { rule: "r", outcome: "fail" as const, code: "c" };
    expect(decide([]).decision).toBe("include");
    expect(decide([pass, review]).decision).toBe("review");
    expect(decide([pass, review, fail]).decision).toBe("exclude");
  });
});
