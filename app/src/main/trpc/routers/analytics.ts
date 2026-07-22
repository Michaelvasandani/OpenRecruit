import { RendererTrackInput, type TelemetryEvent, type TelemetryProps } from "@shared/analytics";
import { analytics } from "../../services/analytics";
import { publicProcedure, router } from "../trpc";

/**
 * The renderer/launcher telemetry surface. A single `track` mutation whose input is
 * the `RendererTrackInput` discriminated union — so only the allowlisted
 * renderer/launcher events (onboarding funnel, `update_downloaded`, renderer
 * `app_error`) can be sent from outside the host, and the host re-validates through
 * the same schema map in `analytics.track`. There is no PostHog SDK in the renderer;
 * everything funnels through the host's single AnalyticsService.
 */
export const analyticsRouter = router({
  track: publicProcedure.input(RendererTrackInput).mutation(({ input }) => {
    const props = "props" in input ? input.props : undefined;
    analytics.track(
      input.event as TelemetryEvent,
      props as TelemetryProps<TelemetryEvent> | undefined,
    );
    return { ok: true };
  }),
});
