import { isAbsolute } from "node:path";
import {
  type AppSettings,
  type BirdAccountIdentity,
  BirdReadiness,
  type BirdSettings,
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
import {
  BIRD_SUPPORTED_VERSION,
  BIRD_WARNINGS,
  type BirdExecutableIdentity,
  type BirdProbeResult,
  inspectBirdExecutable,
  probeBirdExecutable,
} from "./bird";

const FIRECRAWL_API_KEY = "firecrawl_api_key";
const FIRECRAWL_READINESS = "firecrawl_readiness";
const FIRECRAWL_SAFE_FAILURE = "firecrawl_safe_failure";
const FIRECRAWL_CREDENTIALS_URL = "https://api.firecrawl.dev/v2/team/credit-usage";
const FIRECRAWL_PROBE_TIMEOUT_MS = 10_000;
const BIRD_PATH = "bird_path";
const BIRD_TESTED_PATH = "bird_tested_path";
const BIRD_RESOLVED_PATH = "bird_resolved_path";
const BIRD_FINGERPRINT = "bird_fingerprint";
const BIRD_DETECTED_VERSION = "bird_detected_version";
const BIRD_ACCOUNT_IDENTITY = "bird_account_identity";
const BIRD_READINESS = "bird_readiness";
const BIRD_SAFE_FAILURE = "bird_safe_failure";
const BIRD_CONSENT = "bird_consent";
const BIRD_CONSENTED_AT = "bird_consented_at";

/** The only provider response detail the credential test needs. Bodies and
 * headers are intentionally not represented, so they cannot cross this seam. */
export type FirecrawlProbeResponse = { status: number };
export type FirecrawlProbe = (apiKey: string) => Promise<FirecrawlProbeResponse>;
export type BirdProbe = (configuredPath: string) => Promise<BirdProbeResult>;

export type BirdConsentBinding = {
  configuredPath: string;
  resolvedPath: string;
  fingerprint: string;
  version: string;
  accountIdentity: BirdAccountIdentity;
};

/** Host-only binding consumed by a future Bird Source provider. */
export type BirdAccess = BirdConsentBinding;

export type SettingsServiceOptions = {
  /** Injected at the external HTTP boundary for deterministic tests. */
  firecrawlProbe?: FirecrawlProbe;
  /** Injected at the local executable boundary for settings tests. Production
   * uses the real Bird executable and the allowlisted setup commands. */
  birdProbe?: BirdProbe;
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
  private readonly birdProbe: BirdProbe;

  constructor(
    private db: Db,
    options: SettingsServiceOptions = {},
  ) {
    this.firecrawlProbe = options.firecrawlProbe ?? probeFirecrawl;
    this.birdProbe = options.birdProbe ?? probeBirdExecutable;
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
      bird: this.getBirdSettings(),
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

  /** The effective Bird path is host configuration. A development/test
   * override takes precedence but is never copied into a Scout or Source. */
  getBirdExecutablePath(): string | undefined {
    return effectiveBirdPath(this.readRaw(BIRD_PATH));
  }

  /** Internal host-only access for a future Bird Source provider. The returned
   * binding contains no cookies, tokens, raw command output, or browser paths. */
  getBirdAccess(): BirdAccess | null {
    const settings = this.getBirdSettings();
    if (!settings.consentCurrent) return null;
    const binding = readBirdConsent(this.readRaw(BIRD_CONSENT));
    return binding ? { ...binding } : null;
  }

  /** Persist a Candidate-entered absolute path. Saving a replacement always
   * clears the previous test and consent so it cannot inherit approval. */
  setBirdPath(configuredPath: string): BirdSettings {
    const normalized = normalizeBirdPathForSettings(configuredPath);
    this.write(BIRD_PATH, normalized);
    this.clearBirdProbeMetadata();
    this.broadcastSafeSettings();
    return this.getBirdSettings();
  }

  /** Remove the configured Bird path, readiness metadata, and consent. Source
   * Attempts and Signals are recruiting history and are intentionally untouched. */
  clearBird(): BirdSettings {
    for (const key of [
      BIRD_PATH,
      BIRD_TESTED_PATH,
      BIRD_RESOLVED_PATH,
      BIRD_FINGERPRINT,
      BIRD_DETECTED_VERSION,
      BIRD_ACCOUNT_IDENTITY,
      BIRD_READINESS,
      BIRD_SAFE_FAILURE,
      BIRD_CONSENT,
      BIRD_CONSENTED_AT,
    ]) {
      this.deleteRaw(key);
    }
    this.broadcastSafeSettings();
    return this.getBirdSettings();
  }

  /** Test a draft path without saving it, or test the effective saved/override
   * path when omitted. Only safe metadata from the probe is persisted/returned. */
  async testBird(input: { path?: string } = {}): Promise<BirdSettings> {
    const supplied = input.path === undefined ? undefined : input.path;
    const path = supplied === undefined ? this.getBirdExecutablePath() : safeDraftPath(supplied);
    if (!path) return birdNotConfiguredResult();

    if (supplied !== undefined) {
      try {
        normalizeBirdPathForSettings(path);
      } catch {
        return birdSettingsFromProbe(
          {
            configuredPath: path,
            resolvedPath: "",
            fingerprint: "",
            readiness: "invalid_path",
            safeFailure: "Bird executable path must be an absolute path",
            detectedVersion: null,
            accountIdentity: null,
          },
          false,
          null,
        );
      }
    }

    let result: BirdProbeResult;
    try {
      result = await this.birdProbe(path);
    } catch {
      result = {
        configuredPath: path,
        resolvedPath: "",
        fingerprint: "",
        readiness: "degraded",
        safeFailure: "Bird could not be tested safely",
        detectedVersion: null,
        accountIdentity: null,
      };
    }

    // Draft tests never alter the saved path, metadata, or consent. A saved
    // result is applied only if the effective path did not change mid-probe.
    if (supplied !== undefined) return birdSettingsFromProbe(result, false, null);
    if (this.getBirdExecutablePath() !== path) return this.getBirdSettings();
    this.persistBirdProbe(result);
    this.broadcastSafeSettings();
    return this.getBirdSettings();
  }

  /** Bind Candidate consent to every inspected identity component. */
  confirmBirdConsent(): BirdSettings {
    const current = this.getBirdSettings();
    const path = this.getBirdExecutablePath();
    const testedPath = this.readRaw(BIRD_TESTED_PATH);
    const resolvedPath = this.readRaw(BIRD_RESOLVED_PATH);
    const fingerprint = this.readRaw(BIRD_FINGERPRINT);
    const version = this.readRaw(BIRD_DETECTED_VERSION);
    const accountIdentity = parseBirdAccount(this.readRaw(BIRD_ACCOUNT_IDENTITY));
    if (
      !path ||
      current.readiness !== "ready" ||
      !current.accountIdentity ||
      !accountIdentity ||
      testedPath !== path ||
      !resolvedPath ||
      !fingerprint ||
      version !== BIRD_SUPPORTED_VERSION
    ) {
      throw new Error("Test a supported Bird executable and account before confirming consent");
    }
    // Hashing and resolving again catches replacement between Test and Confirm.
    let inspected: BirdExecutableIdentity;
    try {
      inspected = inspectBirdExecutable(path);
    } catch {
      throw new Error("The Bird executable changed or is no longer available; test it again");
    }
    if (
      inspected.resolvedPath !== resolvedPath ||
      inspected.fingerprint !== fingerprint ||
      !sameAccountIdentity(accountIdentity, current.accountIdentity)
    ) {
      throw new Error("The tested Bird executable or account changed; test it again");
    }
    this.write(
      BIRD_CONSENT,
      JSON.stringify({
        configuredPath: path,
        resolvedPath,
        fingerprint,
        version,
        accountIdentity,
      } satisfies BirdConsentBinding),
    );
    this.write(BIRD_CONSENTED_AT, String(Date.now()));
    this.broadcastSafeSettings();
    return this.getBirdSettings();
  }

  // ---- Bird internals ----

  private persistBirdProbe(result: BirdProbeResult): void {
    this.clearRawBirdConsent();
    this.write(BIRD_TESTED_PATH, result.configuredPath);
    if (result.resolvedPath) this.write(BIRD_RESOLVED_PATH, result.resolvedPath);
    else this.deleteRaw(BIRD_RESOLVED_PATH);
    const fingerprint = sanitizeFingerprint(result.fingerprint);
    if (fingerprint) this.write(BIRD_FINGERPRINT, fingerprint);
    else this.deleteRaw(BIRD_FINGERPRINT);
    const detectedVersion = sanitizeDetectedVersion(result.detectedVersion);
    if (detectedVersion) this.write(BIRD_DETECTED_VERSION, detectedVersion);
    else this.deleteRaw(BIRD_DETECTED_VERSION);
    const accountIdentity = sanitizeAccountIdentity(result.accountIdentity);
    if (accountIdentity) this.write(BIRD_ACCOUNT_IDENTITY, JSON.stringify(accountIdentity));
    else this.deleteRaw(BIRD_ACCOUNT_IDENTITY);
    const readiness = BirdReadiness.safeParse(result.readiness);
    const safeReadiness = readiness.success ? readiness.data : "degraded";
    this.write(BIRD_READINESS, safeReadiness);
    const safeFailure = safeBirdFailure(safeReadiness, result.safeFailure, detectedVersion);
    if (safeFailure) this.write(BIRD_SAFE_FAILURE, safeFailure);
    else this.deleteRaw(BIRD_SAFE_FAILURE);
  }

  private clearBirdProbeMetadata(): void {
    for (const key of [
      BIRD_TESTED_PATH,
      BIRD_RESOLVED_PATH,
      BIRD_FINGERPRINT,
      BIRD_DETECTED_VERSION,
      BIRD_ACCOUNT_IDENTITY,
      BIRD_READINESS,
      BIRD_SAFE_FAILURE,
    ]) {
      this.deleteRaw(key);
    }
    this.clearRawBirdConsent();
  }

  private clearRawBirdConsent(): void {
    this.deleteRaw(BIRD_CONSENT);
    this.deleteRaw(BIRD_CONSENTED_AT);
  }

  private getBirdSettings(): BirdSettings {
    const path = this.getBirdExecutablePath();
    if (!path) return birdNotConfiguredResult();

    const testedPath = this.readRaw(BIRD_TESTED_PATH);
    const tested = testedPath === path;
    const storedVersion = sanitizeDetectedVersion(this.readRaw(BIRD_DETECTED_VERSION) ?? null);
    const storedFingerprint = sanitizeFingerprint(this.readRaw(BIRD_FINGERPRINT) ?? "");
    const storedResolvedPath = this.readRaw(BIRD_RESOLVED_PATH) ?? null;
    const storedAccount = parseBirdAccount(this.readRaw(BIRD_ACCOUNT_IDENTITY));
    const storedReadiness = BirdReadiness.safeParse(this.readRaw(BIRD_READINESS));
    const storedSafeFailure = safeBirdFailure(
      storedReadiness.success ? storedReadiness.data : "degraded",
      this.readRaw(BIRD_SAFE_FAILURE),
      storedVersion,
    );

    if (!tested || !storedReadiness.success) {
      return {
        ...birdNotConfiguredResult(),
        configured: true,
        configuredPath: path,
      };
    }

    let executableMatches = true;
    if (storedResolvedPath && storedFingerprint) {
      try {
        const currentExecutable = inspectBirdExecutable(path);
        executableMatches =
          currentExecutable.resolvedPath === storedResolvedPath &&
          currentExecutable.fingerprint === storedFingerprint;
      } catch {
        executableMatches = false;
      }
    }
    const consent = readBirdConsent(this.readRaw(BIRD_CONSENT));
    const consentedAt = parseTimestamp(this.readRaw(BIRD_CONSENTED_AT));
    const identityMatches =
      consent && storedAccount
        ? sameAccountIdentity(consent.accountIdentity, storedAccount)
        : false;
    const consentCurrent =
      executableMatches &&
      identityMatches &&
      !!consent &&
      consent.configuredPath === path &&
      consent.resolvedPath === storedResolvedPath &&
      consent.fingerprint === storedFingerprint &&
      consent.version === storedVersion &&
      storedVersion === BIRD_SUPPORTED_VERSION;

    let readiness = storedReadiness.data;
    let safeFailure = storedSafeFailure;
    if (!executableMatches && readiness === "ready") {
      readiness = "degraded";
      safeFailure = "The Bird executable changed since it was tested";
    }
    return {
      configured: true,
      configuredPath: path,
      readiness,
      safeFailure,
      detectedVersion: storedVersion,
      fingerprintSummary: storedFingerprint ? fingerprintSummary(storedFingerprint) : null,
      accountIdentity: storedAccount,
      consentCurrent,
      consentedAt: consentCurrent ? consentedAt : null,
      invalidSignatureWarning: BIRD_WARNINGS.invalidSignature,
      cookieAccessWarning: BIRD_WARNINGS.cookieAccess,
    };
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

function birdNotConfiguredResult(): BirdSettings {
  return {
    ...DEFAULT_SETTINGS.bird,
    configured: false,
    configuredPath: null,
  };
}

function birdSettingsFromProbe(
  result: BirdProbeResult,
  consentCurrent: boolean,
  consentedAt: number | null,
): BirdSettings {
  const accountIdentity = sanitizeAccountIdentity(result.accountIdentity);
  const detectedVersion = sanitizeDetectedVersion(result.detectedVersion);
  const fingerprint = sanitizeFingerprint(result.fingerprint);
  const readiness = BirdReadiness.safeParse(result.readiness);
  const safeReadiness = readiness.success ? readiness.data : "degraded";
  return {
    configured: Boolean(result.configuredPath),
    configuredPath: result.configuredPath || null,
    readiness: safeReadiness,
    safeFailure: safeBirdFailure(safeReadiness, result.safeFailure, detectedVersion),
    detectedVersion,
    fingerprintSummary: fingerprint ? fingerprintSummary(fingerprint) : null,
    accountIdentity,
    consentCurrent,
    consentedAt: consentCurrent ? consentedAt : null,
    invalidSignatureWarning: BIRD_WARNINGS.invalidSignature,
    cookieAccessWarning: BIRD_WARNINGS.cookieAccess,
  };
}

function effectiveBirdPath(persisted: string | undefined): string | undefined {
  const override = process.env.OPENRECRUIT_BIRD_PATH;
  if (override?.trim()) return override.trim();
  return persisted?.trim() || undefined;
}

function normalizeBirdPathForSettings(value: string): string {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!normalized || normalized.length > 4_096 || hasControlCharacter || !isAbsolute(normalized)) {
    throw new Error("Bird executable path must be an absolute path");
  }
  return normalized;
}

function safeDraftPath(value: string): string {
  return value.trim().slice(0, 4_096);
}

function parseBirdAccount(raw: string | undefined): BirdAccountIdentity | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    const id = typeof value.id === "string" && value.id ? value.id.slice(0, 64) : null;
    const username =
      typeof value.username === "string" && value.username
        ? value.username.replace(/^@/, "").slice(0, 30)
        : null;
    const displayName =
      typeof value.displayName === "string" && value.displayName
        ? value.displayName.slice(0, 160)
        : null;
    return id || username || displayName ? { id, username, displayName } : null;
  } catch {
    return null;
  }
}

function sanitizeAccountIdentity(value: BirdAccountIdentity | null): BirdAccountIdentity | null {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 64) : null;
  const username =
    typeof value.username === "string" && value.username.trim()
      ? value.username.trim().replace(/^@/, "").slice(0, 30)
      : null;
  const displayName =
    typeof value.displayName === "string" && value.displayName.trim()
      ? value.displayName.trim().slice(0, 160)
      : null;
  return id || username || displayName ? { id, username, displayName } : null;
}

function sanitizeDetectedVersion(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  return match?.[0] ?? null;
}

function sanitizeFingerprint(value: string): string | null {
  return typeof value === "string" && /^[a-f\d]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function readBirdConsent(raw: string | undefined): BirdConsentBinding | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const accountIdentity = parseBirdAccount(JSON.stringify(record.accountIdentity));
    if (
      typeof record.configuredPath !== "string" ||
      typeof record.resolvedPath !== "string" ||
      typeof record.fingerprint !== "string" ||
      typeof record.version !== "string" ||
      !accountIdentity
    ) {
      return null;
    }
    return {
      configuredPath: record.configuredPath,
      resolvedPath: record.resolvedPath,
      fingerprint: record.fingerprint,
      version: record.version,
      accountIdentity,
    };
  } catch {
    return null;
  }
}

function parseTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sameAccountIdentity(a: BirdAccountIdentity, b: BirdAccountIdentity): boolean {
  return a.id === b.id && a.username === b.username && a.displayName === b.displayName;
}

function fingerprintSummary(fingerprint: string): string {
  return `SHA-256 ${fingerprint.slice(0, 16)}…`;
}

function safeBirdFailure(
  readiness: BirdReadiness,
  failure: string | null | undefined,
  detectedVersion: string | null,
): string | null {
  if (!failure) return null;
  if (readiness === "unsupported" && detectedVersion) {
    return `Bird ${detectedVersion} is unsupported; OpenRecruit requires Bird ${BIRD_SUPPORTED_VERSION}`;
  }
  const safeFailures = new Set([
    "The configured Bird path does not exist",
    "The configured Bird path is not an executable file",
    "The configured Bird path is not executable",
    "The configured Bird executable could not be resolved",
    "The Bird executable could not be fingerprinted",
    "Bird version output exceeded the bounded limit",
    "Bird version could not be detected safely",
    "Bird version check timed out",
    "Bird readiness output exceeded the bounded limit",
    "Bird readiness check timed out",
    "Bird account output exceeded the bounded limit",
    "Bird account check timed out",
    "Bird could not access an authenticated X browser session",
    "Bird readiness check failed",
    "Bird could not identify the authenticated public X account",
    "Bird account identity check failed",
    "Bird did not report an authenticated public X account",
    "Bird could not be tested safely",
    "The Bird executable changed since it was tested",
  ]);
  return safeFailures.has(failure) ? failure : safeFailureForReadiness(readiness);
}

function safeFailureForReadiness(readiness: BirdReadiness): string | null {
  switch (readiness) {
    case "invalid_path":
      return "Bird executable path must be an absolute path";
    case "not_executable":
      return "The configured Bird path is not an executable file";
    case "unsupported":
      return "The configured Bird version is unsupported";
    case "reauthentication_required":
      return "Bird requires an authenticated public X account";
    case "degraded":
      return "Bird could not be verified safely";
    default:
      return null;
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
