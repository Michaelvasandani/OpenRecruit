export type ReviewLabelInput = {
  lead: { updatedAt: number };
  signals: Array<{ observedAt: number }>;
  fitEvaluations: Array<{
    freshness: string;
    hardConstraints: Array<{ result: string }>;
  }>;
  candidateDecisions: Array<{ detail: Record<string, unknown> }>;
  revisitPlans: Array<{ state: string; dueAt: number | null }>;
  generatedAt: number;
};

/** Presentation-only labels. None of these values are persisted or sent as
 * domain state; they are recomputed from the authoritative Lead panel. */
export function deriveLeadPresentationLabels(panel: ReviewLabelInput): string[] {
  const labels: string[] = [];
  const freshCutoff = panel.generatedAt - 7 * 24 * 60 * 60 * 1_000;
  if (
    panel.lead.updatedAt >= freshCutoff ||
    panel.signals.some((signal) => signal.observedAt >= freshCutoff)
  ) {
    labels.push("Fresh Lead");
  }
  if (panel.candidateDecisions.length === 0) labels.push("Needs review");
  if (
    panel.fitEvaluations.some(
      (evaluation) =>
        evaluation.freshness === "fresh" &&
        evaluation.hardConstraints.length > 0 &&
        evaluation.hardConstraints.every((constraint) => constraint.result === "satisfied"),
    )
  ) {
    labels.push("Strong fit");
  }
  if (panel.candidateDecisions.some((decision) => decision.detail.outcome === "watch")) {
    labels.push("Watch");
  }
  if (
    panel.revisitPlans.some(
      (plan) => plan.state === "active" && plan.dueAt !== null && plan.dueAt <= panel.generatedAt,
    )
  ) {
    labels.push("Revisit due");
  }
  return labels;
}
