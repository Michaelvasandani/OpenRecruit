import type { HostNotification, HostNotificationKind, RecentNotification } from "@shared/notify";
import { desc, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { recentNotifications } from "../../db/schema";
import { hostLog } from "../../host/log";
import { bus } from "../event-bus";

/** How many events the ring buffer keeps — exactly what the tray's Recent shows. */
export const RECENT_MAX = 10;

/**
 * Durable ring buffer of the last `RECENT_MAX` notify events, backing the tray's
 * Recent submenu (§12.6).
 *
 * It subscribes to the **raw** `notify` bus, i.e. *before* the launcher's gating
 * (per-kind toggle, per-agent mute, wake focus rule): muting a banner suppresses an
 * interruption, it shouldn't blind the monitor you deliberately opened. The bus
 * payload carries no timestamp, so this is where `at` is stamped.
 *
 * Persisted rather than held in memory so Recent survives a launcher quit *and* a
 * host restart/reboot — the tray is most useful precisely when the app has been
 * closed for a while. It is a ring buffer, not a log: displaced rows are deleted.
 */
export class RecentNotificationsService {
  constructor(private db: Db) {}

  /**
   * Start recording. Must be wired BEFORE any service that can emit `notify` runs —
   * the scheduler's boot catch-up sweep fires synchronously during `start()`.
   * Returns an unsubscribe fn (used by tests; the host keeps it for its lifetime).
   */
  start(): () => void {
    return bus.onEvent("notify", (n) => this.record(n));
  }

  /**
   * Stamp, append, prune beyond the cap, and publish the new list.
   *
   * Never throws: this is the first listener on the raw `notify` bus, which the bus
   * does not isolate, so a DB error escaping here would propagate into the emitter —
   * the scheduler firing a wake, the broker's ledger sync, the approval gate — and
   * skip every later listener. A missing Recent row is not worth risking those.
   */
  record(n: HostNotification, at: number = Date.now()): void {
    try {
      this.write(n, at);
    } catch (err) {
      hostLog.error("failed to record recent notification", String(err));
    }
  }

  private write(n: HostNotification, at: number): void {
    this.db
      .insert(recentNotifications)
      .values({
        kind: n.kind,
        title: n.title,
        body: n.body,
        agentId: n.agentId ?? null,
        at,
      })
      .run();
    // Keep only the newest RECENT_MAX. The host is the single writer and these run
    // back-to-back synchronously, so no transaction is needed (cf. AuditLog.append).
    const keep = this.db
      .select({ id: recentNotifications.id })
      .from(recentNotifications)
      .orderBy(desc(recentNotifications.id))
      .limit(RECENT_MAX)
      .all()
      .map((r) => r.id);
    this.db.delete(recentNotifications).where(notInArray(recentNotifications.id, keep)).run();
    bus.emitEvent("notifications:recent", this.list());
  }

  /** Newest first, at most `RECENT_MAX`. */
  list(): RecentNotification[] {
    return this.db
      .select()
      .from(recentNotifications)
      .orderBy(desc(recentNotifications.id))
      .limit(RECENT_MAX)
      .all()
      .map((r) => ({
        kind: r.kind as HostNotificationKind,
        title: r.title,
        body: r.body,
        ...(r.agentId ? { agentId: r.agentId } : {}),
        at: r.at,
      }));
  }
}
