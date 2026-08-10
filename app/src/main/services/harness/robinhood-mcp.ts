/**
 * Shared facts about Robinhood's Agentic Trading MCP, plus the tiny config-file
 * readers behind `Harness.robinhoodMcpConfigured()` (onboarding step 2).
 *
 * We only answer "is it registered in this CLI's config?" — we never launch the
 * CLI or health-check the server. Agents trade through this MCP, so a user who
 * never registered it gets an agent that can reason but not order; pointing that
 * out during setup is worth a file read, not a probe.
 */

/** The Agentic Trading MCP endpoint (same URL both harnesses are scaffolded with). */
export const ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading";

/**
 * Robinhood's "Connect your AI agent" instructions — the ONLY setup guidance the
 * wizard gives. We deliberately don't restate the per-CLI `mcp add` commands: they
 * belong to Robinhood and the CLI vendors, and a copy here would rot silently.
 */
export const ROBINHOOD_MCP_CONNECT_URL =
  "https://robinhood.com/us/en/support/articles/agentic-trading-overview/#ConnectyourAIagent";

/**
 * Match on the MCP **host**, not a server name: Robinhood's guide registers it as
 * `robinhood-trading` while OpenTrade's own agent scaffold calls it `robinhood`,
 * and either one means the user is set up.
 */
const ROBINHOOD_MCP_HOST = "agent.robinhood.com";

/**
 * Claude Code's config is JSON with an `mcpServers` map. Parsed rather than
 * substring-matched so a URL sitting in unrelated state (history, a cached blob)
 * can't read as a registered server.
 */
export function claudeConfigHasRobinhood(json: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json);
    const servers = (parsed as { mcpServers?: Record<string, { url?: string }> })?.mcpServers;
    if (!servers || typeof servers !== "object") return false;
    return Object.values(servers).some((s) => (s?.url ?? "").includes(ROBINHOOD_MCP_HOST));
  } catch {
    return false;
  }
}

/**
 * Codex's config is TOML (`[mcp_servers.<name>]` + `url = "…"`). A substring check
 * is enough here — the file is hand-edited config only, with no data section a
 * stray Robinhood URL could hide in.
 */
export function codexConfigHasRobinhood(toml: string): boolean {
  return toml.includes(ROBINHOOD_MCP_HOST);
}
