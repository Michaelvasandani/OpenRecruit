import { randomUUID } from "node:crypto";
import type { SourceAttemptSummary } from "@shared/recruiting";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  scoutRuns,
  scoutSources,
  scouts,
  sourceAccess,
  sourceAttempts,
  sources,
} from "../../db/schema";
import { RecruitingError, type RecruitingFailureCategory } from "./errors";
import type { PostingFitJudgment } from "./posting-fit";
import {
  decide,
  judgedFitReasons,
  PostingScreener,
  type ScreeningDecision,
  screeningContextForRun,
} from "./posting-screen";

export const HACKER_NEWS_SOURCE_ID = "source-hacker-news";
export const HACKER_NEWS_SOURCE_KIND = "hacker_news";
export const HACKER_NEWS_OPERATION = "hacker_news_jobs";

const ACTIVE_RUN_STATUSES = ["queued", "preflight", "running", "finalizing"] as const;
const ALGOLIA_BASE_URL = "https://hn.algolia.com/api/v1";
const HN_ITEM_URL = "https://news.ycombinator.com/item?id=";
const HIRING_THREAD_TITLE = /^ask hn: who is hiring\?/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PAGE = 20;
const MAX_QUERY_LENGTH = 200;
const MAX_TITLE_LENGTH = 500;
const MAX_CONTENT_LENGTH = 8_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
// Replies share the thread's story tag, so over-fetch and keep only top-level postings.
const HIRING_PAGE_SIZE = 100;
const MAX_REMEMBERED_ATTEMPTS = 200;

export type HackerNewsJobsMode = "who_is_hiring" | "job_stories";

export type HackerNewsJobsRequest = {
  mode?: HackerNewsJobsMode;
  query?: string;
  limit?: number;
  page?: number;
};

export type HackerNewsProviderResponse = {
  status: number;
  json: unknown;
  retryAfterMs?: number | null;
};

/** The application owns every URL; the provider only performs the bounded GET. */
export interface HackerNewsProvider {
  getJson(url: string, signal?: AbortSignal): Promise<HackerNewsProviderResponse>;
}

export type HackerNewsJobPosting = {
  id: string;
  kind: "hiring_comment" | "job_story";
  canonicalUrl: string;
  /** The poster's own link for a job story; never fetched by this tool. */
  externalUrl: string | null;
  title: string;
  content: string;
  author: string | null;
  publishedAt: number | null;
  /** Jev's reading of the posting, when a TypeSafe key is configured. */
  fitJudgment: PostingFitJudgment | null;
  /** Whether the posting is worth keeping for this Candidate and Scout. Null
   * when no judge is configured; an excluded posting cannot become a Signal. */
  screening: ScreeningDecision | null;
};

export type HackerNewsJobsResponse = {
  mode: HackerNewsJobsMode;
  query: string;
  page: number;
  thread: { id: string; title: string; canonicalUrl: string; publishedAt: number | null } | null;
  sourceAttemptId: string;
  retrievedAt: number;
  provenance: {
    provider: "hn-algolia";
    sourceId: string;
    runId: string;
    scoutId: string;
  };
  /** True when Jev screened the postings against the Candidate Profile, the
   * Scout's Discovery Strategy, and the Scout Policy. */
  screened: boolean;
  summary: { includeCount: number; reviewCount: number; excludeCount: number };
  results: HackerNewsJobPosting[];
};

export type SelectedHackerNewsEvidence = {
  canonicalUrl: string;
  title: string;
  content: string;
  publicationAt: number | null;
  fitJudgment?: PostingFitJudgment;
};

export type HackerNewsApplicationOptions = {
  hackerNewsProvider?: HackerNewsProvider;
  /** The shared Jev seam. Without a configured judge, nothing is screened. */
  postingScreener?: PostingScreener;
};

type UnscreenedPosting = Omit<HackerNewsJobPosting, "fitJudgment" | "screening">;
type RememberedPosting = SelectedHackerNewsEvidence & { excluded: boolean };

type HackerNewsAttemptDetails = {
  operation: typeof HACKER_NEWS_OPERATION;
  provider: "hn-algolia";
  mode: HackerNewsJobsMode;
  query: string;
  page: number;
  limit: number;
  threadId: string | null;
  returnedUrls: string[];
  retryAt: number | null;
  errorCategory: string | null;
  startedAt: number;
  completedAt: number | null;
};

export class HackerNewsProviderError extends Error {
  constructor(
    readonly category: "rate_limited" | "transient_failure" | "provider_failure",
    readonly retryAt: number | null = null,
  ) {
    super(category);
    this.name = "HackerNewsProviderError";
  }
}

/** Production adapter for the public, unauthenticated HN Search API. */
export class HttpHackerNewsProvider implements HackerNewsProvider {
  async getJson(url: string, signal?: AbortSignal): Promise<HackerNewsProviderResponse> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3_600) * 1_000 : null;
    if (!response.ok) return { status: response.status, json: null, retryAfterMs };
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return { status: 502, json: null };
    try {
      return { status: response.status, json: JSON.parse(text), retryAfterMs };
    } catch {
      return { status: 502, json: null };
    }
  }
}

/** A deterministic provider for tests and local host simulations. It never
 * performs network I/O. */
export class DeterministicHackerNewsProvider implements HackerNewsProvider {
  readonly requests: string[] = [];

  constructor(private readonly fixtures: Record<string, HackerNewsProviderResponse>) {}

  async getJson(url: string): Promise<HackerNewsProviderResponse> {
    this.requests.push(url);
    return this.fixtures[url] ?? { status: 404, json: null };
  }
}

export class HackerNewsApplication {
  private readonly provider: HackerNewsProvider;
  private readonly screener: PostingScreener;
  private readonly readEvidence = new Map<
    string,
    { scoutId: string; postings: Map<string, RememberedPosting> }
  >();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    options: HackerNewsApplicationOptions = {},
  ) {
    this.provider = options.hackerNewsProvider ?? new HttpHackerNewsProvider();
    this.screener = options.postingScreener ?? new PostingScreener();
  }

  /** True when the Attempt was issued by this application, so evidence selection
   * can be routed without parsing another lane's Attempt details. */
  ownsAttempt(sourceAttemptId: string): boolean {
    const attempt = this.db
      .select({ sourceId: sourceAttempts.sourceId })
      .from(sourceAttempts)
      .where(eq(sourceAttempts.id, sourceAttemptId))
      .get();
    return attempt?.sourceId === HACKER_NEWS_SOURCE_ID;
  }

  async jobs(
    command: HackerNewsJobsRequest & { scoutId: string; signal?: AbortSignal },
  ): Promise<HackerNewsJobsResponse> {
    const scout = this.db.select().from(scouts).where(eq(scouts.id, command.scoutId)).get();
    if (!scout) throw new RecruitingError("NOT_FOUND", `Scout ${command.scoutId} was not found`);
    if (scout.lifecycleState !== "active") {
      throw new RecruitingError("CONFLICT", "Archived Scouts cannot read Hacker News");
    }
    const run = this.db
      .select()
      .from(scoutRuns)
      .where(
        and(eq(scoutRuns.scoutId, scout.id), inArray(scoutRuns.status, [...ACTIVE_RUN_STATUSES])),
      )
      .orderBy(asc(scoutRuns.createdAt), asc(scoutRuns.id))
      .get();
    if (!run) throw new RecruitingError("CONFLICT", `Scout ${scout.id} has no active Scout Run`);
    const source = this.db
      .select()
      .from(sources)
      .where(eq(sources.id, HACKER_NEWS_SOURCE_ID))
      .get();
    if (!source) throw new RecruitingError("NOT_FOUND", "Hacker News Source was not found");
    const snapshotSourceIds = parseSnapshotSourceIds(run.overrideSnapshot);
    const selected = snapshotSourceIds
      ? snapshotSourceIds.includes(source.id)
      : Boolean(
          this.db
            .select({ sourceId: scoutSources.sourceId })
            .from(scoutSources)
            .where(and(eq(scoutSources.scoutId, scout.id), eq(scoutSources.sourceId, source.id)))
            .get(),
        );
    const access = this.db
      .select()
      .from(sourceAccess)
      .where(
        and(
          eq(sourceAccess.sourceId, source.id),
          eq(sourceAccess.accountRef, ""),
          eq(sourceAccess.scopeKey, "public"),
        ),
      )
      .get();

    const attemptId = randomUUID();
    const startedAt = this.now();
    let details: HackerNewsAttemptDetails = {
      operation: HACKER_NEWS_OPERATION,
      provider: "hn-algolia",
      mode: "who_is_hiring",
      query: "",
      page: 0,
      limit: DEFAULT_LIMIT,
      threadId: null,
      returnedUrls: [],
      retryAt: null,
      errorCategory: null,
      startedAt,
      completedAt: null,
    };
    this.insertAttempt(attemptId, run.id, source.id, details, startedAt);
    const reject = (
      message: string,
      code: "CONFLICT" | "VALIDATION" | "NOT_FOUND",
      category: RecruitingFailureCategory,
    ): never => {
      this.completeAttempt(attemptId, "rejected", { ...details, errorCategory: category }, message);
      throw new RecruitingError(code, message, category);
    };

    let request: NormalizedRequest;
    try {
      request = normalizeHackerNewsRequest(command);
    } catch (error) {
      return reject(
        error instanceof RecruitingError ? error.message : "HackerNewsJobs request was rejected",
        "VALIDATION",
        "invalid_input",
      );
    }
    details = { ...details, ...request };
    if (!selected) {
      return reject(
        "Hacker News is not enabled for this Scout",
        "CONFLICT",
        "disabled_source_access",
      );
    }
    if (!access) {
      return reject(
        "Hacker News Source Access was not found",
        "NOT_FOUND",
        "missing_source_access",
      );
    }
    if (access.readiness === "candidate_disabled") {
      return reject("The Candidate disabled Hacker News", "CONFLICT", "disabled_source_access");
    }

    let thread: HackerNewsJobsResponse["thread"] = null;
    let postings: UnscreenedPosting[];
    try {
      if (request.mode === "who_is_hiring") {
        thread = await this.latestHiringThread(command.signal);
        details = { ...details, threadId: thread?.id ?? null };
        postings = thread ? await this.hiringComments(thread, request, command.signal) : [];
      } else {
        postings = await this.jobStories(request, command.signal);
      }
    } catch (error) {
      const providerError = error instanceof HackerNewsProviderError ? error : null;
      const category = providerError?.category ?? "provider_failure";
      const message = safeProviderMessage(category);
      this.completeAttempt(
        attemptId,
        category === "provider_failure" ? "rejected" : category,
        { ...details, retryAt: providerError?.retryAt ?? null, errorCategory: category },
        message,
      );
      throw new RecruitingError(
        "CONFLICT",
        message,
        category === "transient_failure" ? "exhausted_transient_failure" : category,
      );
    }

    const results = await this.screen(postings, run, command.signal);
    details = { ...details, returnedUrls: results.map((result) => result.canonicalUrl) };
    this.completeAttempt(
      attemptId,
      results.length > 0 ? "succeeded_with_items" : "succeeded_empty",
      details,
      null,
    );
    this.rememberEvidence(attemptId, scout.id, results);
    return {
      mode: request.mode,
      query: request.query,
      page: request.page,
      thread,
      sourceAttemptId: attemptId,
      retrievedAt: this.now(),
      provenance: {
        provider: "hn-algolia",
        sourceId: source.id,
        runId: run.id,
        scoutId: scout.id,
      },
      screened: this.screener.isConfigured(),
      summary: {
        includeCount: results.filter((r) => r.screening?.decision === "include").length,
        reviewCount: results.filter((r) => r.screening?.decision === "review").length,
        excludeCount: results.filter((r) => r.screening?.decision === "exclude").length,
      },
      results,
    };
  }

  /** Jev decides whether each posting is worth keeping, judged against the
   * Run's pinned Candidate Profile, Discovery Strategy, and Scout Policy. A
   * judging failure leaves the posting for review; it never fails the read. */
  private async screen(
    postings: UnscreenedPosting[],
    run: {
      strategySnapshot: string | null;
      policySnapshot: string | null;
      profileSnapshot: string | null;
    },
    signal?: AbortSignal,
  ): Promise<HackerNewsJobPosting[]> {
    if (!this.screener.isConfigured()) {
      return postings.map((posting) => ({ ...posting, fitJudgment: null, screening: null }));
    }
    const context = screeningContextForRun(run);
    const judgments = await this.screener.judgeAll(
      postings.map((posting) => ({
        key: posting.id,
        title: posting.title,
        // HN postings are free text: the organization and location are in the body.
        organization: null,
        department: null,
        team: null,
        employmentType: null,
        location: null,
        descriptionPlain: posting.content,
      })),
      context,
      signal,
    );
    return postings.map((posting) => {
      const judgment = judgments.get(posting.id);
      return {
        ...posting,
        fitJudgment: typeof judgment === "object" ? judgment : null,
        screening: decide(judgedFitReasons(judgment, context)),
      };
    });
  }

  /** Resolve Scout-selected postings to the exact content this host read. */
  selectEvidence(input: {
    scoutId: string;
    sourceAttemptId: string;
    canonicalUrls: string[];
  }): SelectedHackerNewsEvidence[] {
    const cached = this.readEvidence.get(input.sourceAttemptId);
    if (!cached || cached.scoutId !== input.scoutId) {
      throw new RecruitingError(
        "NOT_FOUND",
        "Hacker News evidence is no longer available; call HackerNewsJobs again",
      );
    }
    if (
      !Array.isArray(input.canonicalUrls) ||
      input.canonicalUrls.length < 1 ||
      input.canonicalUrls.length > 100
    ) {
      throw new RecruitingError("VALIDATION", "Select between 1 and 100 Hacker News postings");
    }
    return input.canonicalUrls.map((value) => {
      const posting = typeof value === "string" ? cached.postings.get(value.trim()) : undefined;
      if (!posting) {
        throw new RecruitingError(
          "VALIDATION",
          "Selected evidence URL was not returned by this HackerNewsJobs Attempt",
        );
      }
      if (posting.excluded) {
        throw new RecruitingError(
          "CONFLICT",
          "Jev judged this Hacker News posting not worth keeping for this Scout; it cannot be promoted to a Signal",
        );
      }
      const { excluded: _excluded, ...evidence } = posting;
      return evidence;
    });
  }

  private async latestHiringThread(
    signal?: AbortSignal,
  ): Promise<HackerNewsJobsResponse["thread"]> {
    const hits = await this.hits(
      `${ALGOLIA_BASE_URL}/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`,
      signal,
    );
    for (const hit of hits) {
      const id = itemId(hit.objectID);
      const title = typeof hit.title === "string" ? normalizeText(hit.title, MAX_TITLE_LENGTH) : "";
      if (id && HIRING_THREAD_TITLE.test(title)) {
        return { id, title, canonicalUrl: `${HN_ITEM_URL}${id}`, publishedAt: publishedAt(hit) };
      }
    }
    return null;
  }

  private async hiringComments(
    thread: NonNullable<HackerNewsJobsResponse["thread"]>,
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<UnscreenedPosting[]> {
    const params = new URLSearchParams({
      tags: `comment,story_${thread.id}`,
      query: request.query,
      hitsPerPage: String(HIRING_PAGE_SIZE),
      page: String(request.page),
    });
    const hits = await this.hits(`${ALGOLIA_BASE_URL}/search_by_date?${params}`, signal);
    const postings: UnscreenedPosting[] = [];
    for (const hit of hits) {
      const id = itemId(hit.objectID);
      if (!id || String(hit.parent_id) !== thread.id) continue;
      const content = htmlToText(hit.comment_text, MAX_CONTENT_LENGTH);
      if (!content) continue;
      postings.push({
        id,
        kind: "hiring_comment",
        canonicalUrl: `${HN_ITEM_URL}${id}`,
        externalUrl: null,
        // By convention the first line is "Company | Role | Location | ...".
        title: normalizeText(content.split("\n")[0] ?? "", MAX_TITLE_LENGTH),
        content,
        author: author(hit),
        publishedAt: publishedAt(hit),
      });
      if (postings.length >= request.limit) break;
    }
    return postings;
  }

  private async jobStories(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<UnscreenedPosting[]> {
    const params = new URLSearchParams({
      tags: "job",
      query: request.query,
      hitsPerPage: String(request.limit),
      page: String(request.page),
    });
    const hits = await this.hits(`${ALGOLIA_BASE_URL}/search_by_date?${params}`, signal);
    const postings: UnscreenedPosting[] = [];
    for (const hit of hits) {
      const id = itemId(hit.objectID);
      const title = typeof hit.title === "string" ? normalizeText(hit.title, MAX_TITLE_LENGTH) : "";
      if (!id || !title) continue;
      const externalUrl = publicHttpUrl(hit.url);
      const body = htmlToText(hit.story_text, MAX_CONTENT_LENGTH);
      postings.push({
        id,
        kind: "job_story",
        canonicalUrl: `${HN_ITEM_URL}${id}`,
        externalUrl,
        title,
        content: [title, body, externalUrl].filter(Boolean).join("\n\n"),
        author: author(hit),
        publishedAt: publishedAt(hit),
      });
    }
    return postings.slice(0, request.limit);
  }

  private async hits(url: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    let response: HackerNewsProviderResponse;
    try {
      response = await this.provider.getJson(url, signal);
    } catch {
      throw new HackerNewsProviderError("transient_failure");
    }
    if (response.status === 429) {
      throw new HackerNewsProviderError(
        "rate_limited",
        this.now() + (response.retryAfterMs ?? 60_000),
      );
    }
    if (response.status >= 500) throw new HackerNewsProviderError("transient_failure");
    const hits = isRecord(response.json) ? response.json.hits : null;
    if (response.status !== 200 || !Array.isArray(hits)) {
      throw new HackerNewsProviderError("provider_failure");
    }
    return hits.filter(isRecord);
  }

  private rememberEvidence(
    sourceAttemptId: string,
    scoutId: string,
    results: HackerNewsJobPosting[],
  ): void {
    const postings = new Map<string, RememberedPosting>();
    for (const result of results) {
      postings.set(result.canonicalUrl, {
        canonicalUrl: result.canonicalUrl,
        title: result.title,
        content: result.content,
        publicationAt: result.publishedAt,
        ...(result.fitJudgment ? { fitJudgment: result.fitJudgment } : {}),
        excluded: result.screening?.decision === "exclude",
      });
    }
    this.readEvidence.set(sourceAttemptId, { scoutId, postings });
    while (this.readEvidence.size > MAX_REMEMBERED_ATTEMPTS) {
      const oldest = this.readEvidence.keys().next().value;
      if (typeof oldest !== "string") break;
      this.readEvidence.delete(oldest);
    }
  }

  private insertAttempt(
    id: string,
    runId: string,
    sourceId: string,
    details: HackerNewsAttemptDetails,
    startedAt: number,
  ): void {
    this.db
      .insert(sourceAttempts)
      .values({
        id,
        runId,
        sourceId,
        requestedScope: JSON.stringify(details),
        cursor: null,
        outcome: "started",
        itemCount: 0,
        quarantinedCount: 0,
        pageCount: 0,
        retryAt: null,
        safeFailure: null,
        startedAt,
        completedAt: null,
      })
      .run();
  }

  private completeAttempt(
    id: string,
    outcome: SourceAttemptSummary["outcome"],
    details: HackerNewsAttemptDetails,
    safeFailure: string | null,
  ): void {
    const completedAt = this.now();
    this.db
      .update(sourceAttempts)
      .set({
        requestedScope: JSON.stringify({ ...details, completedAt }),
        outcome,
        itemCount: details.returnedUrls.length,
        retryAt: details.retryAt,
        safeFailure,
        completedAt,
      })
      .where(eq(sourceAttempts.id, id))
      .run();
  }
}

type NormalizedRequest = {
  mode: HackerNewsJobsMode;
  query: string;
  limit: number;
  page: number;
};

export function normalizeHackerNewsRequest(request: HackerNewsJobsRequest): NormalizedRequest {
  const mode = request.mode ?? "who_is_hiring";
  if (mode !== "who_is_hiring" && mode !== "job_stories") {
    throw new RecruitingError(
      "VALIDATION",
      "HackerNewsJobs mode must be who_is_hiring or job_stories",
    );
  }
  if (request.query !== undefined && typeof request.query !== "string") {
    throw new RecruitingError("VALIDATION", "HackerNewsJobs query must be a string");
  }
  const query = (request.query ?? "").replace(/\s+/g, " ").trim();
  if (query.length > MAX_QUERY_LENGTH) {
    throw new RecruitingError(
      "VALIDATION",
      `HackerNewsJobs query is limited to ${MAX_QUERY_LENGTH} characters`,
    );
  }
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RecruitingError("VALIDATION", `HackerNewsJobs limit must be 1 to ${MAX_LIMIT}`);
  }
  const page = request.page ?? 0;
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
    throw new RecruitingError("VALIDATION", `HackerNewsJobs page must be 0 to ${MAX_PAGE}`);
  }
  return { mode, query, limit, page };
}

/** HN stores comment bodies as a small HTML subset; keep paragraphs and link targets. */
export function htmlToText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gis, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => codePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function codePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

function normalizeText(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function itemId(value: unknown): string | null {
  const id = typeof value === "number" ? String(value) : value;
  return typeof id === "string" && /^\d{1,12}$/.test(id) ? id : null;
}

function author(hit: Record<string, unknown>): string | null {
  return typeof hit.author === "string" && hit.author ? normalizeText(hit.author, 100) : null;
}

function publishedAt(hit: Record<string, unknown>): number | null {
  const seconds = hit.created_at_i;
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds > 0
    ? seconds * 1_000
    : null;
}

function publicHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString().slice(0, 2_000);
  } catch {
    return null;
  }
}

function safeProviderMessage(category: HackerNewsProviderError["category"]): string {
  if (category === "rate_limited") return "Hacker News search is rate limited; retry later";
  if (category === "transient_failure") {
    return "Hacker News search is temporarily unavailable; retry later";
  }
  return "Hacker News search returned an unusable response";
}

function parseSnapshotSourceIds(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { sourceIds?: unknown };
    return Array.isArray(parsed.sourceIds)
      ? parsed.sourceIds.filter((id): id is string => typeof id === "string")
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
