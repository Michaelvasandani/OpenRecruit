import { errorNameOf, sanitizeStack } from "@shared/analytics";
import { getImperativeClient } from "./trpc";

/**
 * Renderer crash telemetry. `window.onerror` / `unhandledrejection` are funneled to
 * the host's AnalyticsService as a sanitized `app_error` (subsystem "renderer") —
 * the error class name + a bundle-only stack fingerprint, never the message. Capped
 * per session so an error loop can't spam the funnel. Fire-and-forget; the host gate
 * (opt-out / no key) decides whether anything is actually sent.
 */
const MAX_REPORTS = 5;
let sent = 0;

function report(err: unknown): void {
  if (sent >= MAX_REPORTS) return;
  sent++;
  const frames = sanitizeStack(err);
  try {
    getImperativeClient()
      .analytics.track.mutate({
        event: "app_error",
        props: {
          subsystem: "renderer",
          error_name: errorNameOf(err),
          ...(frames.length ? { frames } : {}),
        },
      })
      .catch(() => {});
  } catch {
    // client not ready — drop it.
  }
}

export function installRendererErrorReporter(): void {
  window.addEventListener("error", (e) => report(e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => report(e.reason));
}
