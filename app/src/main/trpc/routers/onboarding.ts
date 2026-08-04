import type { HarnessId } from "@shared/agent";
import { harnessFor } from "../../services/harness";
import { buildAgentEnv } from "../../services/terminal/env";
import { publicProcedure, router } from "../trpc";

function probeCli(id: HarnessId): Promise<{ found: boolean; version: string | null }> {
  // Use the same PATH agents get, so we find the CLI wherever it lives.
  return harnessFor(id).probe(buildAgentEnv("onboarding"));
}

const probeClaude = () => probeCli("claude");

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

  /** The explicit Connect action: runs the Robinhood OAuth consent flow (opens a
   *  browser, including re-consent after a dead grant) and starts polling. */
  connectBroker: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.broker.connect({ interactive: true });
    return { status: ctx.broker.getStatus(), account: ctx.broker.getAccount() };
  }),
});
