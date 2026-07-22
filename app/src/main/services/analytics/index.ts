import { randomUUID } from "node:crypto";
import {
  type ErrorSubsystem,
  errorNameOf,
  sanitizeStack,
  TELEMETRY_EVENTS,
  type TelemetryEvent,
  type TelemetryProps,
} from "@shared/analytics";
import type { AppSettings } from "@shared/settings";
import { PostHog } from "posthog-node";
import { z } from "zod";
import { hostLog } from "../../host/log";
import { bus } from "../event-bus";
import type { SettingsService } from "../settings";

/** exla's PostHog reverse proxy (→ PostHog cloud); the only endpoint the telemetry
 *  funnel talks to. Matches the `api_host` PostHog issues for this project. */
const POSTHOG_HOST = "https://r.exla.ai";

/**
 * The capture surface AnalyticsService needs — a subset of posthog-node's client,
 * so tests can inject a fake without the SDK or a network path.
 */
export interface CaptureClient {
  capture(msg: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

/** Non-telemetry AppSettings keys we surface as `setting_changed`. */
const REPORTABLE_SETTING_KEYS = [
  "approvalTimeoutSec",
  "pollIntervalFocusedSec",
  "pollIntervalBlurredSec",
  "defaultApprovalMode",
  "onboardingComplete",
] as const;

/**
 * The single telemetry funnel. Everything OpenTrade sends to PostHog goes through
 * `track()` here, in the backend host — the process that owns settings (the gate),
 * survives GUI restarts, and originates most events. There is no renderer PostHog
 * SDK: renderer/launcher events arrive over the `analytics.track` tRPC mutation.
 *
 * Privacy is structural: `track()` validates every payload against the strict
 * `TELEMETRY_EVENTS` allowlist and drops anything that doesn't parse. The distinct
 * id is a random per-install UUID (never a machine/user identifier); events set
 * `$process_person_profile: false` so PostHog keeps them anonymous.
 *
 * Disabled ⇔ `client` is null (no key / dev / not started) **or** the user opted out
 * (`enabled`), checked live at capture time via `settings:changed`.
 */
export class AnalyticsService {
  private client: CaptureClient | null = null;
  private enabled = false;
  private distinctId = "";
  private superProps: Record<string, unknown> = {};
  private lastSettings: AppSettings | null = null;
  private unsubs: Array<() => void> = [];
  private started = false;

  /**
   * Production init: create the posthog-node client from the build-time key unless
   * the key is absent or we're in dev without the `OPENTRADE_ANALYTICS_DEV=1`
   * override, then wire the settings gate + lifecycle. Inert (no client) otherwise.
   */
  init(opts: { settings: SettingsService }): void {
    const key = import.meta.env.MAIN_VITE_POSTHOG_API_KEY ?? "";
    const devDisabled = import.meta.env.DEV && process.env.OPENTRADE_ANALYTICS_DEV !== "1";
    let client: CaptureClient | null = null;
    if (key && !devDisabled) {
      client = new PostHog(key, {
        host: POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 0,
        disableGeoip: true,
      });
      hostLog.info("analytics: enabled");
    } else {
      hostLog.info(`analytics: inert (${!key ? "no key" : "dev"})`);
    }
    this.start({ settings: opts.settings, client });
  }

  /**
   * Wire the service against a settings source + capture client. Split from init()
   * so tests can inject a fake client with no posthog-node/env dependency.
   */
  start(opts: { settings: SettingsService; client: CaptureClient | null }): void {
    if (this.started) return;
    this.started = true;
    this.client = opts.client;
    this.lastSettings = opts.settings.get();
    this.enabled = this.lastSettings.telemetryEnabled;
    this.distinctId = opts.settings.getOrCreate("telemetry_distinct_id", () => randomUUID());
    this.superProps = {
      app_version: process.env.OPENTRADE_VERSION ?? "dev",
      platform: process.platform,
      arch: process.arch,
    };
    this.unsubs.push(bus.onEvent("settings:changed", (next) => this.onSettingsChanged(next)));
    this.unsubs.push(bus.onEvent("gui:present", () => this.track("app_opened")));
  }

  /** The stable per-install anonymous id (exposed for tests). */
  get anonymousId(): string {
    return this.distinctId;
  }

  /**
   * Capture a telemetry event. Validated against the allowlist; a payload with an
   * unknown/extra prop (or an unknown event) is **dropped whole** — never partially
   * sent. Super-props + the anonymous flag are stamped here, not by callers.
   */
  track<E extends TelemetryEvent>(event: E, props?: TelemetryProps<E>): void {
    if (!this.client || !this.enabled) return;
    const schema = TELEMETRY_EVENTS[event] as z.ZodType | undefined;
    if (!schema) {
      hostLog.warn(`analytics: dropped ${String(event)} (unknown event)`);
      return;
    }
    const parsed = schema.safeParse(props ?? {});
    if (!parsed.success) {
      hostLog.warn(`analytics: dropped ${event} (invalid props)`);
      return;
    }
    try {
      this.client.capture({
        distinctId: this.distinctId,
        event,
        properties: {
          ...(parsed.data as Record<string, unknown>),
          ...this.superProps,
          $process_person_profile: false,
        },
      });
    } catch (err) {
      hostLog.warn(`analytics: capture failed: ${String(err)}`);
    }
  }

  /**
   * Capture a sanitized `app_error`: the error class name + bundle-only stack
   * fingerprint. Never the message, a stack line's path, or any free text.
   */
  trackError(subsystem: ErrorSubsystem, err: unknown): void {
    const frames = sanitizeStack(err);
    this.track("app_error", {
      subsystem,
      error_name: errorNameOf(err),
      ...(frames.length ? { frames } : {}),
    });
  }

  /** Flush pending events and stop listening. Bounded so host shutdown can't hang. */
  async shutdown(timeoutMs = 1500): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.shutdown(timeoutMs);
    } catch (err) {
      hostLog.warn(`analytics: shutdown flush failed: ${String(err)}`);
    }
  }

  private onSettingsChanged(next: AppSettings): void {
    const prev = this.lastSettings;
    this.lastSettings = next;
    if (!prev) return;

    // Telemetry toggle transitions. On opt-out, send the final event *before*
    // gating off (industry standard); on opt-in, gate on *before* sending.
    if (prev.telemetryEnabled && !next.telemetryEnabled) {
      this.track("telemetry_disabled");
      this.enabled = false;
      return;
    }
    if (!prev.telemetryEnabled && next.telemetryEnabled) {
      this.enabled = true;
      this.track("telemetry_enabled");
    }

    // Any other changed setting → one `setting_changed` (value only for enums/bools).
    for (const key of REPORTABLE_SETTING_KEYS) {
      if (prev[key] === next[key]) continue;
      const value = next[key];
      if (typeof value === "boolean" || key === "defaultApprovalMode") {
        this.track("setting_changed", {
          key,
          value: value as boolean | AppSettings["defaultApprovalMode"],
        });
      } else {
        this.track("setting_changed", { key });
      }
    }
  }
}

/** Host-wide singleton (same pattern as `bus`). Tests construct their own instances. */
export const analytics = new AnalyticsService();
