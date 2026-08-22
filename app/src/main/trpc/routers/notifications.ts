import type { HostNotification, RecentNotification } from "@shared/notify";
import { observable } from "@trpc/server/observable";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const notificationsRouter = router({
  /** Pushes each host-formatted notification to the launcher relay, which gates it
   *  (per-kind toggle, per-agent mute, window focus for wakes) and displays it (§12.4).
   *  Deliberately carries NO backlog on subscribe: a relay reconnect must not re-fire
   *  banners for events the user already saw. The tray's Recent uses `onRecent` below. */
  onNotify: publicProcedure.subscription(() =>
    observable<HostNotification>((emit) => {
      const off = bus.onEvent("notify", (n) => emit.next(n));
      return () => off();
    }),
  ),

  /** The durable Recent ring buffer (§12.6), newest first: the full list on subscribe
   *  and again on every change. Emit-on-subscribe (like `settings.onChanged`) is what
   *  makes the tray self-heal across a relay reconnect — and, because the buffer is
   *  persisted, repopulate after a launcher or host restart. */
  onRecent: publicProcedure.subscription(({ ctx }) =>
    observable<RecentNotification[]>((emit) => {
      emit.next(ctx.recent.list());
      const off = bus.onEvent("notifications:recent", (list) => emit.next(list));
      return () => off();
    }),
  ),
});
