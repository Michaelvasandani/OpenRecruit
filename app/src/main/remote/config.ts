import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConnectionConfig,
  connectionConfigSchema,
  LOCAL_CONNECTION,
} from "@shared/connection";
import { OPENTRADE_HOME } from "../db/client";

/**
 * The launcher's persisted choice of backend (shared/connection.ts). A file beside
 * the local host manifest rather than a settings row: the settings live in a host,
 * and this decides which host. Anything unreadable falls back to local, so a bad
 * edit can never lock the user out of the app.
 */
const CONFIG_FILE = join(OPENTRADE_HOME, "connection.json");

export function readConnectionConfig(): ConnectionConfig {
  try {
    const parsed = connectionConfigSchema.safeParse(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
    return parsed.success ? parsed.data : LOCAL_CONNECTION;
  } catch {
    return LOCAL_CONNECTION;
  }
}

export function writeConnectionConfig(config: ConnectionConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(connectionConfigSchema.parse(config)), {
    mode: 0o600,
  });
}
