import { describe, expect, test } from "bun:test";
import type { FitEvaluationSummary } from "@shared/recruiting";
import { deriveFitEvaluationDetails } from "./review-fit";

function evaluation(overrides: Partial<FitEvaluationSummary> = {}): FitEvaluationSummary {
  return {
    id: "evaluation-1",
    leadId: "lead-1",
    opportunityId: null,
    profileVersionId: "profile-version-1",
    runId: "run-1",
    strategyHash: null,
    policyHash: null,
    strategyMaterial: "",
    policyMaterial: "",
    hardConstraints: [],
    preferences: [],
    evidence: [],
    conflicts: [],
    unknowns: [],
    freshness: "fresh",
    staleReason: null,
    staleAt: null,
    currentProfileVersionId: "profile-version-1",
    nextReconsiderationAt: null,
    createdAt: 10_000,
    ...overrides,
  };
}

describe("Fit Evaluation review projection", () => {
  test("projects each conclusion, citation attribution, and evidence relationship", () => {
    const details = deriveFitEvaluationDetails(
      evaluation({
        hardConstraints: [
          {
            key: "remote-first",
            result: "satisfied",
            explanation: "The listing explicitly describes a remote-first team.",
            signalIds: ["signal-1"],
            inferred: false,
            evidenceFreshness: "fresh",
          },
        ],
        preferences: [
          {
            key: "small-team",
            result: "unknown",
            explanation: "Team size is not stated.",
            signalIds: [],
            inferred: true,
            evidenceFreshness: "fresh",
          },
        ],
        evidence: [
          {
            signalId: "signal-1",
            claim: "Remote-first team",
            kind: "fact",
            freshness: "fresh",
            attribution: {
              sourceId: "source-1",
              runId: "run-1",
              scoutId: "scout-1",
            },
          },
        ],
        conflicts: ["The title and description disagree about location."],
      }),
    );

    expect(details.label).toBe("Current");
    expect(details.hardConstraints).toEqual([
      expect.objectContaining({
        category: "Hard Constraint",
        key: "remote-first",
        result: "satisfied",
        explanation: "The listing explicitly describes a remote-first team.",
        citations: [expect.objectContaining({ claim: "Remote-first team" })],
      }),
    ]);
    expect(details.preferences).toEqual([
      expect.objectContaining({
        category: "Preference",
        key: "small-team",
        result: "unknown",
        inferred: true,
      }),
    ]);
    expect(details.evidence).toEqual([
      expect.objectContaining({
        citation: expect.objectContaining({ signalId: "signal-1" }),
        referencedBy: ["Hard Constraint: remote-first"],
      }),
    ]);
    expect(details.conflicts).toEqual(["The title and description disagree about location."]);
  });

  test("labels stale evaluations as historical while preserving their detail", () => {
    const details = deriveFitEvaluationDetails(
      evaluation({
        freshness: "stale",
        staleReason: "candidate_profile_changed",
        hardConstraints: [
          {
            key: "remote-first",
            result: "contradicted",
            explanation: "The historical listing required office attendance.",
            signalIds: ["signal-1"],
            inferred: false,
            evidenceFreshness: "stale",
          },
        ],
      }),
    );

    expect(details.label).toBe("Historical");
    expect(details.staleReason).toBe("candidate_profile_changed");
    expect(details.hardConstraints[0]).toEqual(
      expect.objectContaining({ result: "contradicted", evidenceFreshness: "stale" }),
    );
  });
});
