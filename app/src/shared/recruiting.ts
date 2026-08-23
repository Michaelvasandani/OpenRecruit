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
