import type { Agent } from "@shared/agent";
import { CreateAgentInput, compileScoutSetup, scoutCadenceCron } from "@shared/agent";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const agentsRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.registry.list()),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => ctx.registry.get(input.id) ?? null),

  /** The default composed CLAUDE.md for a template — seeds the New Agent dialog's
   *  editable text field; the (possibly edited) result rides back on `create`. */
  templateClaudeMd: publicProcedure
    .input(z.object({ template: z.string() }))
    .query(({ ctx, input }) => ctx.registry.templateClaudeMd(input.template)),

  create: publicProcedure.input(CreateAgentInput).mutation(({ ctx, input }) => {
    const compiled = input.scoutSetup ? compileScoutSetup(input.scoutSetup) : null;
    const agent = ctx.registry.create({
      ...input,
      claudeMd: compiled?.instructions ?? input.claudeMd,
    });
    try {
      ctx.recruiting.createScout({
        name: agent.name,
        harness: agent.harness,
        instructionPath: `agents/${agent.slug}`,
        strategyMaterial: compiled?.strategyMaterial,
        policyMaterial: compiled?.policyMaterial,
        sourceIds: input.scoutSetup?.sourceIds,
        defaultProfileId: input.defaultProfileId ?? null,
        resumableSessionRef: agent.lastSessionId,
        legacyAgentId: agent.id,
        idempotencyKey: `local-agent:${agent.id}`,
      });
      if (input.scoutSetup) {
        const cron = scoutCadenceCron(input.scoutSetup);
        if (cron) {
          ctx.scheduler.createCron(agent.id, {
            cron,
            prompt:
              "Run the configured Scout discovery cycle now. Read the pinned context and selected Sources, use only their read-only discovery tools, record relevant evidence and checkpoints, and complete the Run explicitly.",
            recurring: true,
          });
        }
      }
    } catch (error) {
      // Composite creation is all-or-nothing from the Candidate's perspective.
      // Retire a schedule or Scout that was created before a later step failed,
      // then remove the freshly scaffolded harness.
      try {
        ctx.scheduler.removeAgent?.(agent.id);
      } catch {
        // Preserve the original creation error; cleanup is best effort.
      }
      const scoutId = ctx.recruiting.resolveScoutForAgent(agent.id);
      const scout = scoutId ? ctx.recruiting.getScout(scoutId) : null;
      if (scout?.lifecycleState === "active") {
        try {
          ctx.recruiting.archiveScout({
            scoutId: scout.id,
            expectedRevision: scout.revision,
            idempotencyKey: `failed-local-agent:${agent.id}`,
          });
        } catch {
          // Preserve the original creation error; cleanup is best effort.
        }
      }
      if (scoutId) {
        // The archived Scout retains a foreign-key reference for auditability,
        // so retire the harness row instead of trying to hard-delete it.
        ctx.registry.archive(agent.id);
      } else {
        ctx.registry.discardFailedCreation(agent.id);
      }
      throw error;
    }
    return agent;
  }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        turnLimitEnabled: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.registry.update(input.id, input) ?? null),

  /** Zero the agent's headless turn budget — the turn-limit button's Reset control, the
   *  budget's only refill path. */
  resetTurnLimit: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
    ctx.registry.resetHeadlessTurns(input.id);
    return { ok: true };
  }),

  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
    // Tear down the live PTY before dropping the agent from the list, so the
    // daemon isn't left running an orphaned `claude` for a deleted agent.
    ctx.terminal.kill(input.id);
    // Kill any in-flight headless wake + clear its queued/warm wakes, so an archived
    // agent can't keep running (the headless `archivedAt` guard only checks at spawn).
    ctx.wake.stop(input.id);
    // Disarm + delete the agent's schedules/monitors so nothing keeps firing.
    ctx.scheduler.removeAgent(input.id);
    ctx.registry.archive(input.id);
    return { ok: true };
  }),

  /** Pushes the full agent list (with statuses) on every change. */
  onChanged: publicProcedure.subscription(({ ctx }) =>
    observable<Agent[]>((emit) => {
      emit.next(ctx.registry.list());
      const off = bus.onEvent("agents:changed", (list) => emit.next(list));
      return () => off();
    }),
  ),
});
