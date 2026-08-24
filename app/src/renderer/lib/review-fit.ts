import type {
  FitConstraintConclusion,
  FitEvaluationSummary,
  FitEvidenceCitation,
} from "@shared/recruiting";

export type FitConclusionDetail = FitConstraintConclusion & {
  category: "Hard Constraint" | "Preference";
  citations: FitEvidenceCitation[];
};

export type FitEvidenceRelationship = {
  citation: FitEvidenceCitation;
  referencedBy: string[];
};

export type FitEvaluationDetails = {
  label: "Current" | "Historical";
  freshness: FitEvaluationSummary["freshness"];
  staleReason: string | null;
  hardConstraints: FitConclusionDetail[];
  preferences: FitConclusionDetail[];
  evidence: FitEvidenceRelationship[];
  conflicts: string[];
  unknowns: string[];
};

/**
 * Builds the renderer-only detail model for one immutable Fit Evaluation.
 * Signal IDs remain explicit on every conclusion, while citations are joined
 * back to each conclusion and expose the evaluation-to-evidence relationship.
 */
export function deriveFitEvaluationDetails(evaluation: FitEvaluationSummary): FitEvaluationDetails {
  const evidenceBySignal = new Map<string, FitEvidenceCitation[]>();
  for (const citation of evaluation.evidence) {
    const citations = evidenceBySignal.get(citation.signalId) ?? [];
    citations.push(citation);
    evidenceBySignal.set(citation.signalId, citations);
  }

  const conclusions = [
    ...evaluation.hardConstraints.map((conclusion) => ({
      ...conclusion,
      category: "Hard Constraint" as const,
    })),
    ...evaluation.preferences.map((conclusion) => ({
      ...conclusion,
      category: "Preference" as const,
    })),
  ];
  const details = conclusions.map<FitConclusionDetail>((conclusion) => ({
    ...conclusion,
    citations: conclusion.signalIds.flatMap((signalId) => evidenceBySignal.get(signalId) ?? []),
  }));

  return {
    label: evaluation.freshness === "fresh" ? "Current" : "Historical",
    freshness: evaluation.freshness,
    staleReason: evaluation.staleReason,
    hardConstraints: details.filter((conclusion) => conclusion.category === "Hard Constraint"),
    preferences: details.filter((conclusion) => conclusion.category === "Preference"),
    evidence: evaluation.evidence.map((citation) => ({
      citation,
      referencedBy: conclusions
        .filter((conclusion) => conclusion.signalIds.includes(citation.signalId))
        .map((conclusion) => `${conclusion.category}: ${conclusion.key}`),
    })),
    conflicts: evaluation.conflicts,
    unknowns: evaluation.unknowns,
  };
}
