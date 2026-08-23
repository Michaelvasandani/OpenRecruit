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
        defaultProfileId: z.string().nullable().optional(),
        resumableSessionRef: z.string().nullable().optional(),
        idempotencyKey: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => command(() => ctx.recruiting.createScout(input))),

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
