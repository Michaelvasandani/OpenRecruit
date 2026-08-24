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
  pageCount: z.number().int().nonnegative(),
  retryAt: z.number().int().nullable(),
  safeFailure: z.string().nullable(),
  startedAt: z.number().int(),
  completedAt: z.number().int().nullable(),
});
export type SourceAttemptSummary = z.infer<typeof SourceAttemptSummary>;

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
  checkpoint: z.string().nullable(),
  safeFailure: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type ScoutRunSummary = z.infer<typeof ScoutRunSummary>;

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
