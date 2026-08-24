import type { HarnessId } from "@shared/agent";
import { claudeHarness } from "./claude";
import type { Harness } from "./types";

export type { Harness, ProbeResult, SessionMode } from "./types";

/**
 * The harness registry. Adding a harness = a new implementation file + an entry
 * here + a `HarnessId` enum member (shared/agent.ts). Consumers must resolve
 * through `harnessFor` — never branch on the id elsewhere.
 */
const HARNESSES: Partial<Record<HarnessId, Harness>> = {
  claude: claudeHarness,
};

/** Register a harness built at host wiring (codex needs its app-server manager). */
export function registerHarness(h: Harness): void {
  HARNESSES[h.id] = h;
}

export function harnessFor(id: HarnessId): Harness {
  const h = HARNESSES[id];
  // Loud failure beats silently running the wrong CLI against a transcript.
  if (!h) throw new Error(`harness not available: ${id}`);
  return h;
}
