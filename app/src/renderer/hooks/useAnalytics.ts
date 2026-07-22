import { trpc } from "../lib/trpc";

/**
 * Fire-and-forget renderer telemetry. Returns the `analytics.track` mutation's
 * `mutate` (stable across renders), which sends an allowlisted renderer event to
 * the host's single AnalyticsService. There is no PostHog SDK in the renderer;
 * errors are intentionally ignored (telemetry never blocks the UI).
 */
export function useTrackEvent() {
  return trpc.analytics.track.useMutation().mutate;
}
