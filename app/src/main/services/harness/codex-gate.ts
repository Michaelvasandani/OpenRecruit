import { basename } from "node:path";
import type { Agent } from "@shared/agent";
import { hostLog } from "../../host/log";
import type { AgentRegistry } from "../agents/registry";
import { formatWakePrompt } from "../scheduler/wake/prompt";
import type { InteractivePush } from "../scheduler/wake/types";
import { type CodexAppServerManager, codexHomeFor } from "./codex-app-server";

/** Interactive wake delivery for Codex agents. Recruiting Run requests stay in
 * the host's durable application boundary; this seam only forwards a wake to the
 * attached local harness. */
export function buildInteractivePushFactory(
  manager: CodexAppServerManager,
  registry: AgentRegistry,
): (agent: Agent) => InteractivePush | undefined {
  return (agent) => {
    if (agent.harness !== "codex") return undefined;
    return (prompt) =>
      new Promise<boolean>((resolve) => {
        const fresh = registry.get(agent.id);
        const threadId = fresh?.lastSessionId;
        if (!fresh || !threadId) {
          resolve(false);
          return;
        }
        const codexHome = codexHomeFor(basename(registry.agentDir(fresh)));
        manager
          .runTurn(agent.id, codexHome, threadId, formatWakePrompt(prompt), {
            events: { onAccepted: () => resolve(true) },
          })
          .then((outcome) => {
            if (outcome.outcome !== "completed") resolve(false);
            else resolve(true);
          })
          .catch((err) => {
            hostLog.warn("codex interactive wake push failed", agent.id, String(err));
            resolve(false);
          });
      });
  };
}
