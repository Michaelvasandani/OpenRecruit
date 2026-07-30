import { z } from "zod";
import { ApprovalMode } from "./agent";

/**
 * Global app settings (the `settings` kv table, distinct from per-agent config
 * and from the encrypted OAuth/token rows). This is the single source of truth
 * for every tunable: bounds live here, defaults live in `DEFAULT_SETTINGS`, and
 * both main services and the renderer read this shape.
 */
export const AppSettings = z.object({
  /** Seconds the user is given before a pending order auto-denies. */
  approvalTimeoutSec: z.number().int().min(10).max(3600),
  /** Broker poll cadence when the window is focused during market hours. */
  pollIntervalFocusedSec: z.number().int().min(1).max(120),
  /** Broker poll cadence when blurred or the market is closed. */
  pollIntervalBlurredSec: z.number().int().min(1).max(600),
  /** Approval mode applied to newly created agents. */
  defaultApprovalMode: ApprovalMode,
  /** Set once the first-run onboarding wizard has been completed or skipped. */
  onboardingComplete: z.boolean(),
  /** Anonymous product-telemetry opt-out. On by default; the capture-time gate in
   *  AnalyticsService reads this live via `settings:changed`. */
  telemetryEnabled: z.boolean(),
  /** Max headless (scheduled background) turns an agent may run since the user last
   *  viewed it in the GUI. One global value for all agents; per-agent there is only
   *  an on/off toggle (`Agent.turnLimitEnabled`). Viewing the agent resets its count. */
  maxHeadlessTurns: z.number().int().min(1).max(1000),

  // ---- macOS notifications (§12.4). All default on: the launcher gates display. ----
  /** Notify when a cron/monitor wakes an agent (launcher shows it only while unfocused). */
  notifyWakes: z.boolean(),
  /** Notify when an agent-placed order reaches a terminal state (filled/rejected/…). */
  notifyOrders: z.boolean(),
  /** Notify banner for a new pending approval (the dock badge/flash are unconditional). */
  notifyApprovals: z.boolean(),
  /** Notify when an agent hits its headless turn limit and is paused. */
  notifyRestricted: z.boolean(),
  /** Notify when an app update has been downloaded and is ready to install. */
  notifyUpdates: z.boolean(),
  /** Agent ids whose notifications are muted entirely (a coarse per-agent switch). */
  notifyMutedAgents: z.array(z.string()),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  approvalTimeoutSec: 300,
  pollIntervalFocusedSec: 5,
  pollIntervalBlurredSec: 10,
  defaultApprovalMode: "approve",
  onboardingComplete: false,
  telemetryEnabled: true,
  maxHeadlessTurns: 20,
  notifyWakes: true,
  notifyOrders: true,
  notifyApprovals: true,
  notifyRestricted: true,
  notifyUpdates: true,
  notifyMutedAgents: [],
};

/** A partial update of the editable settings. */
export const SettingsUpdate = AppSettings.partial();
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;
