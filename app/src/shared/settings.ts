import { z } from "zod";

/** Safe readiness for the Candidate-supplied Firecrawl credential lane. The
 * credential itself is deliberately not part of this projection. */
export const FirecrawlReadiness = z.enum([
  "not_configured",
  "ready",
  "reauthentication_required",
  "rate_limited",
  "degraded",
]);
export type FirecrawlReadiness = z.infer<typeof FirecrawlReadiness>;

export const FirecrawlSafeFailure = z.enum([
  "Firecrawl rejected the configured API key",
  "Firecrawl is temporarily rate limited",
  "Firecrawl is temporarily unavailable",
  "Firecrawl could not verify the configured API key",
]);
export type FirecrawlSafeFailure = z.infer<typeof FirecrawlSafeFailure>;

export const FirecrawlSettings = z.object({
  configured: z.boolean(),
  readiness: FirecrawlReadiness,
  safeFailure: FirecrawlSafeFailure.nullable(),
});
export type FirecrawlSettings = z.infer<typeof FirecrawlSettings>;

/** Safe readiness states for the locally installed Bird executable. Raw Bird
 * output, cookies, cookie locations, and authentication material never belong
 * in this projection. */
export const BirdReadiness = z.enum([
  "not_configured",
  "ready",
  "invalid_path",
  "not_executable",
  "unsupported",
  "reauthentication_required",
  "degraded",
]);
export type BirdReadiness = z.infer<typeof BirdReadiness>;

export const BirdAccountIdentity = z.object({
  id: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
});
export type BirdAccountIdentity = z.infer<typeof BirdAccountIdentity>;

/** Candidate-facing Bird settings. The executable path is configuration, not
 * a credential; all process output and browser-session material stay host-only. */
export const BirdSettings = z.object({
  configured: z.boolean(),
  configuredPath: z.string().nullable(),
  readiness: BirdReadiness,
  safeFailure: z.string().nullable(),
  detectedVersion: z.string().nullable(),
  fingerprintSummary: z.string().nullable(),
  accountIdentity: BirdAccountIdentity.nullable(),
  consentCurrent: z.boolean(),
  consentedAt: z.number().int().nullable(),
  invalidSignatureWarning: z.string(),
  cookieAccessWarning: z.string(),
});
export type BirdSettings = z.infer<typeof BirdSettings>;

export const BIRD_INVALID_SIGNATURE_WARNING =
  "Bird has an invalid developer signature; confirm only an executable you trust.";
export const BIRD_COOKIE_ACCESS_WARNING =
  "Bird can access browser cookies for its authenticated X session. OpenRecruit never stores or displays those cookies.";

/**
 * Global app settings (the `settings` kv table, distinct from per-agent config
 * and from the encrypted OAuth/token rows). This is the single source of truth
 * for every tunable: bounds live here, defaults live in `DEFAULT_SETTINGS`, and
 * both main services and the renderer read this shape.
 */
export const AppSettings = z.object({
  /** Set once the first-run onboarding wizard has been completed or skipped. */
  onboardingComplete: z.boolean(),
  /** Anonymous product-telemetry opt-out. On by default; the capture-time gate in
   *  AnalyticsService reads this live via `settings:changed`. */
  telemetryEnabled: z.boolean(),
  /** Global on/off for the whole background turn-limit feature. On by default; when off,
   *  no agent is ever gated/counted and the agent-view turn-limit button is hidden.
   *  Distinct from the per-agent `Agent.turnLimitEnabled` switch. */
  headlessTurnLimitEnabled: z.boolean(),
  /** Max headless (scheduled background) turns an agent may run between resets. One
   *  global value for all agents; per-agent there is only an on/off toggle
   *  (`Agent.turnLimitEnabled`). The count refills only via the agent view's
   *  turn-limit button's Reset control. */
  maxHeadlessTurns: z.number().int().min(1).max(1000),
  /** Hard ceiling on a single scheduled background run, in minutes (includes time parked
   *  at the approval gate). On expiry the run is SIGTERM'd; it's a clean stop, not a
   *  failure. Always applies, independent of the turn limit. */
  maxHeadlessRunMinutes: z.number().int().min(5).max(60),
  /** Whether background (headless `-p`) runs may use `ANTHROPIC_API_KEY` from the env.
   *  **Off by default**: unattended runs launch with the key stripped, so `claude` uses
   *  the logged-in Claude subscription instead of silently billing the Anthropic API. On
   *  keeps the key (the whole app env is inherited, so a shell `ANTHROPIC_API_KEY` flows
   *  through). Interactive sessions are unaffected either way. */
  backgroundAllowApiKey: z.boolean(),

  // ---- macOS notifications (§12.4). All default on: the launcher gates display. ----
  /** Notify when a cron/monitor wakes an agent (launcher shows it only while unfocused). */
  notifyWakes: z.boolean(),
  /** Notify when an agent hits its headless turn limit and is paused. */
  notifyRestricted: z.boolean(),
  /** Notify when an app update has been downloaded and is ready to install. */
  notifyUpdates: z.boolean(),
  /** Agent ids whose notifications are muted entirely (a coarse per-agent switch). */
  notifyMutedAgents: z.array(z.string()),

  // ---- menu bar (§12.6) ----
  /** Show the OpenTrade status item in the macOS menu bar and keep the launcher alive
   *  there when the window is closed / ⌘Q'd, so agent status + notifications keep
   *  flowing while the app is "closed". On by default; off restores plain quit. */
  showInMenuBar: z.boolean(),
  /** Safe Firecrawl Source readiness. The API key is never part of this value. */
  firecrawl: FirecrawlSettings,
  /** Safe local Bird readiness and consent. Bird credentials and process output
   * are never part of this value. */
  bird: BirdSettings,
});
export type AppSettings = z.infer<typeof AppSettings>;

/** Settings that may be changed through the generic settings patch. Secret-backed
 * provider state has explicit operations below and cannot be smuggled into a patch. */
export const EditableAppSettings = AppSettings.omit({ firecrawl: true, bird: true });
export type EditableAppSettings = z.infer<typeof EditableAppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  onboardingComplete: false,
  telemetryEnabled: true,
  headlessTurnLimitEnabled: true,
  maxHeadlessTurns: 20,
  maxHeadlessRunMinutes: 30,
  backgroundAllowApiKey: false,
  notifyWakes: true,
  notifyRestricted: true,
  notifyUpdates: true,
  notifyMutedAgents: [],
  showInMenuBar: true,
  firecrawl: {
    configured: false,
    readiness: "not_configured",
    safeFailure: null,
  },
  bird: {
    configured: false,
    configuredPath: null,
    readiness: "not_configured",
    safeFailure: null,
    detectedVersion: null,
    fingerprintSummary: null,
    accountIdentity: null,
    consentCurrent: false,
    consentedAt: null,
    invalidSignatureWarning: BIRD_INVALID_SIGNATURE_WARNING,
    cookieAccessWarning: BIRD_COOKIE_ACCESS_WARNING,
  },
};

/** A partial update of the editable settings. */
export const SettingsUpdate = EditableAppSettings.partial().strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;
