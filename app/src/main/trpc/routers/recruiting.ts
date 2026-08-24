import {
  ProfileFactSection,
  ProfileFactSource,
  type RecruitingInvalidation,
  ScoutHarness,
} from "@shared/recruiting";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { RecruitingError } from "../../services/recruiting";
import { publicProcedure, router } from "../trpc";

export const recruitingRouter = router({
  scouts: publicProcedure.query(({ ctx }) => ctx.recruiting.listScouts()),

  profiles: publicProcedure.query(({ ctx }) => ctx.recruiting.listProfiles()),

  profile: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getProfile(input.id)),

  profileVersions: publicProcedure
    .input(z.object({ profileId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.listProfileVersions(input.profileId)),

  profileVersion: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getProfileVersion(input.id)),

  scout: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getScout(input.id)),

  createScout: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(120),
        harness: ScoutHarness,
        instructionPath: z.string().min(1),
        strategyPath: z.string().nullable().optional(),
        strategyMaterial: z.string().max(100_000).optional(),
        policyMaterial: z.string().max(100_000).optional(),
        sourceIds: z.array(z.string().min(1)).max(100).optional(),
        defaultProfileId: z.string().nullable().optional(),
        resumableSessionRef: z.string().nullable().optional(),
        idempotencyKey: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.createScout(input))),

  updateScout: publicProcedure
    .input(
      z.object({
        scoutId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative(),
        name: z.string().trim().min(1).max(120).optional(),
        instructionPath: z.string().trim().min(1).optional(),
        strategyPath: z.string().nullable().optional(),
        strategyMaterial: z.string().max(100_000).optional(),
        policyMaterial: z.string().max(100_000).optional(),
        defaultProfileId: z.string().nullable().optional(),
        sourceIds: z.array(z.string().min(1)).max(100).optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.updateScout(input))),

  sources: publicProcedure.query(({ ctx }) => ctx.recruiting.listSources()),

  source: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getSource(input.id)),

  createSource: publicProcedure
    .input(
      z.object({
        kind: z.string().trim().min(1).max(40),
        name: z.string().trim().min(1).max(160),
        config: z.record(z.string(), z.unknown()).optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.createSource(input))),

  createRssSource: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(160),
        url: z.string().trim().url().max(2_000),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.createRssSource(input))),

  createFeedSource: publicProcedure
    .input(
      z.object({
        kind: z.enum(["rss", "atom"]),
        name: z.string().trim().min(1).max(160),
        url: z.string().trim().url().max(2_000),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.createFeedSource(input))),

  sourceAccess: publicProcedure
    .input(z.object({ sourceId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getSourceAccess(input.sourceId)),

  setSourceDisabled: publicProcedure
    .input(z.object({ sourceId: z.string().min(1), disabled: z.boolean() }))
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.setSourceDisabled(input))),

  checkSourceReadiness: publicProcedure
    .input(z.object({ sourceId: z.string().min(1) }))
    .mutation(({ ctx, input }) => commandAsync(() => ctx.recruiting.checkSourceReadiness(input))),

  setScoutSources: publicProcedure
    .input(
      z.object({
        scoutId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative(),
        sourceIds: z.array(z.string().min(1)).max(100),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.setScoutSources(input))),

  scoutRuns: publicProcedure
    .input(z.object({ scoutId: z.string().min(1).optional() }).optional())
    .query(({ ctx, input }) => ctx.recruiting.listScoutRuns(input?.scoutId)),

  scoutRun: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getScoutRun(input.id)),

  sourceAttempts: publicProcedure
    .input(z.object({ runId: z.string().min(1).optional() }).optional())
    .query(({ ctx, input }) => ctx.recruiting.listSourceAttempts(input?.runId)),

  sourceAttempt: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getSourceAttempt(input.id)),

  signals: publicProcedure
    .input(
      z
        .object({
          runId: z.string().min(1).optional(),
          sourceId: z.string().min(1).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.recruiting.listSignals(input)),

  signal: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getSignal(input.id)),

  leads: publicProcedure.query(({ ctx }) => ctx.recruiting.listLeads()),

  lead: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getLead(input.id)),

  leadContext: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.recruiting.getLeadContext(input.id)),

  readSource: publicProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        sourceId: z.string().min(1),
        budget: z
          .object({
            maxItems: z.number().int().positive().max(10_000_000).optional(),
            maxPages: z.number().int().positive().max(10_000_000).optional(),
            maxWallClockMs: z.number().int().positive().max(10_000_000).optional(),
            maxSpendCents: z.number().int().nonnegative().max(10_000_000).optional(),
          })
          .optional(),
        retry: z
          .object({
            maxAttempts: z.number().int().positive().max(3).optional(),
            baseDelayMs: z.number().int().positive().max(60_000).optional(),
          })
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => commandAsync(() => ctx.recruiting.readSource(input))),

  launchScoutRun: publicProcedure
    .input(
      z.object({
        scoutId: z.string().min(1),
        profileOverrideId: z.string().nullable().optional(),
        strategyOverride: z.string().max(100_000).nullable().optional(),
        policyOverride: z.string().max(100_000).nullable().optional(),
        budget: z
          .object({
            maxItems: z.number().int().positive().max(10_000_000).optional(),
            maxPages: z.number().int().positive().max(10_000_000).optional(),
            maxWallClockMs: z.number().int().positive().max(10_000_000).optional(),
            maxSpendCents: z.number().int().nonnegative().max(10_000_000).optional(),
          })
          .optional(),
        trigger: z
          .enum(["manual", "scheduled", "source_event", "revisit", "explicit_request"])
          .optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.launchScoutRun(input))),

  /** Provider-neutral adapter seam: all execution starts from the same bounded preflight. */
  runScout: publicProcedure
    .input(
      z.object({
        scoutId: z.string().min(1),
        profileOverrideId: z.string().nullable().optional(),
        strategyOverride: z.string().max(100_000).nullable().optional(),
        policyOverride: z.string().max(100_000).nullable().optional(),
        budget: z.record(z.string(), z.number().int().nonnegative()).optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.runScout(input))),

  advanceScoutRun: publicProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        status: z.enum([
          "queued",
          "preflight",
          "running",
          "finalizing",
          "completed",
          "incomplete",
          "failed",
          "cancelled",
        ]),
        phase: z.enum(["preflight", "discovery", "finalization"]).optional(),
        checkpoint: z.string().max(100_000).nullable().optional(),
        safeFailure: z.string().max(10_000).nullable().optional(),
        expectedStatus: z
          .enum([
            "queued",
            "preflight",
            "running",
            "finalizing",
            "completed",
            "incomplete",
            "failed",
            "cancelled",
          ])
          .optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.advanceScoutRun(input))),

  importProfile: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(160),
        roleTarget: z.string().trim().min(1).max(160),
        cvPath: z.string().min(1).optional(),
        cvText: z.string().optional(),
        github: z
          .union([
            z.string().min(1),
            z.object({
              url: z.string().min(1).optional(),
              handle: z.string().min(1).optional(),
              facts: z
                .array(
                  z.object({
                    section: z.literal("portfolio").optional(),
                    key: z.string().min(1),
                    value: z.string().min(1),
                    sourceRef: z.string().min(1).optional(),
                  }),
                )
                .optional(),
            }),
          ])
          .optional(),
        careerInterests: z.string().max(10_000),
        hardConstraints: z.array(z.string().min(1).max(500)).max(100).optional(),
        preferences: z.array(z.string().min(1).max(500)).max(100).optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.importProfile(input))),

  updateProfileDraft: publicProcedure
    .input(
      z.object({
        profileId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative(),
        removeFactIds: z.array(z.string().min(1)).optional(),
        addFacts: z
          .array(
            z.object({
              id: z.string().min(1).optional(),
              section: ProfileFactSection,
              key: z.string().min(1),
              value: z.string().min(1),
              source: ProfileFactSource,
              sourceLabel: z.string().min(1),
              sourceRef: z.string().nullable().optional(),
            }),
          )
          .optional(),
        replaceFacts: z
          .array(
            z.object({
              id: z.string().min(1).optional(),
              section: ProfileFactSection,
              key: z.string().min(1),
              value: z.string().min(1),
              source: ProfileFactSource,
              sourceLabel: z.string().min(1),
              sourceRef: z.string().nullable().optional(),
            }),
          )
          .optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.updateProfileDraft(input))),

  deleteProfileContent: publicProcedure
    .input(
      z.object({
        profileId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative(),
        removeFactIds: z.array(z.string().min(1)).min(1),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.deleteProfileContent(input))),

  confirmProfile: publicProcedure
    .input(
      z.object({
        profileId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.confirmProfile(input))),

  archiveScout: publicProcedure
    .input(
      z.object({
        scoutId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative(),
        idempotencyKey: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.archiveScout(input))),

  revision: publicProcedure.query(({ ctx }) => ctx.recruiting.revision()),

  onChanged: publicProcedure.subscription(({ ctx }) =>
    observable<RecruitingInvalidation>((emit) => {
      emit.next({
        revision: ctx.recruiting.revision(),
        kind: "review",
        ids: [],
        reason: "resync",
        at: Date.now(),
      });
      return bus.onEvent("recruiting:changed", (event) => emit.next(event));
    }),
  ),
});

function command<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RecruitingError) {
      throw new TRPCError({
        code: error.code === "CONFLICT" ? "CONFLICT" : "BAD_REQUEST",
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

async function commandAsync<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RecruitingError) {
      throw new TRPCError({
        code: error.code === "CONFLICT" ? "CONFLICT" : "BAD_REQUEST",
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}
