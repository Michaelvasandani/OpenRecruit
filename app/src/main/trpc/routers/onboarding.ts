import type { HarnessId } from "@shared/agent";
import { harnessFor } from "../../services/harness";
import { buildAgentEnv } from "../../services/terminal/env";
import { publicProcedure, router } from "../trpc";

function probeCli(id: HarnessId): Promise<{ found: boolean; version: string | null }> {
  return harnessFor(id).probe(buildAgentEnv("onboarding"));
}

const probeClaude = () => probeCli("claude");

/** First-run checks for the local agent runtime. Recruiting Sources are configured
 * from the Candidate workspace after onboarding; no provider account is required. */
export const onboardingRouter = router({
  state: publicProcedure.query(async () => ({ claude: await probeClaude() })),
  checkClaudeCli: publicProcedure.query(() => probeClaude()),
  harnesses: publicProcedure.query(async () => ({
    claude: await probeClaude(),
    codex: await probeCli("codex"),
  })),
});
