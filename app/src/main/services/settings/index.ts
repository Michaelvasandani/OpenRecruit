import { ApprovalMode } from "@shared/agent";
import { type AppSettings, DEFAULT_SETTINGS, SettingsUpdate } from "@shared/settings";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { settings as settingsTable } from "../../db/schema";
import { bus } from "../event-bus";

/** kv keys backing each AppSettings field. `approval_timeout_sec` is shared with
 *  ApprovalService (which reads it directly), so keep that name in sync. */
const KEYS: Record<keyof AppSettings, string> = {
  approvalTimeoutSec: "approval_timeout_sec",
  pollIntervalFocusedSec: "poll_interval_focused_sec",
  pollIntervalBlurredSec: "poll_interval_blurred_sec",
  defaultApprovalMode: "default_approval_mode",
  onboardingComplete: "onboarding_complete",
  telemetryEnabled: "telemetry_enabled",
  maxHeadlessTurns: "max_headless_turns",
  notifyWakes: "notify_wakes",
  notifyOrders: "notify_orders",
  notifyApprovals: "notify_approvals",
  notifyRestricted: "notify_restricted",
  notifyUpdates: "notify_updates",
  notifyMutedAgents: "notify_muted_agents",
};

/**
 * Typed accessor over the `settings` kv table for the app's global tunables.
 * Reads coerce + fall back to `DEFAULT_SETTINGS`; `update()` validates against the
 * shared schema and broadcasts `settings:changed` so live consumers (the broker
 * poller, the renderer) re-read.
 */
export class SettingsService {
  constructor(private db: Db) {}

  get(): AppSettings {
    return {
      approvalTimeoutSec: this.readNumber(
        KEYS.approvalTimeoutSec,
        DEFAULT_SETTINGS.approvalTimeoutSec,
      ),
      pollIntervalFocusedSec: this.readNumber(
        KEYS.pollIntervalFocusedSec,
        DEFAULT_SETTINGS.pollIntervalFocusedSec,
      ),
      pollIntervalBlurredSec: this.readNumber(
        KEYS.pollIntervalBlurredSec,
        DEFAULT_SETTINGS.pollIntervalBlurredSec,
      ),
      defaultApprovalMode: this.readApprovalMode(
        KEYS.defaultApprovalMode,
        DEFAULT_SETTINGS.defaultApprovalMode,
      ),
      onboardingComplete: this.readBool(
        KEYS.onboardingComplete,
        DEFAULT_SETTINGS.onboardingComplete,
      ),
      telemetryEnabled: this.readBool(KEYS.telemetryEnabled, DEFAULT_SETTINGS.telemetryEnabled),
      maxHeadlessTurns: this.readNumber(KEYS.maxHeadlessTurns, DEFAULT_SETTINGS.maxHeadlessTurns),
      notifyWakes: this.readBool(KEYS.notifyWakes, DEFAULT_SETTINGS.notifyWakes),
      notifyOrders: this.readBool(KEYS.notifyOrders, DEFAULT_SETTINGS.notifyOrders),
      notifyApprovals: this.readBool(KEYS.notifyApprovals, DEFAULT_SETTINGS.notifyApprovals),
      notifyRestricted: this.readBool(KEYS.notifyRestricted, DEFAULT_SETTINGS.notifyRestricted),
      notifyUpdates: this.readBool(KEYS.notifyUpdates, DEFAULT_SETTINGS.notifyUpdates),
      notifyMutedAgents: this.readStringArray(
        KEYS.notifyMutedAgents,
        DEFAULT_SETTINGS.notifyMutedAgents,
      ),
    };
  }

  update(patch: SettingsUpdate): AppSettings {
    const clean = SettingsUpdate.parse(patch);
    for (const [field, value] of Object.entries(clean)) {
      if (value === undefined) continue;
      this.write(KEYS[field as keyof AppSettings], serialize(value));
    }
    const next = this.get();
    bus.emitEvent("settings:changed", next);
    return next;
  }

  /**
   * Get a persisted opaque value, generating + storing it on first access.
   * For internal kv (not part of the typed `AppSettings`) — e.g. the stable
   * local-API bearer token, which must survive restarts so baked-in PTY env
   * stays valid.
   */
  getOrCreate(key: string, factory: () => string): string {
    const existing = this.readRaw(key);
    if (existing !== undefined) return existing;
    const value = factory();
    this.write(key, value);
    return value;
  }

  /**
   * Write a raw opaque kv value (not part of the typed `AppSettings`). Companion to
   * `getOrCreate` for values the app updates over time — e.g. `last_run_version`,
   * which the host rewrites after detecting an update transition.
   */
  setRaw(key: string, value: string): void {
    this.write(key, value);
  }

  // ---- convenience for services (ms where the consumer wants ms) ----
  get pollIntervalFocusedMs(): number {
    return this.get().pollIntervalFocusedSec * 1000;
  }
  get pollIntervalBlurredMs(): number {
    return this.get().pollIntervalBlurredSec * 1000;
  }

  // ---- internals ----

  private readRaw(key: string): string | undefined {
    return this.db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()?.value;
  }

  private write(key: string, value: string) {
    this.db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
      .run();
  }

  private readNumber(key: string, fallback: number): number {
    const n = Number(this.readRaw(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  private readBool(key: string, fallback: boolean): boolean {
    const v = this.readRaw(key);
    if (v === undefined) return fallback;
    return v === "1" || v === "true";
  }

  private readApprovalMode(key: string, fallback: AppSettings["defaultApprovalMode"]) {
    const parsed = ApprovalMode.safeParse(this.readRaw(key));
    return parsed.success ? parsed.data : fallback;
  }

  private readStringArray(key: string, fallback: string[]): string[] {
    const raw = this.readRaw(key);
    if (raw === undefined) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
        ? (parsed as string[])
        : fallback;
    } catch {
      return fallback;
    }
  }
}

function serialize(value: unknown): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}
