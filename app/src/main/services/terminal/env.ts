import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { OPENTRADE_HOME } from "../../db/client";

/**
 * Build the environment for an agent's PTY. We inherit the app's env, ensure the
 * usual macOS bin dirs are on PATH (so `claude`, `git`, etc. resolve), and inject
 * OPENTRADE_* identifiers. The hooks-server port/token (OPENTRADE_PORT /
 * OPENTRADE_TOKEN) are layered in by M3.
 *
 * `useSubscriptionAuth` (set for background/headless runs) strips `ANTHROPIC_API_KEY`
 * from the inherited env so `claude` uses the user's logged-in Claude subscription
 * instead of silently billing the Anthropic API — the whole app env is inherited, so
 * an `ANTHROPIC_API_KEY` in the user's shell would otherwise leak into every `-p` run
 * (the "unattended runs bill the API" cost bug).
 */
export function buildAgentEnv(
  agentId: string,
  extra?: Record<string, string>,
  opts?: { useSubscriptionAuth?: boolean },
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v;
  }

  if (opts?.useSubscriptionAuth) delete base.ANTHROPIC_API_KEY;

  const home = homedir();
  const extraPathDirs = [
    join(home, ".opentrade", "bin"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const currentPath = base.PATH ?? "";
  const merged = [...extraPathDirs, ...currentPath.split(delimiter)].filter(Boolean);
  base.PATH = [...new Set(merged)].join(delimiter);

  base.TERM = "xterm-256color";
  base.COLORTERM = "truecolor";
  base.OPENTRADE_AGENT_ID = agentId;
  base.OPENTRADE_HOME = OPENTRADE_HOME;

  return { ...base, ...extra };
}
