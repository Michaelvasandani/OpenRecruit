import { z } from "zod";
import { ApprovalMode, HarnessId } from "./agent";
import { NotificationKind } from "./notify";

/**
 * The telemetry allowlist — the single source of truth for what OpenTrade may ever
 * send to PostHog. Every event name maps to a **strict** schema of its allowed
 * props; the AnalyticsService validates each capture against this map and **drops
 * the whole event** if it doesn't parse (fail-closed). This is a structural privacy
 * guarantee, not a convention: an unexpected prop at a call site (a ticker, a raw
 * order object accidentally spread in) fails `strict` parsing and never leaves the
 * machine.
 *
 * Invariants enforced here:
 *  - No free-form `z.string()` anywhere. Every string is a `z.enum` or a tight
 *    regex (an identifier / a semver / a sanitized stack frame) — structurally
 *    unable to carry a message, path, or free text.
 *  - Numbers are durations/counts only.
 *  - Categorical normalizers (`assetTypeOf`, `sideOf`, `orderTypeOf`) map anything
 *    unrecognized to `"other"`, so raw parsed values can't pass through call sites.
 *
 * Policy: anonymous (a random distinct id, never a machine/user identifier), no
 * conversation data ever, and order events carry categories only — never tickers,
 * quantities, prices, notional, or account ids.
 */

// ---- shared field schemas ----

/** A bare identifier — an Error class name. Cannot carry a message/stack/path. */
const errorName = z.string().regex(/^[A-Za-z0-9_$]{1,64}$/);

/**
 * A machine error code — `err.code` when it is a bare identifier (Node system codes
 * like `EADDRINUSE`/`ECONNREFUSED`, `ERR_*`, our own `OAUTH_*`). Bounded token, no
 * spaces: structurally unable to carry a message. It's the one field that turns a
 * bare `Error` (whose class name says nothing) into something diagnosable.
 */
const errorCode = z.string().regex(/^[A-Za-z0-9_]{1,48}$/);

/** A semver-ish version string. */
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);

/**
 * A sanitized stack frame: `<bundle>.js:line[:col]` — bundle basename only, so it
 * points at our code without carrying a directory (no user path) or a message.
 */
const stackFrame = z.string().regex(/^[\w.-]+\.js:\d+(?::\d+)?$/);
const frames = z.array(stackFrame).max(10);

const assetType = z.enum(["equity", "option", "other"]);
const orderSide = z.enum(["buy", "sell", "other"]);
const orderType = z.enum(["market", "limit", "other"]);
const orderKind = z.enum(["place", "cancel"]);

/** Subsystem an `app_error` originated in. */
export const ErrorSubsystem = z.enum([
  "host",
  "broker",
  "terminal",
  "scheduler",
  "wake",
  "approvals",
  "updater",
  "renderer",
]);
export type ErrorSubsystem = z.infer<typeof ErrorSubsystem>;

/**
 * How an `app_error` reached the reporter — the *capture mechanism*, not the error
 * itself. Because we deliberately never send the message, this is the cheapest way
 * to make triage tractable: it separates an uncaught throw from an unhandled promise
 * rejection (e.g. a background clipboard write denied while the window is unfocused)
 * without any free text. `caught` is an explicit try/catch that chose to report.
 * Process-agnostic — the renderer's `error` / `unhandledrejection` window listeners and
 * the host's `uncaughtException` / `unhandledRejection` handlers map onto the same three.
 */
export const ErrorSource = z.enum(["uncaught_exception", "unhandled_rejection", "caught"]);
export type ErrorSource = z.infer<typeof ErrorSource>;

/** Keys of the global AppSettings (kept in sync manually — the enum is the guard). */
const settingKey = z.enum([
  "approvalTimeoutSec",
  "pollIntervalFocusedSec",
  "pollIntervalBlurredSec",
  "defaultApprovalMode",
  "onboardingComplete",
  "telemetryEnabled",
  "maxHeadlessTurns",
  "notifyWakes",
  "notifyOrders",
  "notifyApprovals",
  "notifyRestricted",
  "notifyUpdates",
]);

/** Onboarding step ids (mirrors renderer/screens/Onboarding.tsx). */
export const OnboardingStep = z.enum(["claude", "broker", "showcase", "agent"]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

/** Agent template ids (mirrors templates/agents/*). */
const agentTemplate = z.enum(["default", "dca", "momentum", "blank", "other"]);

// ---- the event → prop-schema map ----

/**
 * Every telemetry event and its exact allowed props. `z.strictObject` rejects any
 * unknown key, so a mistake at a call site drops the event rather than leaking.
 */
export const TELEMETRY_EVENTS = {
  // lifecycle
  host_started: z.strictObject({ after_crash: z.boolean().optional() }),
  app_opened: z.strictObject({}),
  app_updated: z.strictObject({ from_version: version, to_version: version }),
  update_downloaded: z.strictObject({ to_version: version }),

  // onboarding funnel
  onboarding_started: z.strictObject({}),
  onboarding_step_completed: z.strictObject({ step: OnboardingStep }),
  onboarding_completed: z.strictObject({}),

  // agents
  agent_created: z.strictObject({
    template: agentTemplate,
    harness: HarnessId,
    approval_mode: ApprovalMode,
  }),
  agent_archived: z.strictObject({}),
  agent_restarted: z.strictObject({}),
  terminal_session_started: z.strictObject({ intent: z.enum(["auto", "resume", "fresh"]) }),
  terminal_respawned: z.strictObject({}),

  // orders / the approval gate (categorical only)
  order_gate_prompted: z.strictObject({
    kind: orderKind,
    asset_type: assetType,
    side: orderSide,
    order_type: orderType,
    mode: ApprovalMode,
  }),
  order_gate_decided: z.strictObject({
    decision: z.enum(["approved", "rejected", "expired"]),
    decided_by: z.enum(["user", "auto", "timeout"]),
    decision_ms: z.number().int().nonnegative(),
    kind: orderKind,
    asset_type: assetType,
    side: orderSide,
    order_type: orderType,
  }),
  order_submit_resolved: z.strictObject({ result: z.enum(["ok", "rejected", "unknown"]) }),

  // broker
  /** Top of the connect funnel; `connected` / `connect_failed` are the outcomes. The gap
   *  is attempts with no outcome event: superseded by a later click, still pending, or a
   *  silent connect that found a dead grant and quietly stayed disconnected. */
  broker_connect_started: z.strictObject({ mode: z.enum(["interactive", "silent"]) }),
  broker_connected: z.strictObject({}),
  broker_connect_failed: z.strictObject({
    error_name: errorName,
    error_code: errorCode.optional(),
  }),
  /**
   * The poll loop lost the network (laptop sleep/wake, Wi‑Fi blip): once per outage,
   * with the first failure's code, instead of an `app_error` per failed poll. Not an
   * error in the app — filter it out of error dashboards. `broker_online` closes it.
   */
  broker_offline: z.strictObject({ error_code: errorCode.optional() }),
  broker_online: z.strictObject({
    offline_ms: z.number().int().nonnegative(),
    failed_polls: z.number().int().nonnegative(),
  }),

  // autonomy
  schedule_created: z.strictObject({
    kind: z.enum(["cron", "monitor"]),
    recurring: z.boolean().optional(),
  }),
  schedule_fired: z.strictObject({
    source: z.enum(["cron", "monitor"]),
    path: z.enum(["warm", "headless"]),
  }),
  headless_run_finished: z.strictObject({
    result: z.enum(["ok", "resume_fail", "spawn_fail"]),
    duration_ms: z.number().int().nonnegative(),
  }),
  agent_marked_broken: z.strictObject({}),
  turn_limit_reached: z.strictObject({}),

  // settings + telemetry lifecycle
  setting_changed: z.strictObject({
    key: settingKey,
    value: z.union([z.boolean(), ApprovalMode]).optional(),
  }),
  telemetry_enabled: z.strictObject({}),
  telemetry_disabled: z.strictObject({}),

  // notifications
  notification_clicked: z.strictObject({ kind: NotificationKind }),

  // errors (sanitized)
  app_error: z.strictObject({
    subsystem: ErrorSubsystem,
    error_name: errorName,
    error_code: errorCode.optional(),
    source: ErrorSource.optional(),
    frames: frames.optional(),
  }),
} as const;

export type TelemetryEvent = keyof typeof TELEMETRY_EVENTS;

/** Props type for a given event (the parsed/validated shape). */
export type TelemetryProps<E extends TelemetryEvent> = z.infer<(typeof TELEMETRY_EVENTS)[E]>;

/**
 * The subset of events the renderer/launcher may emit over the `analytics.track`
 * tRPC mutation. A discriminated union so the tRPC surface can't be used to smuggle
 * host-only events or extra props; the host re-validates through TELEMETRY_EVENTS
 * regardless. `app_error` here is restricted to the two subsystems that actually run
 * in the GUI process and relay over this surface — `renderer` and `updater` (the
 * auto-updater lives in the Electron main process, not the host) — so it still can't
 * smuggle a host-only subsystem label.
 */
export const RendererTrackInput = z.discriminatedUnion("event", [
  z.object({ event: z.literal("onboarding_started") }),
  z.object({
    event: z.literal("onboarding_step_completed"),
    props: TELEMETRY_EVENTS.onboarding_step_completed,
  }),
  z.object({ event: z.literal("onboarding_completed") }),
  z.object({ event: z.literal("update_downloaded"), props: TELEMETRY_EVENTS.update_downloaded }),
  z.object({
    event: z.literal("notification_clicked"),
    props: TELEMETRY_EVENTS.notification_clicked,
  }),
  z.object({
    event: z.literal("app_error"),
    props: z.strictObject({
      subsystem: z.enum(["renderer", "updater"]),
      error_name: errorName,
      source: ErrorSource.optional(),
      frames: frames.optional(),
    }),
  }),
]);
export type RendererTrackInput = z.infer<typeof RendererTrackInput>;

// ---- categorical normalizers (call sites pass raw values through these) ----

/** equity vs option, from the Robinhood order tool name. */
export function assetTypeOf(toolName: string): z.infer<typeof assetType> {
  if (/_equity_/.test(toolName)) return "equity";
  if (/_option_/.test(toolName)) return "option";
  return "other";
}

/** buy/sell/other from a parsed order side (any casing). */
export function sideOf(side: string | null | undefined): z.infer<typeof orderSide> {
  const s = (side ?? "").toLowerCase();
  return s === "buy" || s === "sell" ? s : "other";
}

/** market/limit/other from a parsed order type (any casing). */
export function orderTypeOf(type: string | null | undefined): z.infer<typeof orderType> {
  const t = (type ?? "").toLowerCase();
  return t === "market" || t === "limit" ? t : "other";
}

/** place vs cancel from a parsed order kind. */
export function orderKindOf(kind: string | null | undefined): z.infer<typeof orderKind> {
  return kind === "cancel" ? "cancel" : "place";
}

/** Normalize a template id to the allowlist (unknown → "other"). */
export function templateOf(template: string | null | undefined): z.infer<typeof agentTemplate> {
  switch (template) {
    case "default":
    case "dca":
    case "momentum":
    case "blank":
      return template;
    default:
      return "other";
  }
}

/**
 * Extract a sanitized stack fingerprint from an error: `<bundle>.js:line[:col]`
 * frames pointing into our own bundles, node internals / node_modules dropped, at
 * most 10. Taking only the file **basename** structurally strips any directory, so
 * no user path or message can ride along.
 */
export function sanitizeStack(err: unknown): string[] {
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  if (!stack) return [];
  const out: string[] = [];
  const re = /([\w.-]+\.js):(\d+)(?::(\d+))?/;
  for (const line of stack.split("\n")) {
    if (/node:internal|node_modules/.test(line)) continue;
    const m = line.match(re);
    if (!m) continue;
    out.push(m[3] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`);
    if (out.length >= 10) break;
  }
  return out;
}

/** The constructor name of a thrown value, normalized to the `error_name` shape. */
export function errorNameOf(err: unknown): string {
  const name =
    err instanceof Error
      ? err.name || err.constructor?.name || "Error"
      : typeof err === "object" && err
        ? (err.constructor?.name ?? "Object")
        : typeof err;
  // Keep only identifier chars; guarantee the `errorName` regex passes.
  const clean = name.replace(/[^A-Za-z0-9_$]/g, "").slice(0, 64);
  return clean || "Error";
}

/**
 * The machine code of a thrown value — `err.code`, or failing that `err.cause.code` —
 * or undefined unless it *already* fits the `errorCode` shape: nothing is coerced or
 * truncated into one, so a `code` holding a message/path is dropped, not leaked.
 * Numeric codes (DOMException) are ignored: meaningless without the class name, which
 * `errorNameOf` carries.
 *
 * The `cause` hop is for undici: every network failure `fetch` throws is a bare
 * `TypeError: fetch failed` with no code of its own — the useful token
 * (`ENOTFOUND`, `ECONNRESET`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, …) sits on
 * `.cause` (Node also copies it onto the `AggregateError` for dual-stack hosts). One
 * level only.
 */
export function errorCodeOf(err: unknown): string | undefined {
  const codeOn = (v: unknown) =>
    typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined;
  const code = codeOn(err) ?? codeOn((err as { cause?: unknown } | null)?.cause);
  return errorCode.safeParse(code).success ? (code as string) : undefined;
}
