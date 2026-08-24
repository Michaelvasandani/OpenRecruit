import { describe, expect, test } from "bun:test";
import { deriveLeadPresentationLabels } from "./review-labels";

describe("review presentation labels", () => {
  test("derives labels from canonical evidence and decisions without persisting them", () => {
    const labels = deriveLeadPresentationLabels({
      generatedAt: 10_000,
      lead: { updatedAt: 10_000 },
      signals: [{ observedAt: 10_000 }],
      fitEvaluations: [
        {
          freshness: "fresh",
          hardConstraints: [{ result: "satisfied" }],
        },
      ],
      candidateDecisions: [{ kind: "review_outcome", detail: { outcome: "watch" } }],
      revisitPlans: [{ state: "active", dueAt: 10_000 }],
    });

    expect(labels).toEqual(["Fresh Lead", "Strong fit", "Watch", "Revisit due"]);
  });
});
