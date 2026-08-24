import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Db } from "../db/client";
import type { AgentRegistry } from "../services/agents/registry";
import type { RecentNotificationsService } from "../services/notifications/recent";
import type { RecruitingApplication } from "../services/recruiting";
import type { Scheduler } from "../services/scheduler";
import type { WakeTransport } from "../services/scheduler/wake/types";
import type { SettingsService } from "../services/settings";
import type { TerminalService } from "../services/terminal";

export interface Context {
  db: Db;
  registry: AgentRegistry;
  terminal: TerminalService;
  settings: SettingsService;
  scheduler: Scheduler;
  wake: WakeTransport;
  /** Durable Recent ring buffer behind `notifications.onRecent` (§12.6). */
  recent: RecentNotificationsService;
  recruiting: RecruitingApplication;
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;
