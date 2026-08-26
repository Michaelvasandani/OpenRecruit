import type { ScoutHarness } from "@shared/recruiting";
import { RecruitingError } from "./errors";

/**
 * The only operations a reasoning provider may receive for a Recruiting Run.
 * Source adapters, profile snapshots, policy enforcement, and durable writes
 * remain host-owned; an operation is not a general shell, SQL, or HTTP escape.
 */
export const RECRUITING_OPERATIONS = Object.freeze([
  {
    name: "read_run_context",
    description: "Read the safe, preflight-pinned Run context and bounded budget.",
  },
  {
    name: "list_selected_sources",
    description: "Read safe metadata for the Sources explicitly selected for this Run.",
  },
  {
    name: "record_checkpoint",
    description: "Commit a bounded, provider-free progress checkpoint for this Run.",
  },
  {
    name: "record_source_outcome",
    description:
      "Record a normalized Source Attempt outcome without raw credentials or transcripts.",
  },
  {
    name: "complete_run",
    description:
      "Finalize a Run with an explicit complete, incomplete, failed, or cancelled outcome.",
  },
] as const);

export type RecruitingOperationName = (typeof RECRUITING_OPERATIONS)[number]["name"];

/** Capability names explicitly prohibited at the provider boundary. */
export const PROHIBITED_RECRUITING_CAPABILITIES = Object.freeze([
  "unrestricted_sql",
  "arbitrary_http",
  "credentials",
  "posting",
  "messaging",
  "applications",
  "access_control_bypass",
] as const);

export function recruitingOperationsFor(_harness: ScoutHarness): typeof RECRUITING_OPERATIONS {
  // Keep this function deliberately provider-neutral. Claude and Codex are
  // transport implementations of the same contract, not separate policies.
  return RECRUITING_OPERATIONS;
}

export function validateRecruitingOperation(name: string): asserts name is RecruitingOperationName {
  if (!RECRUITING_OPERATIONS.some((operation) => operation.name === name)) {
    throw new RecruitingError(
      "VALIDATION",
      `Recruiting operation ${name} is not permitted; the host exposes only bounded Recruiting operations`,
    );
  }
}

/** Candidate material may describe a prohibition, but cannot grant a provider a
 * host capability that the contract deliberately does not expose. */
export function assertSafeMaterial(material: string, label: string): void {
  const unsafe = [
    /\b(?:execute|run|use|query)\s+(?:unrestricted|arbitrary|raw)?\s*sql\b/i,
    /\b(?:execute|run|use|fetch|request)\s+(?:unrestricted|arbitrary|raw)?\s*(?:https?:|https?\s+requests?\b|arbitrary\s+http\b)/i,
    /\b(?:use|read|send|exfiltrate)\s+(?:the\s+)?(?:credentials?|passwords?|cookies?|tokens?)\b/i,
    /\b(?:send|post|submit|message|apply|contact)\s+(?:to|on|for)?\s*(?:a\s+)?(?:candidate|employer|person|company|job|role|anyone)?\b/i,
    /\b(?:bypass|evade|disable|weaken)\s+(?:access|authorization|authentication|rate|control|policy|guardrail)/i,
  ];
  const unsafeClause = material.split(/[.!?;\n]+/).some((sentence) => {
    let negated = false;
    const parts = sentence.split(/(\b(?:and|or|but|then)\b)/i);
    for (const part of parts) {
      const connector = part.trim().toLowerCase();
      if (connector === "but" || connector === "then") negated = false;
      if (/\b(?:never|do not|don't|must not|cannot|can't)\b/i.test(part)) negated = true;
      if (!negated && unsafe.some((pattern) => pattern.test(part))) return true;
    }
    return false;
  });
  if (unsafeClause) {
    throw new RecruitingError(
      "VALIDATION",
      `${label} requests a prohibited capability; Recruiting Runs cannot use unrestricted SQL, arbitrary HTTP, credentials, posting, messaging, applications, or access-control bypasses`,
    );
  }
}

/** Safe provider instructions are generated from the pinned Run, never from a
 * provider transcript or an unreviewed free-form capability list. */
export function recruitingProviderInstructions(input: {
  strategyMaterial: string;
  policyMaterial: string;
  runId: string;
}): string {
  assertSafeMaterial(input.strategyMaterial, "Discovery Strategy");
  assertSafeMaterial(input.policyMaterial, "Scout Policy");
  return [
    `Recruiting Run: ${input.runId}`,
    "Use only the host-provided Recruiting operations.",
    "Read only explicitly selected public Sources through the host; do not access credentials or private content.",
    "Do not use unrestricted SQL, arbitrary HTTP, posting, messaging, applications, or access-control bypasses.",
    "Preserve bounded budgets and record safe structured outcomes; never persist provider transcripts.",
    "",
    recruitingRunWorkflowInstructions(input.runId),
    "",
    "Discovery Strategy:",
    input.strategyMaterial,
    "",
    "Scout Policy:",
    input.policyMaterial,
  ].join("\n");
}

export function recruitingRunWorkflowInstructions(runId: string): string {
  return [
    `Recruiting Run workflow for ${runId}:`,
    "1. Call read_run_context and list_selected_sources before discovery.",
    "2. Use OpenRecruit WebSearch and WebFetch (not native web tools) so Source Attempts are recorded.",
    "3. Call record_source_outcome for selected attributable evidence to create Signals and Fresh Leads.",
    "4. Call record_checkpoint as work progresses.",
    "5. Always call complete_run with the final outcome before ending the turn.",
  ].join("\n");
}
