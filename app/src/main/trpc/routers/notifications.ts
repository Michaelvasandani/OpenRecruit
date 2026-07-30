import type { HostNotification } from "@shared/notify";
import { observable } from "@trpc/server/observable";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const notificationsRouter = router({
  /** Pushes each host-formatted notification to the launcher relay, which gates it
   *  (per-kind toggle, per-agent mute, window focus for wakes) and displays it (§12.4). */
  onNotify: publicProcedure.subscription(() =>
    observable<HostNotification>((emit) => {
      const off = bus.onEvent("notify", (n) => emit.next(n));
      return () => off();
    }),
  ),
});
