import { type AppSettings, SettingsUpdate } from "@shared/settings";
import { observable } from "@trpc/server/observable";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const settingsRouter = router({
  get: publicProcedure.query(({ ctx }) => ctx.settings.get()),

  update: publicProcedure.input(SettingsUpdate).mutation(({ ctx, input }) => {
    const wasEnabled = ctx.settings.get().headlessTurnLimitEnabled;
    const next = ctx.settings.update(input);
    // Re-enabling the global turn limit (off → on) is a clean slate: reset every agent's
    // count and turn the per-agent limit back on, so re-enabling doesn't instantly pause
    // agents whose counts are stale from before (§12.2). This mutation is the only writer
    // of this setting, so the transition is reliably caught here.
    if (!wasEnabled && next.headlessTurnLimitEnabled) ctx.registry.resetAllTurnBudgets();
    return next;
  }),

  /** Pushes the full settings object on connect and on every change. */
  onChanged: publicProcedure.subscription(({ ctx }) =>
    observable<AppSettings>((emit) => {
      emit.next(ctx.settings.get());
      const off = bus.onEvent("settings:changed", (s) => emit.next(s));
      return () => off();
    }),
  ),
});
