import {
  type AppSettings,
  DEFAULT_SETTINGS,
  type EditableAppSettings,
  FirecrawlReadiness,
  FirecrawlSafeFailure,
  type FirecrawlSettings,
  SettingsUpdate,
} from "@shared/settings";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { settings as settingsTable } from "../../db/schema";
import { bus } from "../event-bus";

const FIRECRAWL_API_KEY = "firecrawl_api_key";
const FIRECRAWL_READINESS = "firecrawl_readiness";
const FIRECRAWL_SAFE_FAILURE = "firecrawl_safe_failure";
const FIRECRAWL_CREDENTIALS_URL = "https://api.firecrawl.dev/v2/team/credit-usage";
const FIRECRAWL_PROBE_TIMEOUT_MS = 10_000;

/** The only provider response detail the credential test needs. Bodies and
 * headers are intentionally not represented, so they cannot cross this seam. */
export type FirecrawlProbeResponse = { status: number };
export type FirecrawlProbe = (apiKey: string) => Promise<FirecrawlProbeResponse>;

export type SettingsServiceOptions = {
  /** Injected at the external HTTP boundary for deterministic tests. */
  firecrawlProbe?: FirecrawlProbe;
};

/** kv keys backing each active AppSettings field. Legacy settings rows are deliberately
 * left untouched so a later migration can recover them without this API consuming them. */
const KEYS: Record<keyof EditableAppSettings, string> = {
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
  private readonly firecrawlProbe: FirecrawlProbe;

  constructor(
    private db: Db,
    options: SettingsServiceOptions = {},
  ) {
    this.firecrawlProbe = options.firecrawlProbe ?? probeFirecrawl;
  }

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
      firecrawl: this.getFirecrawlSettings(),
    };
  }

  update(patch: SettingsUpdate): AppSettings {
    const clean = SettingsUpdate.parse(patch);
    for (const [field, value] of Object.entries(clean)) {
      if (value === undefined) continue;
      const key = KEYS[field as keyof EditableAppSettings];
      if (!key) continue;
      this.write(key, serialize(value));
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

  /**
   * Return the current Firecrawl key to the host-owned provider adapter. This
   * method is deliberately absent from any router and never belongs in a
   * renderer-readable projection. The adapter reads it for every operation so
   * replacement and removal take effect without a host restart.
   */
  getFirecrawlApiKey(): string | undefined {
    return this.readRaw(FIRECRAWL_API_KEY);
  }

  /** Provider adapters must call this guard before constructing a request. */
  requireFirecrawlApiKey(): string {
    const apiKey = this.getFirecrawlApiKey();
    if (!apiKey) throw new Error("Firecrawl API key is not configured");
    return apiKey;
  }

  /** Store a Candidate-supplied key and reset any previous failure state. */
  setFirecrawlApiKey(apiKey: string): FirecrawlSettings {
    const normalized = normalizeFirecrawlApiKey(apiKey);
    this.write(FIRECRAWL_API_KEY, normalized);
    this.write(FIRECRAWL_READINESS, "ready");
    this.deleteRaw(FIRECRAWL_SAFE_FAILURE);
    this.broadcastSafeSettings();
    return this.getFirecrawlSettings();
  }

  /** Remove the key and all safe readiness details associated with it. */
  clearFirecrawlApiKey(): FirecrawlSettings {
    this.deleteRaw(FIRECRAWL_API_KEY);
    this.deleteRaw(FIRECRAWL_READINESS);
    this.deleteRaw(FIRECRAWL_SAFE_FAILURE);
    this.broadcastSafeSettings();
    return this.getFirecrawlSettings();
  }

  /**
   * Test either an explicitly supplied (unsaved) key or the currently stored
   * key. Only status is returned. Provider response bodies, headers, and the
   * credential itself never leave this host-owned service.
   */
  async testFirecrawlApiKey(input: { apiKey?: string } = {}): Promise<FirecrawlSettings> {
    const supplied =
      input.apiKey === undefined ? undefined : normalizeFirecrawlApiKey(input.apiKey);
    const apiKey = supplied ?? this.getFirecrawlApiKey();
    if (!apiKey) return firecrawlResult(false, "not_configured", null);

    let result: FirecrawlSettings;
    try {
      const response = await this.firecrawlProbe(apiKey);
      result = resultForFirecrawlStatus(response.status);
    } catch {
      result = firecrawlResult(true, "degraded", "Firecrawl is temporarily unavailable");
    }

    // Testing an unsaved draft must not mutate the saved credential's status.
    if (supplied === undefined && this.getFirecrawlApiKey() === apiKey) {
      this.write(FIRECRAWL_READINESS, result.readiness);
      if (result.safeFailure) this.write(FIRECRAWL_SAFE_FAILURE, result.safeFailure);
      else this.deleteRaw(FIRECRAWL_SAFE_FAILURE);
      this.broadcastSafeSettings();
    }
    return result;
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

  private deleteRaw(key: string): void {
    this.db.delete(settingsTable).where(eq(settingsTable.key, key)).run();
  }

  private getFirecrawlSettings(): FirecrawlSettings {
    const configured = this.getFirecrawlApiKey() !== undefined;
    if (!configured) return firecrawlResult(false, "not_configured", null);

    const readiness = FirecrawlReadiness.safeParse(this.readRaw(FIRECRAWL_READINESS));
    const safeFailure = FirecrawlSafeFailure.safeParse(this.readRaw(FIRECRAWL_SAFE_FAILURE));
    return firecrawlResult(
      true,
      readiness.success ? readiness.data : "ready",
      safeFailure.success ? safeFailure.data : null,
    );
  }

  private broadcastSafeSettings(): void {
    bus.emitEvent("settings:changed", this.get());
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

function normalizeFirecrawlApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!normalized || normalized.length > 512 || hasControlCharacter) {
    throw new Error("Firecrawl API key must be a non-empty value");
  }
  return normalized;
}

function firecrawlResult(
  configured: boolean,
  readiness: FirecrawlSettings["readiness"],
  safeFailure: FirecrawlSettings["safeFailure"],
): FirecrawlSettings {
  return { configured, readiness, safeFailure };
}

function resultForFirecrawlStatus(status: number): FirecrawlSettings {
  if (status >= 200 && status < 300) return firecrawlResult(true, "ready", null);
  if (status === 401 || status === 403) {
    return firecrawlResult(
      true,
      "reauthentication_required",
      "Firecrawl rejected the configured API key",
    );
  }
  if (status === 429) {
    return firecrawlResult(true, "rate_limited", "Firecrawl is temporarily rate limited");
  }
  if (status === 408 || status >= 500) {
    return firecrawlResult(true, "degraded", "Firecrawl is temporarily unavailable");
  }
  return firecrawlResult(true, "degraded", "Firecrawl could not verify the configured API key");
}

async function probeFirecrawl(apiKey: string): Promise<FirecrawlProbeResponse> {
  const response = await fetch(FIRECRAWL_CREDENTIALS_URL, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(FIRECRAWL_PROBE_TIMEOUT_MS),
  });
  return { status: response.status };
}
