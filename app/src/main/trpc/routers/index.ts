import { router } from "../trpc";
import { agentsRouter } from "./agents";
import { analyticsRouter } from "./analytics";
import { notificationsRouter } from "./notifications";
import { onboardingRouter } from "./onboarding";
import { recruitingRouter } from "./recruiting";
import { scheduleRouter } from "./schedule";
import { settingsRouter } from "./settings";
import { systemRouter } from "./system";
import { terminalRouter } from "./terminal";

export const appRouter = router({
  system: systemRouter,
  agents: agentsRouter,
  terminal: terminalRouter,
  onboarding: onboardingRouter,
  settings: settingsRouter,
  schedule: scheduleRouter,
  analytics: analyticsRouter,
  notifications: notificationsRouter,
  recruiting: recruitingRouter,
});

export type AppRouter = typeof appRouter;
