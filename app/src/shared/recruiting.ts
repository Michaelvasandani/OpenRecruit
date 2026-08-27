import { z } from "zod";

export const ScoutHarness = z.enum(["claude", "codex"]);
export type ScoutHarness = z.infer<typeof ScoutHarness>;

export const ScoutLifecycle = z.enum(["active", "archived"]);
export type ScoutLifecycle = z.infer<typeof ScoutLifecycle>;

/** Safe desktop projection. It intentionally contains no database rows, secrets,
 * provider payloads, credentials, or provider transcripts. */
export const ScoutSummary = z.object({
  id: z.string(),
  name: z.string(),
  harness: ScoutHarness,
  instructionPath: z.string(),
  strategyPath: z.string().nullable(),
  /** Candidate-editable Discovery Strategy material, never provider-specific. */
  strategyMaterial: z.string(),
  /** Candidate-editable policy material; host invariants are always enforced. */
  policyMaterial: z.string(),
  defaultProfileId: z.string().nullable(),
  /** Explicit Source selections. An empty set means the Scout has no run-ready Sources. */
  sourceIds: z.array(z.string()),
  lifecycleState: ScoutLifecycle,
  resumableSessionRef: z.string().nullable(),
  legacyAgentId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int(),
});
export type ScoutSummary = z.infer<typeof ScoutSummary>;

export const SourceReadiness = z.enum([
  "not_configured",
  "ready",
  "reauthentication_required",
  "rate_limited",
  "blocked",
  "degraded",
  "candidate_disabled",
]);
export type SourceReadiness = z.infer<typeof SourceReadiness>;

export const SourceAccessReadiness = SourceReadiness;
export type SourceAccessReadiness = z.infer<typeof SourceAccessReadiness>;

/** Retrieval providers available beneath an X Source. The provider is part of
 * the Source identity and is never selected by a Scout at read time. */
export const XSourceProvider = z.enum(["x-api-v2", "bird"]);
export type XSourceProvider = z.infer<typeof XSourceProvider>;

/** Outcomes are deliberately exhaustive and safe to render. Raw provider errors
 * and payloads never cross the Source boundary. */
export const SourceAttemptOutcome = z.enum([
  "succeeded_with_items",
  "succeeded_empty",
  "not_modified",
  "partial",
  "rate_limited",
  "budget_exhausted",
  "blocked",
  "transient_failure",
  "malformed_content",
  "timed_out",
  "unsupported",
  "rejected",
  "cancelled",
]);
export type SourceAttemptOutcome = z.infer<typeof SourceAttemptOutcome>;

export const SourceAccessSummary = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  accountRef: z.string(),
  scopeKey: z.string(),
  accessMode: z.enum(["public"]),
  readiness: SourceAccessReadiness,
  safeFailure: z.string().nullable(),
  safeReason: z.string().nullable(),
  lastCheckedAt: z.number().int().nullable(),
  lastSuccessAt: z.number().int().nullable(),
  lastSuccessfulCheckAt: z.number().int().nullable(),
  nextAction: z.string().nullable(),
  retryAt: z.number().int().nullable(),
});
export type SourceAccessSummary = z.infer<typeof SourceAccessSummary>;

/** Safe Source projection. Configuration is opaque and never contains auth material. */
export const SourceSummary = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  /** Null for Source kinds that do not have an X retrieval provider. */
  provider: XSourceProvider.nullable(),
  readiness: SourceReadiness,
  safeFailure: z.string().nullable(),
  safeReason: z.string().nullable(),
  lastCheckedAt: z.number().int().nullable(),
  lastSuccessAt: z.number().int().nullable(),
  nextAction: z.string().nullable(),
  retryAt: z.number().int().nullable(),
  access: SourceAccessSummary.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type SourceSummary = z.infer<typeof SourceSummary>;

export const SourceAttemptSummary = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sourceId: z.string().min(1),
  requestedScope: z.string(),
  cursor: z.string().nullable(),
  outcome: SourceAttemptOutcome,
  itemCount: z.number().int().nonnegative(),
  quarantinedCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  retryAt: z.number().int().nullable(),
  safeFailure: z.string().nullable(),
  /** Safe operational fields projected from requestedScope for Source audit. */
  provider: z.string().nullable().optional(),
  retryDisposition: z
    .enum(["not_retried", "recovered", "exhausted", "mixed"])
    .nullable()
    .optional(),
  errorCategory: z.string().nullable().optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  /** Safe wall-clock instrumentation for provider operations. */
  queueWaitMs: z.number().int().nonnegative().optional(),
  executionMs: z.number().int().nonnegative().optional(),
  startedAt: z.number().int(),
  completedAt: z.number().int().nullable(),
});
export type SourceAttemptSummary = z.infer<typeof SourceAttemptSummary>;

/** Safe immutable evidence captured from an attributable public Source item. */
export const SignalEvidence = z.object({
  title: z.string(),
  content: z.string(),
  canonicalUrl: z.string().nullable(),
  providerIdentity: z.string().nullable(),
  sourceIdentity: z.string().nullable(),
  author: z
    .object({
      id: z.string(),
      username: z.string().nullable(),
      name: z.string().nullable(),
      protected: z.boolean().optional(),
      withheld: z.unknown().nullable().optional(),
    })
    .nullable()
    .optional(),
  editHistory: z.array(z.string()).optional(),
  withheld: z.unknown().nullable().optional(),
  protected: z.boolean().optional(),
});
export type SignalEvidence = z.infer<typeof SignalEvidence>;

export const SignalSummary = z.object({
  id: z.string().min(1),
  sourceItemId: z.string().min(1),
  sourceId: z.string().min(1),
  /** X provider identity, when this Signal came from an X Source. */
  provider: XSourceProvider.nullable(),
  sourceAttemptId: z.string().min(1),
  runId: z.string().min(1),
  scoutId: z.string().min(1),
  fingerprint: z.string().min(1),
  provenance: z.record(z.string(), z.unknown()),
  publicationAt: z.number().int().nullable(),
  observedAt: z.number().int(),
  retrievedAt: z.number().int(),
  evidence: SignalEvidence,
  retentionUntil: z.number().int().nullable(),
  /** Retention expiry makes provider text stale until an authorized refresh. */
  freshness: z.enum(["fresh", "stale"]).default("fresh"),
  supersededSignalId: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  providerIdentity: z.string().nullable(),
  accessMode: z.literal("public"),
  adapterVersion: z.string().min(1),
  processor: z.string().min(1),
  attribution: z.object({
    strategyKey: z.string().nullable(),
    strategyMaterial: z.string(),
  }),
  attributions: z.array(
    z.object({
      runId: z.string().min(1),
      scoutId: z.string().min(1),
      strategyKey: z.string().nullable(),
      strategyMaterial: z.string(),
      createdAt: z.number().int(),
    }),
  ),
  createdAt: z.number().int(),
});
export type SignalSummary = z.infer<typeof SignalSummary>;

/** Candidate-controlled scope for inspecting or deleting saved Source evidence. */
export const EvidenceScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), sourceItemId: z.string().min(1) }),
  z.object({ kind: z.literal("source"), sourceId: z.string().min(1) }),
  z.object({ kind: z.literal("all") }),
]);
export type EvidenceScope = z.infer<typeof EvidenceScope>;

export const EvidenceRetentionState = z.enum(["retained", "expired"]);
export type EvidenceRetentionState = z.infer<typeof EvidenceRetentionState>;

/** Safe saved-evidence projection. Raw captures and provider transcripts are
 * never persisted or returned as evidence records. */
export const EvidenceItemSummary = z.object({
  sourceItemId: z.string().min(1),
  signalId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceAttemptId: z.string().min(1),
  canonicalUrl: z.string().nullable(),
  providerIdentity: z.string().nullable(),
  fingerprint: z.string().min(1),
  evidence: SignalEvidence,
  retentionUntil: z.number().int().nullable(),
  retentionState: EvidenceRetentionState,
  observedAt: z.number().int(),
  createdAt: z.number().int(),
});
export type EvidenceItemSummary = z.infer<typeof EvidenceItemSummary>;

export const EvidenceInspectionSummary = z.object({
  scope: EvidenceScope,
  revision: z.number().int().nonnegative(),
  items: z.array(EvidenceItemSummary),
  rawCapturesRetained: z.literal(false),
  providerTranscriptsRetained: z.literal(false),
});
export type EvidenceInspectionSummary = z.infer<typeof EvidenceInspectionSummary>;

export const EvidenceDeletionSummary = z.object({
  scope: EvidenceScope,
  deletedSignalIds: z.array(z.string().min(1)),
  affectedSourceItemIds: z.array(z.string().min(1)),
  affectedLeadIds: z.array(z.string().min(1)),
  affectedOpportunityIds: z.array(z.string().min(1)),
  affectedInvestigationIds: z.array(z.string().min(1)),
  affectedFitEvaluationIds: z.array(z.string().min(1)),
  revision: z.number().int().nonnegative(),
});
export type EvidenceDeletionSummary = z.infer<typeof EvidenceDeletionSummary>;

export const LeadConflict = z.object({
  kind: z.string().min(1),
  signalId: z.string().nullable().optional(),
  relatedLeadId: z.string().nullable().optional(),
  detail: z.string().min(1),
});
export type LeadConflict = z.infer<typeof LeadConflict>;

export const LeadSummary = z.object({
  id: z.string().min(1),
  canonicalKey: z.string().min(1),
  canonicalUrl: z.string().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  identityState: z.enum(["settled", "conflicted"]),
  conflict: z.string().nullable(),
  conflicts: z.array(LeadConflict),
  mergedInto: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  signalIds: z.array(z.string()),
  sourceIds: z.array(z.string()),
  scoutIds: z.array(z.string()),
  updatedAt: z.number().int(),
  createdAt: z.number().int(),
});
export type LeadSummary = z.infer<typeof LeadSummary>;

export const FitEvaluationResult = z.enum([
  "satisfied",
  "contradicted",
  "unknown",
  "not_applicable",
  "conflicted",
]);
export type FitEvaluationResult = z.infer<typeof FitEvaluationResult>;

export const FitEvidenceFreshness = z.enum(["fresh", "stale"]);
export type FitEvidenceFreshness = z.infer<typeof FitEvidenceFreshness>;
/** Shared domain spelling used by projections and future Revisit Plans. */
export const Freshness = FitEvidenceFreshness;
export type Freshness = FitEvidenceFreshness;

export const FitEvidenceCitation = z.object({
  signalId: z.string().min(1),
  claim: z.string().min(1),
  kind: z.enum(["fact", "inference"]),
  /** Inferences are always labeled and stale citations can never satisfy a Hard Constraint. */
  freshness: FitEvidenceFreshness.default("fresh"),
  attribution: z
    .object({
      sourceId: z.string().min(1),
      runId: z.string().min(1),
      scoutId: z.string().min(1),
    })
    .optional(),
});
export type FitEvidenceCitation = z.infer<typeof FitEvidenceCitation>;

export const FitConstraintConclusion = z.object({
  key: z.string().min(1),
  result: FitEvaluationResult,
  explanation: z.string().min(1),
  signalIds: z.array(z.string().min(1)),
  inferred: z.boolean().default(false),
  evidenceFreshness: FitEvidenceFreshness.default("fresh"),
});
export type FitConstraintConclusion = z.infer<typeof FitConstraintConclusion>;

export const OpportunitySummary = z.object({
  id: z.string().min(1),
  leadId: z.string().min(1),
  title: z.string().min(1),
  state: z.string().min(1),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type OpportunitySummary = z.infer<typeof OpportunitySummary>;

export const CandidateDecisionKind = z.enum([
  "correction",
  "prohibition",
  "dismissal",
  "reversal",
  "review_outcome",
  "reconsideration",
]);
export type CandidateDecisionKind = z.infer<typeof CandidateDecisionKind>;

export const CandidateDecisionSummary = z.object({
  id: z.string().min(1),
  leadId: z.string().nullable(),
  opportunityId: z.string().nullable(),
  kind: CandidateDecisionKind,
  detail: z.record(z.string(), z.unknown()),
  expectedRevision: z.number().int().nonnegative(),
  createdAt: z.number().int(),
});
export type CandidateDecisionSummary = z.infer<typeof CandidateDecisionSummary>;

export const CandidateDecisionState = z.object({
  resurfacingSuppressed: z.boolean(),
  latestDismissalId: z.string().nullable(),
  reconsiderationRequested: z.boolean(),
  protectedCorrectionIds: z.array(z.string()),
  explicitProhibitionIds: z.array(z.string()),
});
export type CandidateDecisionState = z.infer<typeof CandidateDecisionState>;

/** A normalized, safe question shared across Scouts for one subject. */
export const InvestigationQuestionKey = z.string().min(1).max(2_000);
export type InvestigationQuestionKey = z.infer<typeof InvestigationQuestionKey>;

export const InvestigationStatus = z.enum(["open", "closed"]);
export type InvestigationStatus = z.infer<typeof InvestigationStatus>;

/** Reasons are intentionally finite so a rerun is reviewable rather than an
 * opaque provider assertion. */
export const InvestigationRerunReason = z.enum([
  "evidence_changed",
  "profile_changed",
  "policy_changed",
  "freshness_changed",
  "explicit_request",
]);
export type InvestigationRerunReason = z.infer<typeof InvestigationRerunReason>;

export const InvestigationAttemptOutcome = z.enum([
  "in_progress",
  "succeeded",
  "unknown",
  "conflicted",
  "blocked",
  "failed",
  "cancelled",
]);
export type InvestigationAttemptOutcome = z.infer<typeof InvestigationAttemptOutcome>;

/** Evidence considered by an Investigation is a safe reference and claim, not
 * a provider transcript or raw capture. */
export const InvestigationEvidence = z.object({
  signalId: z.string().min(1),
  claim: z.string().min(1).max(10_000),
  kind: z.enum(["fact", "inference"]).default("fact"),
  freshness: FitEvidenceFreshness.default("fresh"),
});
export type InvestigationEvidence = z.infer<typeof InvestigationEvidence>;

export const InvestigationAttemptSummary = z.object({
  id: z.string().min(1),
  investigationId: z.string().min(1),
  scoutId: z.string().min(1),
  runId: z.string().nullable(),
  questionSnapshot: z.string().min(1),
  evidence: z.array(InvestigationEvidence),
  conclusion: z.string().nullable(),
  uncertainty: z.string().nullable(),
  outcome: InvestigationAttemptOutcome,
  rerunReason: InvestigationRerunReason.nullable(),
  profileVersionId: z.string().nullable(),
  strategySnapshot: z.string(),
  policySnapshot: z.string(),
  freshness: FitEvidenceFreshness,
  supersedesAttemptId: z.string().nullable(),
  createdAt: z.number().int(),
  completedAt: z.number().int().nullable(),
});
export type InvestigationAttemptSummary = z.infer<typeof InvestigationAttemptSummary>;

export const InvestigationSummary = z.object({
  id: z.string().min(1),
  leadId: z.string().nullable(),
  opportunityId: z.string().nullable(),
  questionKey: InvestigationQuestionKey,
  questionSnapshot: z.string().min(1),
  status: InvestigationStatus,
  revision: z.number().int().nonnegative(),
  latestAttempt: InvestigationAttemptSummary.nullable(),
  attempts: z.array(InvestigationAttemptSummary),
  conflicts: z.array(z.string()),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type InvestigationSummary = z.infer<typeof InvestigationSummary>;

export const InvestigationAttemptDecision = z.enum(["started", "reused", "coalesced"]);
export type InvestigationAttemptDecision = z.infer<typeof InvestigationAttemptDecision>;

/**
 * A transparent, immutable evaluation. There is intentionally no score/rank
 * field: callers must order from these explainable conclusions and Freshness.
 */
export const FitEvaluationSummary = z.object({
  id: z.string().min(1),
  leadId: z.string().nullable(),
  opportunityId: z.string().nullable(),
  profileVersionId: z.string().min(1),
  runId: z.string().min(1),
  strategyHash: z.string().nullable(),
  policyHash: z.string().nullable(),
  strategyMaterial: z.string(),
  policyMaterial: z.string(),
  hardConstraints: z.array(FitConstraintConclusion),
  preferences: z.array(FitConstraintConclusion),
  evidence: z.array(FitEvidenceCitation),
  conflicts: z.array(z.string()),
  unknowns: z.array(z.string()),
  freshness: FitEvidenceFreshness,
  staleReason: z.string().nullable(),
  staleAt: z.number().int().nullable(),
  currentProfileVersionId: z.string().nullable(),
  nextReconsiderationAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type FitEvaluationSummary = z.infer<typeof FitEvaluationSummary>;
export const FitEvaluation = FitEvaluationSummary;
export type FitEvaluation = FitEvaluationSummary;

export const LeadContext = z.object({
  lead: LeadSummary,
  signals: z.array(SignalSummary),
  opportunities: z.array(OpportunitySummary).default([]),
  fitEvaluations: z.array(FitEvaluationSummary).default([]),
  investigations: z.array(InvestigationSummary).default([]),
  candidateDecisions: z.array(CandidateDecisionSummary).default([]),
  decisionState: CandidateDecisionState.default({
    resurfacingSuppressed: false,
    latestDismissalId: null,
    reconsiderationRequested: false,
    protectedCorrectionIds: [],
    explicitProhibitionIds: [],
  }),
});
export type LeadContext = z.infer<typeof LeadContext>;

export const ScoutRunStatus = z.enum([
  "queued",
  "preflight",
  "running",
  "finalizing",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);
export type ScoutRunStatus = z.infer<typeof ScoutRunStatus>;

export const ScoutRunPhase = z.enum(["preflight", "discovery", "finalization"]);
export type ScoutRunPhase = z.infer<typeof ScoutRunPhase>;

/** Safe desktop projection of a bounded Run; snapshots contain Candidate-approved
 * material only and never provider transcripts or credentials. */
export const ScoutRunSummary = z.object({
  id: z.string().min(1),
  scoutId: z.string().min(1),
  trigger: z.enum(["manual", "scheduled", "source_event", "revisit", "explicit_request"]),
  status: ScoutRunStatus,
  phase: ScoutRunPhase,
  budget: z.string(),
  profileVersionId: z.string().nullable(),
  profileSnapshot: z.string().nullable(),
  strategySnapshot: z.string().nullable(),
  policySnapshot: z.string().nullable(),
  overrideSnapshot: z.string().nullable(),
  sourceIds: z.array(z.string()),
  /** Provider identity pinned for every selected X Source at preflight. */
  sourceProviders: z.record(z.string(), XSourceProvider.nullable()).default({}),
  signalIds: z.array(z.string()).default([]),
  leadIds: z.array(z.string()).default([]),
  checkpoint: z.string().nullable(),
  safeFailure: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type ScoutRunSummary = z.infer<typeof ScoutRunSummary>;

export const RevisitPlanState = z.enum(["active", "paused", "completed"]);
export type RevisitPlanState = z.infer<typeof RevisitPlanState>;

export const RevisitPlanKind = z.enum(["source", "lead", "opportunity", "investigation"]);
export type RevisitPlanKind = z.infer<typeof RevisitPlanKind>;

/** A durable plan has exactly one subject. A null cadence is an explicit
 * Candidate choice to revisit only when requested. */
export const RevisitPlanSummary = z.object({
  id: z.string().min(1),
  scoutId: z.string().min(1),
  sourceId: z.string().nullable(),
  leadId: z.string().nullable(),
  opportunityId: z.string().nullable(),
  investigationId: z.string().nullable(),
  kind: RevisitPlanKind,
  cadence: z.string().nullable(),
  dueAt: z.number().int().nullable(),
  state: RevisitPlanState,
  policySnapshot: z.string(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type RevisitPlanSummary = z.infer<typeof RevisitPlanSummary>;

export const ScoutRunRequestTrigger = z.enum([
  "scheduled",
  "source_event",
  "revisit",
  "candidate_request",
  "explicit_request",
]);
export type ScoutRunRequestTrigger = z.infer<typeof ScoutRunRequestTrigger>;

export const ScoutRunRequestStatus = z.enum([
  "pending",
  "dispatching",
  "dispatched",
  "blocked",
  "cancelled",
]);
export type ScoutRunRequestStatus = z.infer<typeof ScoutRunRequestStatus>;

/** Safe projection of a durable Run intent. The request key is a stable
 * coalescing identity, never provider input or a secret. */
export const ScoutRunRequestSummary = z.object({
  id: z.string().min(1),
  scoutId: z.string().min(1),
  trigger: ScoutRunRequestTrigger,
  requestKey: z.string().min(1),
  sourceId: z.string().nullable(),
  leadId: z.string().nullable(),
  opportunityId: z.string().nullable(),
  investigationId: z.string().nullable(),
  reason: z.string(),
  budget: z.string(),
  status: ScoutRunRequestStatus,
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nullable(),
  runId: z.string().nullable(),
  safeFailure: z.string().nullable(),
  createdAt: z.number().int(),
  dispatchedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
});
export type ScoutRunRequestSummary = z.infer<typeof ScoutRunRequestSummary>;

export const ScoutRunCheckpointSummary = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  phase: ScoutRunPhase,
  checkpoint: z.string(),
  createdAt: z.number().int(),
});
export type ScoutRunCheckpointSummary = z.infer<typeof ScoutRunCheckpointSummary>;

export const ScoutRunCenterProjection = z.object({
  scoutId: z.string().min(1),
  lastRun: ScoutRunSummary.nullable(),
  nextRunAt: z.number().int().nullable(),
  dueRevisitCount: z.number().int().nonnegative(),
  activeRunId: z.string().nullable(),
  checkpoint: z.string().nullable(),
  pendingRequestCount: z.number().int().nonnegative(),
});
export type ScoutRunCenterProjection = z.infer<typeof ScoutRunCenterProjection>;

/** Structured operational activity for the Run Center. These entries are
 * derived from committed Run records and normalized Source outcomes; they are
 * intentionally not provider logs or transcripts. */
export const ScoutRunActivityKind = z.enum([
  "run_created",
  "run_status_changed",
  "checkpoint_committed",
  "source_attempt_completed",
  "signal_recorded",
  "lead_linked",
]);
export type ScoutRunActivityKind = z.infer<typeof ScoutRunActivityKind>;

export const ScoutRunActivity = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  kind: ScoutRunActivityKind,
  phase: ScoutRunPhase,
  at: z.number().int(),
  sourceId: z.string().nullable(),
  sourceAttemptId: z.string().nullable(),
  signalId: z.string().nullable(),
  leadId: z.string().nullable(),
  outcome: SourceAttemptOutcome.nullable(),
  message: z.string().min(1),
});
export type ScoutRunActivity = z.infer<typeof ScoutRunActivity>;

export const SourceReadinessAggregate = z.object({
  total: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  needsAttention: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type SourceReadinessAggregate = z.infer<typeof SourceReadinessAggregate>;

export const ReviewSidebarScout = z.object({
  scout: ScoutSummary,
  activeRun: ScoutRunSummary.nullable(),
  latestRun: ScoutRunSummary.nullable(),
  lastRunAt: z.number().int().nullable(),
  nextRunAt: z.number().int().nullable(),
  freshLeadCount: z.number().int().nonnegative(),
  dueRevisitCount: z.number().int().nonnegative(),
  sourceReadiness: SourceReadinessAggregate,
});
export type ReviewSidebarScout = z.infer<typeof ReviewSidebarScout>;

/** Candidate-facing sidebar projection. It is a read model, not a persisted
 * domain state; revision/generatedAt let reconnecting renderers identify the
 * authoritative snapshot they are displaying. */
export const ReviewSidebarProjection = z.object({
  revision: z.number().int().nonnegative(),
  generatedAt: z.number().int(),
  scouts: z.array(ReviewSidebarScout),
  sourceReadiness: SourceReadinessAggregate,
});
export type ReviewSidebarProjection = z.infer<typeof ReviewSidebarProjection>;

export const ReviewScoutRunCenterProjection = z.object({
  revision: z.number().int().nonnegative(),
  generatedAt: z.number().int(),
  scoutId: z.string().min(1),
  scout: ScoutSummary,
  activeRun: ScoutRunSummary.nullable(),
  latestRun: ScoutRunSummary.nullable(),
  lastRunAt: z.number().int().nullable(),
  nextRunAt: z.number().int().nullable(),
  dueRevisitCount: z.number().int().nonnegative(),
  pendingRequestCount: z.number().int().nonnegative(),
  activity: z.array(ScoutRunActivity),
  signals: z.array(SignalSummary),
  sourceAttempts: z.array(SourceAttemptSummary),
  freshLeads: z.array(LeadSummary),
  checkpoints: z.array(ScoutRunCheckpointSummary),
  recentRuns: z.array(ScoutRunSummary),
  sources: z.array(SourceSummary),
});
export type ReviewScoutRunCenterProjection = z.infer<typeof ReviewScoutRunCenterProjection>;

export const ReviewLeadScoutAttribution = z.object({
  scoutId: z.string().min(1),
  scoutName: z.string().min(1),
  signalCount: z.number().int().nonnegative(),
});
export type ReviewLeadScoutAttribution = z.infer<typeof ReviewLeadScoutAttribution>;

export const ReviewLeadPanelProjection = z.object({
  revision: z.number().int().nonnegative(),
  generatedAt: z.number().int(),
  lead: LeadSummary,
  attributions: z.array(ReviewLeadScoutAttribution),
  signals: z.array(SignalSummary),
  opportunities: z.array(OpportunitySummary),
  fitEvaluations: z.array(FitEvaluationSummary),
  investigations: z.array(InvestigationSummary),
  candidateDecisions: z.array(CandidateDecisionSummary),
  decisionState: CandidateDecisionState,
  revisitPlans: z.array(RevisitPlanSummary),
  sourceReadiness: z.array(SourceSummary),
});
export type ReviewLeadPanelProjection = z.infer<typeof ReviewLeadPanelProjection>;

export const RecruitingInvalidation = z.object({
  revision: z.number().int().nonnegative(),
  kind: z.enum(["scout", "run", "source", "lead", "review"]),
  ids: z.array(z.string()),
  reason: z.string(),
  at: z.number().int(),
});
export type RecruitingInvalidation = z.infer<typeof RecruitingInvalidation>;

export const RecruitingErrorCode = z.enum([
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "VALIDATION",
]);
export type RecruitingErrorCode = z.infer<typeof RecruitingErrorCode>;

export const ProfileFactSection = z.enum([
  "cv",
  "portfolio",
  "career_interests",
  "hard_constraints",
  "preferences",
]);
export type ProfileFactSection = z.infer<typeof ProfileFactSection>;

export const ProfileFactSource = z.enum(["cv", "github", "career_interests", "manual"]);
export type ProfileFactSource = z.infer<typeof ProfileFactSource>;

/** A reviewable assertion about the Candidate, separate from discovery Signals. */
export const ProfileFact = z.object({
  id: z.string().min(1),
  section: ProfileFactSection,
  key: z.string().min(1),
  value: z.string().min(1),
  source: ProfileFactSource,
  sourceLabel: z.string().min(1),
  sourceRef: z.string().nullable(),
  conflict: z.boolean(),
  conflictWith: z.array(z.string()),
});
export type ProfileFact = z.infer<typeof ProfileFact>;

export const ProfileSection = z.object({
  section: ProfileFactSection,
  facts: z.array(ProfileFact),
});
export type ProfileSection = z.infer<typeof ProfileSection>;

export const CandidateProfileVersion = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  versionNo: z.number().int().positive(),
  markdown: z.string(),
  facts: z.array(ProfileFact),
  provenance: z.array(z.string()),
  contentHash: z.string().min(1),
  confirmedAt: z.number().int().nullable(),
  immutable: z.literal(true),
});
export type CandidateProfileVersion = z.infer<typeof CandidateProfileVersion>;

export const CandidateProfileSummary = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  roleTarget: z.string(),
  artifactPath: z.string().min(1),
  state: z.enum(["draft", "confirmed"]),
  currentVersion: CandidateProfileVersion.nullable(),
  sections: z.array(ProfileSection),
  markdown: z.string(),
  importWarnings: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int(),
});
export type CandidateProfileSummary = z.infer<typeof CandidateProfileSummary>;
