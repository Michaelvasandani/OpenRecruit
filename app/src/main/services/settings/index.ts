import { type AppSettings, DEFAULT_SETTINGS, SettingsUpdate } from "@shared/settings";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { settings as settingsTable } from "../../db/schema";
import { bus } from "../event-bus";

/** kv keys backing each active AppSettings field. Legacy settings rows are deliberately
 * left untouched so a later migration can recover them without this API consuming them. */
const KEYS: Record<keyof AppSettings, string> = {
  onboardingComplete: "onboarding_complete",
  telemetryEnabled: "telemetry_enabled",
  headlessTurnLimitEnabled: "headless_turn_limit_enabled",
  maxHeadlessTurns: "max_headless_turns",
  maxHeadlessRunMinutes: "max_headless_run_minutes",
  backgroundAllowApiKey: "background_allow_api_key",
  notifyWakes: "notify_wakes",
  notifyRestricted: "notify_restricted",
  notifyUpdates: "notify_updates",
  notifyMutedAgents: "notify_muted_agents",
  showInMenuBar: "show_in_menu_bar",
};

/**
 * Typed accessor over the `settings` kv table for the app's global tunables.
 * Reads coerce + fall back to `DEFAULT_SETTINGS`; `update()` validates against the
 * shared schema and broadcasts `settings:changed` so live consumers and the
 * renderer re-read.
 */
export class SettingsService {
  constructor(private db: Db) {}

  get(): AppSettings {
    return {
      onboardingComplete: this.readBool(
        KEYS.onboardingComplete,
        DEFAULT_SETTINGS.onboardingComplete,
      ),
      telemetryEnabled: this.readBool(KEYS.telemetryEnabled, DEFAULT_SETTINGS.telemetryEnabled),
      headlessTurnLimitEnabled: this.readBool(
        KEYS.headlessTurnLimitEnabled,
        DEFAULT_SETTINGS.headlessTurnLimitEnabled,
      ),
      maxHeadlessTurns: this.readNumber(KEYS.maxHeadlessTurns, DEFAULT_SETTINGS.maxHeadlessTurns),
      maxHeadlessRunMinutes: this.readNumber(
        KEYS.maxHeadlessRunMinutes,
        DEFAULT_SETTINGS.maxHeadlessRunMinutes,
      ),
      backgroundAllowApiKey: this.readBool(
        KEYS.backgroundAllowApiKey,
        DEFAULT_SETTINGS.backgroundAllowApiKey,
      ),
      notifyWakes: this.readBool(KEYS.notifyWakes, DEFAULT_SETTINGS.notifyWakes),
      notifyRestricted: this.readBool(KEYS.notifyRestricted, DEFAULT_SETTINGS.notifyRestricted),
      notifyUpdates: this.readBool(KEYS.notifyUpdates, DEFAULT_SETTINGS.notifyUpdates),
      notifyMutedAgents: this.readStringArray(
        KEYS.notifyMutedAgents,
        DEFAULT_SETTINGS.notifyMutedAgents,
      ),
      showInMenuBar: this.readBool(KEYS.showInMenuBar, DEFAULT_SETTINGS.showInMenuBar),
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
