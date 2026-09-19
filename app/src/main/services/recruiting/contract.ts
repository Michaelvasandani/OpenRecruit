import { listingPublishedAfter, PUBLIC_URL_DISCOVERY_INSTRUCTIONS } from "@shared/agent";
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
    name: "record_signal",
    description: "Promote one host-issued temporary evidence reference into a durable Signal.",
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
  now?: number;
}): string {
  assertSafeMaterial(input.strategyMaterial, "Discovery Strategy");
  assertSafeMaterial(input.policyMaterial, "Scout Policy");
  return [
    `Recruiting Run: ${input.runId}`,
    ...runClockLines(input.policyMaterial, input.now),
    "Use host-provided Recruiting operations for Run state, Source verification, and durable evidence.",
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

function runClockLines(policyMaterial: string, now: number | undefined): string[] {
  if (now === undefined) return [];
  const cutoff = listingPublishedAfter(policyMaterial, now);
  return [
    `Host clock: the current time is ${new Date(now).toISOString()}. Treat this as today; do not infer the date from memory.`,
    ...(cutoff === null
      ? []
      : [
          `Listing cutoff: only postings published at or after ${new Date(cutoff).toISOString()} are inside the Scout Policy window. Use this value as publishedAfter.`,
        ]),
  ];
}

export function recruitingRunWorkflowInstructions(runId: string): string {
  return [
    `Recruiting Run workflow for ${runId}:`,
    "1. Call read_run_context and list_selected_sources before discovery.",
    "",
    PUBLIC_URL_DISCOVERY_INSTRUCTIONS,
    "",
    "2. For each discovered Ashby posting URL, call AshbyInspectJobs for employer facts, publication time, listed state, and experience evidence.",
    "3. Use OpenRecruit WebSearch and WebFetch for selected Web Search Sources, HackerNewsJobs for a selected Hacker News Source, and XSearch and XRead for selected X Sources, so those Source Attempts are recorded.",
    "4. Call record_source_outcome for selected attributable Web Search or Hacker News evidence to create Signals and Fresh Leads.",
    "5. Primary evidence is preferred, not mandatory. Promote specific, current, attributable, actionable secondary evidence with an explicit verification caveat; reject generic or unsupported reposts.",
    "6. Call RecordSignal for each selected XSearch, XRead, or AshbyInspectJobs reference to create a Signal.",
    "7. Call record_checkpoint as work progresses.",
    "8. Always call complete_run with the final outcome before ending the turn.",
  ].join("\n");
}
