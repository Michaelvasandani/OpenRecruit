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
import { ASHBY_SOURCE_ID } from "./ashby";
import { ATS_ADAPTERS, ATS_PROVIDERS, type AtsProvider, routeBoard } from "./ats-boards";
import { RecruitingError, type RecruitingFailureCategory } from "./errors";

const ACTIVE_RUN_STATUSES = ["queued", "preflight", "running", "finalizing"] as const;
const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_LIMIT = 100;
const MAX_QUERY_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 500;
const MAX_EXCERPT_LENGTH = 1_000;
const COMPACT_EXCERPT_LENGTH = 200;
const MAX_LOCATION_LENGTH = 100;
const MAX_REQUEST_ID_LENGTH = 200;
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const ASHBY_HOST = "jobs.ashbyhq.com";
const ASHBY_BOARD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const LOCATION_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ,.'-]*$/u;

/** Hosts a job-board Source may search for discovery without the Web Search
 * Source, keyed by the job-board Source id. */
const JOB_BOARD_SEARCH_HOSTS: Record<string, readonly string[]> = {
  [ASHBY_SOURCE_ID]: [ASHBY_HOST],
  ...Object.fromEntries(
    ATS_PROVIDERS.map((provider) => [
      ATS_ADAPTERS[provider].sourceId,
      provider === "greenhouse"
        ? [
            "job-boards.greenhouse.io",
            "boards.greenhouse.io",
            "job-boards.eu.greenhouse.io",
            "boards.eu.greenhouse.io",
          ]
        : [ATS_ADAPTERS[provider].searchSite],
    ]),
  ),
};

export const WEB_SEARCH_RECENCIES = ["day", "week", "month", "year"] as const;
export type WebSearchRecency = (typeof WEB_SEARCH_RECENCIES)[number];

export type WebSearchRequest = {
  query: string;
  limit?: number;
  /** Only pages the search engine dates inside the past day, week, month, or year. */
  recency?: WebSearchRecency;
  /** Only pages the search engine dates on or after this ISO date. */
  publishedAfter?: string;
  /** Newest pages first. */
  sortByDate?: boolean;
  /** Where the search runs from. A ranking hint, never a job-location filter. */
  location?: string;
  /** Title, URL, and a short excerpt only, for broad discovery searches. */
  compact?: boolean;
};

/** The query keeps its site: operators. Firecrawl's includeDomains field caps
 * a search at 10 results whatever the limit, while site: in the query returns
 * the full limit; the host still filters results by domain afterwards. */
export type WebSearchProviderRequest = {
  query: string;
  limit: number;
  /** Google-style time filter, for example "sbd:1,qdr:w". */
  tbs?: string;
  location?: string;
};

export type WebSearchProviderResult = {
  title?: string | null;
  url: string;
  description?: string | null;
  highlights?: string[] | null;
  publishedAt?: string | number | null;
};

export type WebSearchProviderResponse = {
  requestId?: string | null;
  creditsUsed?: number | null;
  retryCount?: number;
  retryAt?: number | null;
  results: WebSearchProviderResult[];
};

export interface WebSearchProvider {
  search(request: WebSearchProviderRequest): Promise<WebSearchProviderResponse>;
}

export type WebSearchProvenance = {
  provider: string;
  requestId: string | null;
  sourceId: string;
  runId: string;
  scoutId: string;
};

export type WebSearchResult = {
  title: string;
  canonicalUrl: string;
  excerpt: string;
  publishedAt: number | null;
  retrievedAt: number;
};

/** A company job board a result points at, ready for AshbyInspectJobs or
 * JobPostingInspect board enumeration. */
export type WebSearchJobBoard = {
  source: "ashby" | AtsProvider;
  board: string;
  boardUrl: string;
  resultCount: number;
};

export type WebSearchResponse = {
  query: string;
  providerQuery: string;
  appliedDomainRestrictions: string[];
  unsupportedOperators: string[];
  appliedFilters: { tbs: string | null; location: string | null };
  sourceAttemptId: string;
  retrievedAt: number;
  provenance: WebSearchProvenance;
  results: WebSearchResult[];
  jobBoards: WebSearchJobBoard[];
};

export type WebSearchApplicationOptions = {
  provider?: WebSearchProvider;
  apiKey?: () => string | undefined;
};

type NormalizedQuery = {
  original: string;
  providerQuery: string;
  includeDomains: string[];
  unsupportedOperators: string[];
};

type NormalizedFilters = {
  tbs: string | null;
  location: string | null;
  compact: boolean;
};

type WebSearchAttemptDetails = {
  operation: "web_search";
  provider: string;
  query: string;
  providerQuery: string;
  normalizedQuery: string;
  includeDomains: string[];
  unsupportedOperators: string[];
  limit: number | null;
  tbs: string | null;
  location: string | null;
  requestId: string | null;
  creditsUsed: number | null;
  returnedUrls: string[];
  retryCount: number;
  retryAt: number | null;
  retryDisposition: "not_retried" | "recovered" | "exhausted" | "mixed";
  errorCategory: string | null;
  attemptCount: number;
  emptyResultRetried: boolean;
  startedAt: number;
  completedAt: number | null;
};

/** A deterministic provider for high-level recruiting tests. It never performs
 * network I/O and records only the normalized, safe request. */
export class DeterministicWebSearchProvider implements WebSearchProvider {
  readonly requests: WebSearchProviderRequest[] = [];
  private readonly responses: Map<string, WebSearchProviderResult[]>;

  constructor(fixtures: Record<string, WebSearchProviderResult[]>) {
    this.responses = new Map(
      Object.entries(fixtures).map(([query, results]) => [
        query,
        results.map((result) => ({ ...result })),
      ]),
    );
  }

  async search(request: WebSearchProviderRequest): Promise<WebSearchProviderResponse> {
    this.requests.push({ ...request });
    return {
      requestId: `deterministic-${this.requests.length}`,
      creditsUsed: 0,
      results: (this.responses.get(request.query) ?? []).slice(0, request.limit),
    };
  }
}

export class WebSearchProviderError extends Error {
  constructor(
    readonly category:
      | "not_configured"
      | "authentication"
      | "rate_limited"
      | "transient_failure"
      | "invalid_request"
      | "provider_failure",
    message: string,
    readonly requestId: string | null = null,
    readonly creditsUsed: number | null = null,
    readonly retryCount = 0,
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "WebSearchProviderError";
  }
}

/** Firecrawl Cloud adapter. Provider details stop at this boundary: the rest
 * of Recruiting sees only normalized results and safe provenance. */
export class FirecrawlWebSearchProvider implements WebSearchProvider {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(request: WebSearchProviderRequest): Promise<WebSearchProviderResponse> {
    const key = this.apiKey()?.trim();
    if (!key) throw new WebSearchProviderError("not_configured", "Firecrawl is not configured");
    const body = {
      query: request.query,
      limit: request.limit,
      ...(request.tbs ? { tbs: request.tbs } : {}),
      ...(request.location ? { location: request.location } : {}),
    };
    let response: Response | undefined;
    let retryCount = 0;
    let retryAt: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.fetchImpl(FIRECRAWL_SEARCH_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (_error) {
        if (attempt === 0) {
          retryCount = 1;
          retryAt = Date.now();
          continue;
        }
        throw new WebSearchProviderError(
          "transient_failure",
          "Firecrawl is temporarily unavailable",
          null,
          null,
          retryCount,
          retryAt,
        );
      }
      if (response.ok) break;
      const requestId = safeRequestId(response.headers.get("x-request-id"));
      if (response.status === 401 || response.status === 403) {
        throw new WebSearchProviderError(
          "authentication",
          "Firecrawl rejected the configured key",
          requestId,
          null,
          retryCount,
          retryAt,
        );
      }
      if (response.status === 400 || response.status === 422) {
        throw new WebSearchProviderError(
          "invalid_request",
          "Firecrawl rejected the search request",
          requestId,
          null,
          retryCount,
          retryAt,
        );
      }
      if (![408, 429].includes(response.status) && response.status < 500) {
        throw new WebSearchProviderError(
          "provider_failure",
          "Firecrawl could not complete the search",
          requestId,
          null,
          retryCount,
          retryAt,
        );
      }
      if (attempt === 0) {
        retryCount = 1;
        const retryAfter = boundedRetryAfter(response.headers.get("retry-after"));
        retryAt = Date.now() + retryAfter;
        if (retryAfter > 0) await delay(retryAfter);
        continue;
      }
      throw new WebSearchProviderError(
        response.status === 429 ? "rate_limited" : "transient_failure",
        response.status === 429
          ? "Firecrawl is temporarily rate limited"
          : "Firecrawl is temporarily unavailable",
        requestId,
        null,
        retryCount,
        retryAt,
      );
    }
    if (!response?.ok) {
      throw new WebSearchProviderError(
        "transient_failure",
        "Firecrawl is temporarily unavailable",
        null,
        null,
        retryCount,
        retryAt,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WebSearchProviderError(
        "provider_failure",
        "Firecrawl returned an invalid response",
        safeRequestId(response.headers.get("x-request-id")),
        null,
        retryCount,
        retryAt,
      );
    }
    const value = payload as Record<string, unknown>;
    const requestId =
      safeRequestId(response.headers.get("x-request-id")) ??
      safeRequestId(value.id) ??
      safeRequestId(value.requestId);
    const creditsUsed = safeCredits(value.creditsUsed);
    const rawResults = findResults(value);
    if (rawResults === null) {
      throw new WebSearchProviderError(
        "provider_failure",
        "Firecrawl returned an invalid response",
        requestId,
        creditsUsed,
        retryCount,
        retryAt,
      );
    }
    const results = rawResults.filter(isRecord).flatMap((raw) => normalizeProviderResult(raw));
    if (rawResults.length > 0 && results.length === 0) {
      throw new WebSearchProviderError(
        "provider_failure",
        "Firecrawl returned an invalid response",
        requestId,
        creditsUsed,
        retryCount,
        retryAt,
      );
    }
    return {
      requestId,
      creditsUsed,
      retryCount,
      retryAt,
      results,
    };
  }
}

export class WebSearchApplication {
  private readonly provider: WebSearchProvider;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    options: WebSearchApplicationOptions = {},
  ) {
    this.provider =
      options.provider ?? new FirecrawlWebSearchProvider(options.apiKey ?? (() => undefined));
  }

  async search(command: WebSearchRequest & { scoutId: string }): Promise<WebSearchResponse> {
    const scout = requireScout(this.db, command.scoutId);
    if (scout.lifecycleState !== "active") {
      throw new RecruitingError("CONFLICT", "Archived Scouts cannot use Web Search");
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
    const source = this.db.select().from(sources).where(eq(sources.id, "source-web-search")).get();
    if (!source) throw new RecruitingError("NOT_FOUND", "Web Search Source was not found");
    const selectedSourceIds =
      parseSnapshotSourceIds(run.overrideSnapshot) ??
      this.db
        .select({ sourceId: scoutSources.sourceId })
        .from(scoutSources)
        .where(eq(scoutSources.scoutId, scout.id))
        .all()
        .map((row) => row.sourceId);
    const selected = selectedSourceIds.includes(source.id);
    // A Scout with a job-board Source may search that board for discovery
    // without also selecting the Web Search Source.
    const boardHosts = selected
      ? []
      : [...new Set(selectedSourceIds.flatMap((id) => JOB_BOARD_SEARCH_HOSTS[id] ?? []))];
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
    let initialDetails: WebSearchAttemptDetails = {
      operation: "web_search",
      provider: providerName(this.provider),
      query: auditQuery(command.query),
      providerQuery: "",
      normalizedQuery: "",
      includeDomains: [],
      unsupportedOperators: [],
      limit: null,
      tbs: null,
      location: null,
      requestId: null,
      creditsUsed: null,
      returnedUrls: [],
      retryCount: 0,
      retryAt: null,
      retryDisposition: "not_retried",
      errorCategory: null,
      attemptCount: 0,
      emptyResultRetried: false,
      startedAt,
      completedAt: null,
    };
    this.insertAttempt(attemptId, run.id, source.id, initialDetails, startedAt);
    const reject = (
      message: string,
      code: "CONFLICT" | "VALIDATION" | "NOT_FOUND" = "CONFLICT",
      category: RecruitingFailureCategory = "invalid_input",
    ) => {
      const rejectedDetails = {
        ...initialDetails,
        errorCategory: category,
        retryDisposition: "not_retried" as const,
      };
      this.completeAttempt(attemptId, "rejected", rejectedDetails, message);
      throw new RecruitingError(code, message, category);
    };
    let normalized: ReturnType<typeof normalizeQuery>;
    let filters: NormalizedFilters;
    try {
      normalized = normalizeQuery(command.query, command.limit);
      filters = normalizeFilters(command, startedAt);
      initialDetails = {
        ...initialDetails,
        query: auditQuery(normalized.original),
        providerQuery: redactSensitiveQuery(normalized.providerQuery),
        normalizedQuery: redactSensitiveQuery(normalized.providerQuery),
        includeDomains: normalized.includeDomains,
        unsupportedOperators: normalized.unsupportedOperators,
        limit: normalized.limit,
        tbs: filters.tbs,
        location: filters.location,
      };
      this.db
        .update(sourceAttempts)
        .set({ requestedScope: JSON.stringify(initialDetails) })
        .where(eq(sourceAttempts.id, attemptId))
        .run();
    } catch (error) {
      const message =
        error instanceof RecruitingError ? error.message : "WebSearch request was rejected";
      return reject(message, "VALIDATION", "invalid_input");
    }
    if (!selected && boardHosts.length === 0)
      return reject(
        "Web Search is not enabled for this Scout",
        "CONFLICT",
        "disabled_source_access",
      );
    if (!selected && !isBoardDiscoveryQuery(normalized.includeDomains, boardHosts))
      return reject(
        `Web Search is not enabled for this Scout. Job-board discovery searches must restrict site: to a selected board (${boardHosts.join(", ")})`,
        "CONFLICT",
        "disabled_source_access",
      );
    if (!access)
      return reject("Web Search Source Access was not found", "NOT_FOUND", "missing_source_access");
    if (access.readiness === "candidate_disabled")
      return reject("The Candidate disabled Web Search", "CONFLICT", "disabled_source_access");
    const providerRequest: WebSearchProviderRequest = {
      query: normalized.providerQuery,
      limit: normalized.limit,
      ...(filters.tbs ? { tbs: filters.tbs } : {}),
      ...(filters.location ? { location: filters.location } : {}),
    };
    let response: WebSearchProviderResponse;
    try {
      response = await this.provider.search(providerRequest);
      // Firecrawl's date-filtered search intermittently answers an identical
      // request with no results, and an empty answer costs no credits.
      if (response.results.length === 0 && filters.tbs) {
        initialDetails = { ...initialDetails, emptyResultRetried: true };
        const retry = await this.provider.search(providerRequest);
        response = {
          ...retry,
          creditsUsed:
            response.creditsUsed == null && retry.creditsUsed == null
              ? null
              : (safeCredits(response.creditsUsed) ?? 0) + (safeCredits(retry.creditsUsed) ?? 0),
        };
      }
    } catch (error) {
      const providerError = error instanceof WebSearchProviderError ? error : null;
      const details = {
        ...initialDetails,
        requestId: providerError?.requestId ?? null,
        creditsUsed: providerError?.creditsUsed ?? null,
        retryCount: safeRetryCount(providerError?.retryCount),
        retryAt: safeRetryAt(providerError?.retryAt),
        retryDisposition: retryDispositionForFailure(
          safeRetryCount(providerError?.retryCount),
          providerError?.category,
        ),
        errorCategory: providerError?.category ?? "provider_failure",
        attemptCount: Math.max(1, 1 + safeRetryCount(providerError?.retryCount)),
      };
      const outcome =
        providerError?.category === "rate_limited" ||
        providerError?.category === "transient_failure"
          ? providerError.category === "rate_limited"
            ? "rate_limited"
            : "transient_failure"
          : "rejected";
      const safeMessage = safeProviderMessage(providerError?.category);
      this.completeAttempt(attemptId, outcome, details, safeMessage);
      throw new RecruitingError(
        "CONFLICT",
        safeMessage,
        recruitingFailureCategory(providerError?.category),
      );
    }
    const retrievedAt = this.now();
    const normalizedResults = response.results
      .map((result) =>
        normalizeResult(
          result,
          retrievedAt,
          filters.compact ? COMPACT_EXCERPT_LENGTH : MAX_EXCERPT_LENGTH,
        ),
      )
      .filter((result): result is WebSearchResult => result !== null);
    if (response.results.length > 0 && normalizedResults.length === 0) {
      const retryCount = safeRetryCount(response.retryCount);
      const details: WebSearchAttemptDetails = {
        ...initialDetails,
        requestId: safeRequestId(response.requestId),
        creditsUsed: safeCredits(response.creditsUsed),
        retryCount,
        retryAt: safeRetryAt(response.retryAt),
        retryDisposition: retryCount > 0 ? "mixed" : "not_retried",
        errorCategory: "provider_failure",
        attemptCount: Math.max(1, 1 + retryCount),
      };
      const safeMessage = safeProviderMessage("provider_failure");
      this.completeAttempt(attemptId, "rejected", details, safeMessage);
      throw new RecruitingError("CONFLICT", safeMessage, "provider_failure");
    }
    const results = normalizedResults
      .filter((result) =>
        isAllowedByDomainRestrictions(result.canonicalUrl, normalized.includeDomains),
      )
      .slice(0, normalized.limit);
    const details: WebSearchAttemptDetails = {
      ...initialDetails,
      requestId: safeRequestId(response.requestId),
      creditsUsed: safeCredits(response.creditsUsed),
      returnedUrls: results.map((result) => result.canonicalUrl),
      retryCount: safeRetryCount(response.retryCount),
      retryAt: safeRetryAt(response.retryAt),
      retryDisposition: retryDispositionFor(safeRetryCount(response.retryCount), false),
      errorCategory: null,
      attemptCount: Math.max(1, 1 + safeRetryCount(response.retryCount)),
    };
    this.completeAttempt(
      attemptId,
      results.length > 0 ? "succeeded_with_items" : "succeeded_empty",
      details,
      null,
    );
    return {
      query: redactSensitiveQuery(normalized.original),
      providerQuery: redactSensitiveQuery(normalized.providerQuery),
      appliedDomainRestrictions: normalized.includeDomains,
      unsupportedOperators: normalized.unsupportedOperators,
      appliedFilters: { tbs: filters.tbs, location: filters.location },
      sourceAttemptId: attemptId,
      retrievedAt,
      provenance: {
        provider: providerName(this.provider),
        requestId: details.requestId,
        sourceId: source.id,
        runId: run.id,
        scoutId: scout.id,
      },
      results,
      jobBoards: jobBoardsFrom(results),
    };
  }

  private insertAttempt(
    id: string,
    runId: string,
    sourceId: string,
    details: WebSearchAttemptDetails,
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
    details: WebSearchAttemptDetails,
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

export function normalizeQuery(query: string, limit?: number): NormalizedQuery & { limit: number } {
  if (typeof query !== "string" || !query.trim()) {
    throw new RecruitingError("VALIDATION", "WebSearch query is required");
  }
  const original = query;
  const providerInput = query.trim();
  if (original.length > MAX_QUERY_LENGTH) {
    throw new RecruitingError(
      "VALIDATION",
      `WebSearch query must be at most ${MAX_QUERY_LENGTH} characters`,
    );
  }
  const resultLimit = limit === undefined ? DEFAULT_RESULT_LIMIT : limit;
  if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > MAX_RESULT_LIMIT) {
    throw new RecruitingError(
      "VALIDATION",
      `WebSearch result limit must be an integer between 1 and ${MAX_RESULT_LIMIT}`,
    );
  }
  const unsupportedOperators = findUnsupportedOperators(providerInput);
  return {
    original,
    providerQuery: providerInput,
    includeDomains: collectPositiveSiteRestrictions(providerInput),
    unsupportedOperators: [...new Set(unsupportedOperators)],
    limit: resultLimit,
  };
}

/** Turn the typed date, sort, and location inputs into Firecrawl's `tbs` and
 * `location`. Dates use the host clock, never the harness's. */
export function normalizeFilters(
  request: Omit<WebSearchRequest, "query" | "limit">,
  now: number,
): NormalizedFilters {
  const { recency, publishedAfter, sortByDate, location, compact } = request;
  if (recency !== undefined && !WEB_SEARCH_RECENCIES.includes(recency)) {
    throw new RecruitingError(
      "VALIDATION",
      "WebSearch recency must be one of day, week, month, or year",
    );
  }
  if (recency !== undefined && publishedAfter !== undefined) {
    throw new RecruitingError(
      "VALIDATION",
      "WebSearch accepts recency or publishedAfter, not both",
    );
  }
  if (sortByDate !== undefined && typeof sortByDate !== "boolean") {
    throw new RecruitingError("VALIDATION", "WebSearch sortByDate must be true or false");
  }
  if (compact !== undefined && typeof compact !== "boolean") {
    throw new RecruitingError("VALIDATION", "WebSearch compact must be true or false");
  }
  const tbs: string[] = [];
  if (sortByDate) tbs.push("sbd:1");
  if (recency) tbs.push(`qdr:${recency[0]}`);
  if (publishedAfter !== undefined) {
    const after =
      typeof publishedAfter === "string" && ISO_DATE_PATTERN.test(publishedAfter)
        ? Date.parse(publishedAfter)
        : Number.NaN;
    if (!Number.isFinite(after)) {
      throw new RecruitingError(
        "VALIDATION",
        "WebSearch publishedAfter must be an ISO date such as 2026-09-01",
      );
    }
    if (after > now) {
      throw new RecruitingError("VALIDATION", "WebSearch publishedAfter cannot be in the future");
    }
    tbs.push("cdr:1", `cd_min:${searchDate(after)}`, `cd_max:${searchDate(now)}`);
  }
  let normalizedLocation: string | null = null;
  if (location !== undefined) {
    normalizedLocation = typeof location === "string" ? normalizeText(location, Infinity) : "";
    if (
      !normalizedLocation ||
      normalizedLocation.length > MAX_LOCATION_LENGTH ||
      !LOCATION_PATTERN.test(normalizedLocation)
    ) {
      throw new RecruitingError(
        "VALIDATION",
        `WebSearch location must be a place name such as "San Francisco,California,United States" (at most ${MAX_LOCATION_LENGTH} characters)`,
      );
    }
  }
  return {
    tbs: tbs.length > 0 ? tbs.join(",") : null,
    location: normalizedLocation,
    compact: compact === true,
  };
}

/** MM/DD/YYYY in UTC, the date format Google-style `cdr` ranges expect. */
function searchDate(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()}`;
}

function isBoardDiscoveryQuery(domains: string[], boardHosts: string[]): boolean {
  return (
    domains.length > 0 &&
    domains.every((domain) =>
      boardHosts.some((host) => domain === host || domain.endsWith(`.${host}`)),
    )
  );
}

/** The company boards behind the results, deduplicated, so a discovery search
 * hands the harness board handles instead of making it parse every URL. */
function jobBoardsFrom(results: WebSearchResult[]): WebSearchJobBoard[] {
  const boards = new Map<string, WebSearchJobBoard>();
  for (const result of results) {
    const board = jobBoardFromUrl(result.canonicalUrl);
    if (!board) continue;
    const key = `${board.source}:${board.boardUrl.toLowerCase()}`;
    const existing = boards.get(key);
    if (existing) existing.resultCount += 1;
    else boards.set(key, { ...board, resultCount: 1 });
  }
  return [...boards.values()];
}

function jobBoardFromUrl(value: string): Omit<WebSearchJobBoard, "resultCount"> | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname === ASHBY_HOST) {
    const handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return ASHBY_BOARD_PATTERN.test(handle)
      ? { source: "ashby", board: handle, boardUrl: `https://${ASHBY_HOST}/${handle}` }
      : null;
  }
  const routed = routeBoard(url.toString());
  if (!routed.ok) return null;
  return {
    source: routed.adapter.provider,
    board: routed.board,
    boardUrl: `https://${url.hostname}/${routed.board}`,
  };
}

const SUPPORTED_OPERATORS = new Set([
  "site",
  "filetype",
  "inurl",
  "allinurl",
  "intitle",
  "allintitle",
  "related",
]);

function collectPositiveSiteRestrictions(query: string): string[] {
  const domains: string[] = [];
  let inQuotes = false;
  let index = 0;

  while (index < query.length) {
    const character = query[index];
    if (character === '"') {
      inQuotes = !inQuotes;
      index += 1;
      continue;
    }
    if (
      !inQuotes &&
      query.slice(index, index + 5).toLowerCase() === "site:" &&
      (index === 0 || /\s|[([{]/.test(query[index - 1] ?? ""))
    ) {
      const valueStart = index + 5;
      let valueEnd = valueStart;
      while (valueEnd < query.length && !/\s/.test(query[valueEnd] ?? "")) valueEnd += 1;
      const value = query.slice(valueStart, valueEnd);
      validateSiteHostname(value);
      const domain = value.toLowerCase();
      if (!domains.includes(domain)) domains.push(domain);
      index = valueEnd;
      continue;
    }
    index += 1;
  }

  return domains;
}

function validateSiteHostname(value: string): void {
  if (
    !value ||
    !/^[a-z0-9.-]+$/i.test(value) ||
    value.includes("..") ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.startsWith("-") ||
    value.endsWith("-") ||
    (value.includes("-") &&
      value.split(".").some((label) => label.startsWith("-") || label.endsWith("-")))
  ) {
    throw new RecruitingError(
      "VALIDATION",
      "WebSearch site: restrictions must be hostnames without schemes or paths",
    );
  }
}

function findUnsupportedOperators(query: string): string[] {
  const operators: string[] = [];
  let inQuotes = false;

  const inspect = (segment: string) => {
    const pattern = /(?:^|[^a-z0-9_-])-?([a-z][a-z0-9_-]*):/gi;
    for (const match of segment.matchAll(pattern)) {
      const operator = match[1]?.toLowerCase();
      if (!operator) continue;
      const matchStart = match.index ?? 0;
      const operatorStart = matchStart + match[0].lastIndexOf(operator);
      if (/^[a-z][a-z0-9_-]*:\/\//i.test(segment.slice(operatorStart))) continue;
      if (!SUPPORTED_OPERATORS.has(operator) && !operators.includes(operator)) {
        operators.push(operator);
      }
    }
  };

  let segmentStart = 0;
  for (let index = 0; index <= query.length; index += 1) {
    const character = query[index];
    if (character === '"') {
      if (!inQuotes) inspect(query.slice(segmentStart, index));
      inQuotes = !inQuotes;
      segmentStart = index + 1;
      continue;
    }
    if (index === query.length && !inQuotes) inspect(query.slice(segmentStart, index));
  }
  return operators;
}

function normalizeResult(
  result: WebSearchProviderResult,
  retrievedAt: number,
  excerptLength: number,
): WebSearchResult | null {
  const canonicalUrl = canonicalizeUrl(result.url);
  if (!canonicalUrl) return null;
  const title =
    normalizeText(result.title ?? "Untitled Web Result", MAX_TITLE_LENGTH) || "Untitled Web Result";
  const excerpt = normalizeText(
    result.highlights?.find(Boolean) ?? result.description ?? "",
    excerptLength,
  );
  return {
    title,
    canonicalUrl,
    excerpt,
    publishedAt: parsePublishedAt(result.publishedAt),
    retrievedAt,
  };
}

function canonicalizeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
      return null;
    if (hasSensitiveQueryParameter(url)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedByDomainRestrictions(url: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function normalizeText(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function auditQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return redactSensitiveQuery(normalizeText(value, MAX_QUERY_LENGTH));
}

function redactSensitiveQuery(value: string): string {
  return value.replace(
    /((?:token|secret|password|credential|authorization|api[_-]?key|signature|sig)\s*[:=]\s*)[^\s]+/gi,
    "$1[redacted]",
  );
}

function parsePublishedAt(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function providerName(provider: WebSearchProvider): string {
  return provider instanceof DeterministicWebSearchProvider ? "deterministic" : "firecrawl";
}

function requireScout(db: Db, id: string) {
  const row = db.select().from(scouts).where(eq(scouts.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Scout ${id} was not found`);
  return row;
}

function safeRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/(?:bearer|api[_-]?key|secret|password|credential)/i.test(value)) return null;
  const result = normalizeText(value, MAX_REQUEST_ID_LENGTH);
  return result || null;
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

function safeCredits(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeRetryCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 1)
    : 0;
}

function safeRetryAt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function retryDispositionFor(
  retryCount: number,
  exhausted: boolean,
): "not_retried" | "recovered" | "exhausted" {
  if (retryCount === 0) return "not_retried";
  return exhausted ? "exhausted" : "recovered";
}

function retryDispositionForFailure(
  retryCount: number,
  category: WebSearchProviderError["category"] | undefined,
): "not_retried" | "exhausted" | "mixed" {
  if (retryCount === 0) return "not_retried";
  return category === "rate_limited" || category === "transient_failure" ? "exhausted" : "mixed";
}

function safeProviderMessage(category: WebSearchProviderError["category"] | undefined): string {
  switch (category) {
    case "not_configured":
      return "Web Search Source is not configured";
    case "authentication":
      return "Web Search Source authentication failed";
    case "rate_limited":
      return "Web Search Source is temporarily rate limited";
    case "transient_failure":
      return "Web Search Source is temporarily unavailable";
    case "invalid_request":
      return "Web Search provider rejected the request";
    default:
      return "Web Search provider could not complete the request";
  }
}

function recruitingFailureCategory(
  category: WebSearchProviderError["category"] | undefined,
): RecruitingFailureCategory {
  switch (category) {
    case "not_configured":
      return "missing_configuration";
    case "authentication":
      return "invalid_authentication";
    case "rate_limited":
      return "rate_limited";
    case "invalid_request":
      return "invalid_input";
    case "transient_failure":
      return "exhausted_transient_failure";
    default:
      return "provider_failure";
  }
}

function findResults(payload: Record<string, unknown>): unknown[] | null {
  const candidates = [
    payload.results,
    payload.data,
    (payload.data as Record<string, unknown> | null)?.web,
    (payload.data as Record<string, unknown> | null)?.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function normalizeProviderResult(value: Record<string, unknown>): WebSearchProviderResult[] {
  const url =
    typeof value.url === "string" ? value.url : typeof value.link === "string" ? value.link : null;
  if (!url) return [];
  const highlights = Array.isArray(value.highlights)
    ? value.highlights.filter((item): item is string => typeof item === "string")
    : null;
  return [
    {
      title: typeof value.title === "string" ? value.title : null,
      url,
      description:
        typeof value.description === "string"
          ? value.description
          : typeof value.snippet === "string"
            ? value.snippet
            : null,
      highlights,
      publishedAt:
        typeof value.publishedAt === "string" || typeof value.publishedAt === "number"
          ? value.publishedAt
          : null,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(2_000, Math.max(0, seconds * 1_000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(2_000, Math.max(0, timestamp - Date.now())) : 0;
}

function hasSensitiveQueryParameter(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) =>
    /(?:token|secret|password|credential|authorization|api[_-]?key|signature|sig)/i.test(key),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void FIRECRAWL_SEARCH_URL;
void boundedRetryAfter;
