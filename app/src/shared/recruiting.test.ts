import { describe, expect, test } from "bun:test";
import { SignalEvidence } from "./recruiting";

const BASE = {
  title: "Software Engineer",
  content: "Build things.",
  canonicalUrl: null,
  providerIdentity: null,
  sourceIdentity: null,
};
const REQUIRED_EXPERIENCE = {
  level: "entry_level",
  minimumYears: 0,
  confidence: 0.9,
  probabilities: { entry_level: 0.9 },
};

describe("SignalEvidence", () => {
  test("still reads Signals stored under earlier fitJudgment shapes", () => {
    const stored = [
      BASE,
      // Recorded while the judgment carried engineeringRoleProbability.
      {
        ...BASE,
        fitJudgment: {
          model: "jev-1.13.0",
          requiredExperience: REQUIRED_EXPERIENCE,
          engineeringRoleProbability: 0.97,
        },
      },
      {
        ...BASE,
        fitJudgment: {
          model: "jev-1.13.0",
          requiredExperience: REQUIRED_EXPERIENCE,
          scoutFitProbability: null,
        },
      },
    ];

    for (const evidence of stored) expect(SignalEvidence.safeParse(evidence).success).toBe(true);
  });
});
