import type { HarnessId } from "@shared/agent";
import { harnessFor, ROBINHOOD_MCP_CONNECT_URL } from "../../services/harness";
import { buildAgentEnv } from "../../services/terminal/env";
import { publicProcedure, router } from "../trpc";

function probeCli(id: HarnessId): Promise<{ found: boolean; version: string | null }> {
  // Use the same PATH agents get, so we find the CLI wherever it lives.
  return harnessFor(id).probe(buildAgentEnv("onboarding"));
}

const probeClaude = () => probeCli("claude");

/** Is the Robinhood MCP registered in one CLI's config? Never throws — an
 *  unregistered harness (codex before its manager is wired) just reads as "no". */
function mcpConfigured(id: HarnessId): boolean {
  try {
    return harnessFor(id).robinhoodMcpConfigured();
  } catch {
    return false;
  }
}

export const onboardingRouter = router({
  state: publicProcedure.query(async ({ ctx }) => {
    const claude = await probeClaude();
    return {
      claude,
      brokerStatus: ctx.broker.getStatus(),
      brokerAuthorized: ctx.broker.isAuthorized(),
      brokerAccount: ctx.broker.getAccount(),
    };
  }),

  checkClaudeCli: publicProcedure.query(() => probeClaude()),

  /** Probe every supported agent CLI (the onboarding step + the harness picker). */
  harnesses: publicProcedure.query(async () => ({
    claude: await probeClaude(),
    codex: await probeCli("codex"),
  })),

  /**
   * Is Robinhood's Agentic Trading MCP registered in each agent CLI's config?
   * (Onboarding step 2.) Agents place orders through this MCP, so a user who
   * never registered it gets an agent that can reason but not trade — the wizard
   * says so up front and links Robinhood's connect guide. Two file reads, no
   * CLI launch: this reports what's configured, not whether it's authenticated.
   *
   * We return only the verdict and the guide link — never the `mcp add` commands.
   * Those are Robinhood's and the CLIs' to document; restating them here would rot
   * silently the moment either changes its syntax.
   */
  robinhoodMcp: publicProcedure.query(() => ({
    claude: { configured: mcpConfigured("claude") },
    codex: { configured: mcpConfigured("codex") },
    connectUrl: ROBINHOOD_MCP_CONNECT_URL,
  })),

  /** The explicit Connect action: runs the Robinhood OAuth consent flow (opens a
   *  browser, including re-consent after a dead grant) and starts polling. */
  connectBroker: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.broker.connect({ interactive: true });
    return { status: ctx.broker.getStatus(), account: ctx.broker.getAccount() };
  }),
});
