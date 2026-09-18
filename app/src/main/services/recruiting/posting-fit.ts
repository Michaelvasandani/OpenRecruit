import { createHash } from "node:crypto";

const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const MAX_CONCURRENCY = 8;
const MAX_CACHE_ENTRIES = 2_000;
/** Jev's state budget is 32k tokens; a posting body beyond this is boilerplate. */
const MAX_DESCRIPTION_CHARS = 40_000;

/** Ordered by the minimum professional experience an applicant must bring.
 * `minimumYears` is what code compares against the Scout Policy limit. */
export const EXPERIENCE_LEVELS = {
  entry_level: {
    minimumYears: 0,
    criteria:
      "New graduates, interns, or applicants with roughly 0-1 years of professional experience can qualify. Includes new-grad, junior, associate, early-career, and university roles, and postings asking for up to one year or for internships and projects only.",
  },
  two_years: {
    minimumYears: 2,
    criteria:
      "The applicant must bring about 2 years of professional experience (for example '2+ years' or '1-3 years').",
  },
  three_to_four_years: {
    minimumYears: 3,
    criteria:
      "The applicant must bring about 3-4 years of professional experience, or the role is clearly mid-level.",
  },
  five_plus_years: {
    minimumYears: 5,
    criteria:
      "The applicant must bring 5 or more years of professional experience, or the role is senior, staff, principal, lead, manager, director, or executive level even when no number is given.",
  },
  not_stated: {
    minimumYears: null,
    criteria:
      "The posting gives no required years for the applicant and no seniority cue in its title or responsibilities.",
  },
} as const;

export type ExperienceLevel = keyof typeof EXPERIENCE_LEVELS;

export type PostingFitInput = {
  title: string;
  organization: string | null;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  location: string | null;
  descriptionPlain: string;
};

/** Raw Jev answers, kept reusable: thresholds and policy live in calling code. */
export type PostingFitJudgment = {
  model: string;
  requiredExperience: {
    level: ExperienceLevel;
    minimumYears: number | null;
    confidence: number;
    probabilities: Record<string, number>;
  };
  /** Probability that this is a hands-on software, AI, or ML engineering role. */
  engineeringRoleProbability: number;
};

/** `null` means no judgment is available (no key configured, or the provider
 * failed); callers fall back to deterministic extraction. */
export interface PostingFitJudge {
  isConfigured(): boolean;
  judge(input: PostingFitInput, signal?: AbortSignal): Promise<PostingFitJudgment | null>;
}

const QUESTIONS = {
  required_experience: {
    type: "choice",
    instructions: [
      "How much prior professional experience must an applicant have to qualify for the job in `posting`?",
      "Judge only requirements placed on the applicant. Ignore every other mention of years: employee benefits and perks (sabbaticals, vesting, tenure awards), company history, founder or executive biographies, customer stories, and legal notices.",
      "Treat 'preferred', 'nice to have', and 'bonus' experience as not required. When a range is given, use its lower bound.",
    ],
    criteria: Object.fromEntries(
      Object.entries(EXPERIENCE_LEVELS).map(([level, { criteria }]) => [level, criteria]),
    ),
  },
  engineering_role: {
    type: "noul",
    instructions:
      "Is the job in `posting` a hands-on software, AI, or machine learning engineering role whose main work is writing code?",
    criteria: {
      true: "Software, AI, ML, data, infrastructure, agent, or forward-deployed engineer who builds software.",
      false:
        "Sales, support, operations, legal, finance, design, recruiting, product or program management, or other roles where writing code is not the main work.",
    },
  },
} as const;

export type PostingFitFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

/** Host-owned Jev adapter. The API key is read per call so Settings changes
 * apply without a restart; it never appears in results or errors. */
export class JevPostingFitJudge implements PostingFitJudge {
  private readonly cache = new Map<string, PostingFitJudgment>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly fetchImpl: PostingFitFetch = fetch as unknown as PostingFitFetch,
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  isConfigured(): boolean {
    return this.apiKey() !== undefined;
  }

  async judge(input: PostingFitInput, signal?: AbortSignal): Promise<PostingFitJudgment | null> {
    const apiKey = this.apiKey();
    if (!apiKey) return null;
    const posting = {
      title: input.title,
      organization: input.organization,
      department: input.department,
      team: input.team,
      employmentType: input.employmentType,
      location: input.location,
      description: input.descriptionPlain.slice(0, MAX_DESCRIPTION_CHARS),
    };
    // Judgments depend only on posting content, so unchanged postings are free
    // on later inspections within this host's lifetime.
    const cacheKey = createHash("sha256")
      .update(JSON.stringify([posting, QUESTIONS]))
      .digest("hex");
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    await this.acquire();
    try {
      const judgment = await this.request(apiKey, posting, signal);
      if (judgment) {
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(cacheKey, judgment);
      }
      return judgment;
    } catch {
      return null;
    } finally {
      this.release();
    }
  }

  private async request(
    apiKey: string,
    posting: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PostingFitJudgment | null> {
    const body = JSON.stringify({ state: { posting }, model: JEV_MODEL, questions: QUESTIONS });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await this.fetchImpl(TYPESAFE_SYSTEMONE_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.status >= 200 && response.status < 300) {
        return parseJudgment(await response.json());
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) return null;
      const retryAfter = Number(response.headers?.get("retry-after"));
      await this.delay(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1_000, 10_000)
          : 500 * 2 ** (attempt - 1),
      );
    }
    return null;
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENCY) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

/** Typed output guarantees the interface, not our trust in it: anything that
 * does not match the documented answer shape is treated as no judgment. */
function parseJudgment(body: unknown): PostingFitJudgment | null {
  if (!isRecord(body) || !isRecord(body.answers)) return null;
  const experience = body.answers.required_experience;
  const engineering = body.answers.engineering_role;
  if (!isRecord(experience) || !isRecord(engineering)) return null;
  const level = experience.choice;
  const confidence = probability(experience.confidence);
  const engineeringRoleProbability = probability(engineering.noul);
  if (
    typeof level !== "string" ||
    !(level in EXPERIENCE_LEVELS) ||
    confidence === null ||
    engineeringRoleProbability === null
  ) {
    return null;
  }
  const probabilities: Record<string, number> = {};
  if (isRecord(experience.probabilities)) {
    for (const [option, value] of Object.entries(experience.probabilities)) {
      const parsed = probability(value);
      if (option in EXPERIENCE_LEVELS && parsed !== null) probabilities[option] = parsed;
    }
  }
  return {
    model: typeof body.model === "string" ? body.model : JEV_MODEL,
    requiredExperience: {
      level: level as ExperienceLevel,
      minimumYears: EXPERIENCE_LEVELS[level as ExperienceLevel].minimumYears,
      confidence,
      probabilities,
    },
    engineeringRoleProbability,
  };
}
