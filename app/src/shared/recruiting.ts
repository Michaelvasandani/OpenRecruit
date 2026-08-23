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
  defaultProfileId: z.string().nullable(),
  lifecycleState: ScoutLifecycle,
  resumableSessionRef: z.string().nullable(),
  legacyAgentId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int(),
});
export type ScoutSummary = z.infer<typeof ScoutSummary>;

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
