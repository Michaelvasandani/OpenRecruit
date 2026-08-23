import { type RecruitingInvalidation, ScoutHarness } from "@shared/recruiting";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { RecruitingError } from "../../services/recruiting";
import { publicProcedure, router } from "../trpc";

export const recruitingRouter = router({
  scouts: publicProcedure.query(({ ctx }) => ctx.recruiting.listScouts()),

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
