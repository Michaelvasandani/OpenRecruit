import {
  JevPostingFitJudge,
  type PostingFitInput,
  type PostingFitJudge,
  type PostingFitJudgment,
} from "./posting-fit";

/** Below this Choice confidence a Jev experience judgment goes to review
 * instead of deciding. A starting point; tune against recorded judgments. */
const FIT_JUDGMENT_MIN_CONFIDENCE = 0.6;
/** Below the lower bound a posting is excluded; between the bounds it is
 * returned for review. Shared by every probability Jev answers. */
const EXCLUDE_BELOW = 0.3;
const INCLUDE_FROM = 0.6;
const MAX_PROFILE_MARKDOWN_CHARS = 12_000;

/** What a Scout Run pinned about the Candidate and this Scout. Every field is
 * optional text; Jev is only asked the questions the context can support. */
export type ScreeningContext = {
  scoutBrief: string | null;
  scoutPolicy: string | null;
  candidateProfile: string | null;
};

/** The Source-neutral posting facts Jev reads. `key` is the caller's identity. */
export type ScreenablePosting = { key: string } & Omit<
  PostingFitInput,
  "scoutBrief" | "scoutPolicy" | "candidateProfile"
>;

/** `unavailable` = a judge is configured but returned nothing for this posting;
 * `undefined` = the posting was never judged. */
export type PostingJudgmentOutcome = PostingFitJudgment | "unavailable" | undefined;

export type ScreeningReason = {
  rule: string;
  outcome: "pass" | "fail" | "review";
  code: string;
};

export type ScreeningDecision = {
  decision: "include" | "exclude" | "review";
  reasons: ScreeningReason[];
};

export type PostingScreenerOptions = {
  /** Candidate-supplied TypeSafe key from Settings; enables Jev judgments. */
  typesafeApiKey?: () => string | undefined;
  /** Injected at the external model boundary for deterministic tests. */
  postingFitJudge?: PostingFitJudge;
};

/**
 * The one seam between job-posting Sources and Jev. A Source hands over
 * normalized postings and the Scout Run's pinned context; questions,
 * thresholds, and decisions live here, so a new Jev judgment reaches every
 * Source without touching any of them.
 */
export class PostingScreener {
  private readonly judge: PostingFitJudge;

  constructor(options: PostingScreenerOptions = {}) {
    this.judge =
      options.postingFitJudge ??
      new JevPostingFitJudge(options.typesafeApiKey ?? (() => undefined));
  }

  isConfigured(): boolean {
    return this.judge.isConfigured();
  }

  /** Judgments run concurrently; a failure degrades that posting to
   * `unavailable` rather than failing the caller's read. */
  async judgeAll(
    postings: ScreenablePosting[],
    context: ScreeningContext,
    signal?: AbortSignal,
  ): Promise<Map<string, PostingJudgmentOutcome>> {
    const judgments = new Map<string, PostingJudgmentOutcome>();
    if (!this.judge.isConfigured()) return judgments;
    await Promise.all(
      postings.map(async ({ key, ...posting }) => {
        const judgment = await this.judge
          .judge({ ...posting, ...context }, signal)
          .catch(() => null);
        judgments.set(key, judgment ?? "unavailable");
      }),
    );
    return judgments;
  }
}

/** Build the screening context from a Scout Run's pinned snapshots. */
export function screeningContextForRun(
  run: {
    strategySnapshot: string | null;
    policySnapshot: string | null;
    profileSnapshot: string | null;
  },
  targetRoles?: string[],
): ScreeningContext {
  const roles = (targetRoles ?? []).map((role) => role.trim()).filter(Boolean);
  const scoutBrief = [
    snapshotMaterial(run.strategySnapshot).trim(),
    roles.length > 0 ? `Target roles also include: ${roles.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    scoutBrief: scoutBrief || null,
    scoutPolicy: snapshotMaterial(run.policySnapshot).trim() || null,
    candidateProfile: candidateProfileText(run.profileSnapshot),
  };
}

/** Strategy and Policy snapshots share the `{ material }` shape. */
export function snapshotMaterial(snapshot: string | null): string {
  if (!snapshot) return "";
  try {
    const parsed: unknown = JSON.parse(snapshot);
    return isRecord(parsed) && typeof parsed.material === "string" ? parsed.material : "";
  } catch {
    return "";
  }
}

function candidateProfileText(profileSnapshot: string | null): string | null {
  if (!profileSnapshot) return null;
  try {
    const parsed: unknown = JSON.parse(profileSnapshot);
    if (!isRecord(parsed)) return null;
    const text = [
      typeof parsed.roleTarget === "string" && parsed.roleTarget.trim()
        ? `Target role: ${parsed.roleTarget.trim()}`
        : "",
      typeof parsed.markdown === "string"
        ? parsed.markdown.trim().slice(0, MAX_PROFILE_MARKDOWN_CHARS)
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Jev's judged-experience reason, or null when no judgment exists and the
 * Source should fall back to whatever deterministic reading it has.
 */
export function judgedExperienceReason(
  judgment: PostingJudgmentOutcome,
  maximumRequiredYears: number,
): ScreeningReason | null {
  if (typeof judgment !== "object") return null;
  const rule = "maximum_explicit_required_years";
  const { minimumYears, confidence } = judgment.requiredExperience;
  if (confidence < FIT_JUDGMENT_MIN_CONFIDENCE) {
    return { rule, outcome: "review", code: "judged_experience_uncertain" };
  }
  // No stated requirement and no seniority cue reads as early career.
  if (minimumYears === null) return { rule, outcome: "pass", code: "judged_experience_not_stated" };
  return minimumYears > maximumRequiredYears
    ? { rule, outcome: "fail", code: "judged_minimum_exceeds_limit" }
    : { rule, outcome: "pass", code: "judged_minimum_within_limit" };
}

/** The Source-neutral reasons: is it the kind of job this Scout looks for, and
 * is it worth keeping for this Candidate. No context or no judge, no rule. */
export function judgedFitReasons(
  judgment: PostingJudgmentOutcome,
  context: ScreeningContext,
): ScreeningReason[] {
  const briefed = context.scoutBrief !== null;
  const contextual = briefed || context.scoutPolicy !== null || context.candidateProfile !== null;
  if (judgment === "unavailable") {
    return [
      ...(briefed
        ? [{ rule: "scout_fit", outcome: "review" as const, code: "fit_judgment_unavailable" }]
        : []),
      ...(contextual
        ? [
            {
              rule: "worth_keeping",
              outcome: "review" as const,
              code: "worth_judgment_unavailable",
            },
          ]
        : []),
    ];
  }
  if (typeof judgment !== "object") return [];
  const reasons: ScreeningReason[] = [];
  // Signals recorded before a probability existed simply carry no such rule.
  const fit = judgment.scoutFitProbability ?? null;
  if (fit !== null) {
    reasons.push(
      fit < EXCLUDE_BELOW
        ? { rule: "scout_fit", outcome: "fail", code: "judged_outside_scout_brief" }
        : fit < INCLUDE_FROM
          ? { rule: "scout_fit", outcome: "review", code: "judged_fit_uncertain" }
          : { rule: "scout_fit", outcome: "pass", code: "judged_within_scout_brief" },
    );
  }
  const worth = judgment.worthKeepingProbability ?? null;
  if (worth !== null) {
    reasons.push(
      worth < EXCLUDE_BELOW
        ? { rule: "worth_keeping", outcome: "fail", code: "judged_not_worth_keeping" }
        : worth < INCLUDE_FROM
          ? { rule: "worth_keeping", outcome: "review", code: "judged_worth_uncertain" }
          : { rule: "worth_keeping", outcome: "pass", code: "judged_worth_keeping" },
    );
  }
  return reasons;
}

export function decide(reasons: ScreeningReason[]): ScreeningDecision {
  return {
    decision: reasons.some((reason) => reason.outcome === "fail")
      ? "exclude"
      : reasons.some((reason) => reason.outcome === "review")
        ? "review"
        : "include",
    reasons,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
