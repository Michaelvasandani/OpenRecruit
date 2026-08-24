/** Prepended to a wake prompt so the agent can tell a system wake from a real user
 *  turn. The agent templates' instructions document what it means. The wake's fire
 *  time (ISO 8601) is appended so the agent knows *when* it was woken — relevant for
 *  source freshness and for reasoning across catch-up
 *  fires. Used by every delivery path that lands as a plain user turn: claude
 *  headless `-p` runs and BOTH codex paths (app-server turns have no channel
 *  envelope to self-identify). The claude interactive channel needs no prefix — it
 *  renders as `<channel source="opentrade">`. */
const WAKE_PREFIX = "OPENTRADE WAKE";

export function formatWakePrompt(prompt: string, firedAt: number = Date.now()): string {
  return `[${WAKE_PREFIX} ${new Date(firedAt).toISOString()}] ${prompt}`;
}
