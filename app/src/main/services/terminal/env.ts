import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { OPENTRADE_HOME } from "../../db/client";

/** Credentials and local-provider overrides owned by the detached host and
 * never made available to Scouts. */
const HOST_OWNED_ENV_KEYS = [
  "FIRECRAWL_API_KEY",
  "OPENRECRUIT_BIRD_PATH",
  "TYPESAFE_API_KEY",
] as const;

/** Identity of an enclosing Claude Code session (the host was launched from a
 * Claude terminal or the desktop app). A Scout that inherits these believes it
 * is that session's child: it adopts the parent's session id and messaging
 * socket, and its own transcript is not saved where `--resume` looks, so every
 * later wake fails with "No conversation found". */
const AMBIENT_CLAUDE_SESSION_KEY =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PREVIEW_[A-Z_]+|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|HOST_SESSION_ID|SESSION_ATTENDED|MESSAGING_[A-Z_]+|ENTRYPOINT|EXECPATH|DESKTOP_APP_VERSION|OAUTH_SCOPES|SDK_[A-Z_]+|EAGER_FLUSH|REPORT_FINDINGS|EMIT_TOOL_USE_SUMMARIES|ENABLE_SDK_FILE_CHECKPOINTING|ENABLE_ASK_USER_QUESTION_TOOL|DISABLE_CRON|DISABLE_TERMINAL_TITLE))$/;

/**
 * Build the environment for an agent's PTY. We inherit the app's env, ensure the
 * usual macOS bin dirs are on PATH (so `claude`, `git`, etc. resolve), and inject
 * OPENTRADE_* identifiers. The hooks-server port/token (OPENTRADE_PORT /
 * OPENTRADE_TOKEN) are layered in by M3.
 *
 * `stripEnvKeys` (set for background/headless runs, from the harness's
 * `subscriptionAuthStrip` list — e.g. `ANTHROPIC_API_KEY` for claude,
 * `OPENAI_API_KEY` for codex) removes API keys from the inherited env so the CLI
 * bills the user's logged-in subscription instead of silently hitting an API key —
 * the whole app env is inherited, so a key in the user's shell would otherwise
 * leak into every unattended run (the "unattended runs bill the API" cost bug).
 */
export function buildAgentEnv(
  agentId: string,
  extra?: Record<string, string>,
  opts?: { stripEnvKeys?: readonly string[] },
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v;
  }

  // Inside another Claude session the API base URL is that session's local
  // proxy, which dies with it; a user's own override has no such parent.
  if (base.CLAUDE_CODE_CHILD_SESSION !== undefined) delete base.ANTHROPIC_BASE_URL;
  for (const key of Object.keys(base)) {
    if (AMBIENT_CLAUDE_SESSION_KEY.test(key)) delete base[key];
  }
  for (const key of opts?.stripEnvKeys ?? []) delete base[key];
  for (const key of HOST_OWNED_ENV_KEYS) delete base[key];

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

  const safeExtra = { ...extra };
  for (const key of HOST_OWNED_ENV_KEYS) delete safeExtra[key];
  return { ...base, ...safeExtra };
}
