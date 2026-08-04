import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Harness, ProbeResult, SessionMode } from "./types";

const execFileAsync = promisify(execFile);

/**
 * `--dangerously-load-development-channels` is a VARIADIC flag (`<servers...>`):
 * passed as two argv tokens (`--flag server:opentrade`) it greedily consumes every
 * following non-`-` token — including the positional kickoff prompt on first run.
 * Claude then parses the whole kickoff as a second channel spec, fails, prints the
 * channel-format usage, and exits immediately (the first-run "session ended — Resume
 * to continue" bug; resume/headless escaped it only because they have no trailing
 * positional). The `=`-bound single-value form binds exactly one channel and stops
 * the variadic there, so the kickoff stays a normal positional prompt.
 */
const CHANNEL_ARG = "--dangerously-load-development-channels=server:opentrade";

/**
 * Claude Code: the original harness. OpenTrade mints the session uuid
 * (`--session-id`) and resumes it everywhere; interactive PTYs register the
 * `opentrade` channel so scheduled wakes inject into the live session; headless
 * wakes are one-shot `--resume … -p` children with permissions skipped (order
 * tools stay gated by the PreToolUse hook, which fires even under that flag).
 */
export const claudeHarness: Harness = {
  id: "claude",
  binary: "claude",
  instructionsFile: "CLAUDE.md",
  instructionsPrefixFile: "CLAUDE.prefix.md",
  // Strip so background runs use the Claude subscription login rather than
  // silently billing an `ANTHROPIC_API_KEY` inherited from the user's shell.
  subscriptionAuthStrip: ["ANTHROPIC_API_KEY"],

  interactiveArgs(mode: SessionMode, sessionId: string, kickoff?: string | null): string[] {
    if (mode === "resume") return ["--resume", sessionId, CHANNEL_ARG];
    // The kickoff is the positional prompt, placed after all flags. Safe only
    // because CHANNEL_ARG uses the `=`-bound form (a bare variadic would swallow it).
    return ["--session-id", sessionId, CHANNEL_ARG, ...(kickoff ? [kickoff] : [])];
  },

  interactiveEnv(): Record<string, string> {
    return {
      // Force Claude Code's fullscreen ("no-flicker") renderer for interactive PTYs:
      // it draws on the alternate screen buffer and handles its own scrollback instead
      // of spilling into the terminal's, which keeps memory flat and rendering clean in
      // our embedded xterm. Equivalent to the saved `tui` setting, but enforced here so
      // every session we launch gets it regardless of the user's config.
      // https://code.claude.com/docs/en/fullscreen
      CLAUDE_CODE_NO_FLICKER: "1",
    };
  },

  headlessArgs(mode: SessionMode, sessionId: string, wakePrompt: string): string[] {
    const session = mode === "resume" ? ["--resume", sessionId] : ["--session-id", sessionId];
    return [...session, "--dangerously-skip-permissions", "-p", wakePrompt];
  },

  async probe(env: Record<string, string>): Promise<ProbeResult> {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"], { env, timeout: 5000 });
      return { found: true, version: stdout.trim() };
    } catch {
      return { found: false, version: null };
    }
  },
};
