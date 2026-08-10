import { describe, expect, test } from "bun:test";
import { claudeConfigHasRobinhood, codexConfigHasRobinhood } from "./robinhood-mcp";

/**
 * These pin the two CLIs' config shapes for the onboarding step-2 check. Both
 * fixtures mirror real files (`~/.claude.json`, `~/.codex/config.toml`) — the
 * failure that matters is a false green, which would tell a user their agents
 * can trade when they can't.
 */

describe("claudeConfigHasRobinhood", () => {
  test("finds a user-scope server regardless of the name it was added under", () => {
    const cfg = JSON.stringify({
      mcpServers: {
        "robinhood-trading": { type: "http", url: "https://agent.robinhood.com/mcp/trading" },
      },
    });
    expect(claudeConfigHasRobinhood(cfg)).toBe(true);
    expect(
      claudeConfigHasRobinhood(
        JSON.stringify({
          mcpServers: { robinhood: { url: "https://agent.robinhood.com/mcp/trading" } },
        }),
      ),
    ).toBe(true);
  });

  test("other servers alone are not a match", () => {
    const cfg = JSON.stringify({
      mcpServers: { posthog: { type: "http", url: "https://mcp.posthog.com/mcp" } },
    });
    expect(claudeConfigHasRobinhood(cfg)).toBe(false);
  });

  test("an empty or absent mcpServers map is not a match", () => {
    expect(claudeConfigHasRobinhood(JSON.stringify({ mcpServers: {} }))).toBe(false);
    expect(claudeConfigHasRobinhood(JSON.stringify({ numStartups: 12 }))).toBe(false);
  });

  test("the URL living elsewhere in the file does NOT count as configured", () => {
    // ~/.claude.json also holds history/state — a substring check would go green here.
    const cfg = JSON.stringify({
      mcpServers: {},
      projects: { "/tmp/x": { history: ["connect https://agent.robinhood.com/mcp/trading"] } },
    });
    expect(claudeConfigHasRobinhood(cfg)).toBe(false);
  });

  test("malformed JSON is a no, never a throw", () => {
    expect(claudeConfigHasRobinhood("")).toBe(false);
    expect(claudeConfigHasRobinhood("{ not json")).toBe(false);
  });
});

describe("codexConfigHasRobinhood", () => {
  test("finds the server table in config.toml", () => {
    const toml = `model = "gpt-5"

[mcp_servers.robinhood-trading]
url = "https://agent.robinhood.com/mcp/trading"
`;
    expect(codexConfigHasRobinhood(toml)).toBe(true);
  });

  test("a config without it is not a match", () => {
    const toml = `[mcp_servers.chrome-devtools]
command = "npx"
args = ["chrome-devtools-mcp@latest"]
`;
    expect(codexConfigHasRobinhood(toml)).toBe(false);
    expect(codexConfigHasRobinhood("")).toBe(false);
  });
});
