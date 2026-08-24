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
import { RecruitingError } from "./errors";

const ACTIVE_RUN_STATUSES = ["queued", "preflight", "running", "finalizing"] as const;
const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_LIMIT = 25;
const MAX_QUERY_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 500;
const MAX_EXCERPT_LENGTH = 1_000;
const MAX_REQUEST_ID_LENGTH = 200;
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

export type WebSearchRequest = {
  query: string;
  limit?: number;
};

export type WebSearchProviderRequest = {
  query: string;
  limit: number;
  includeDomains: string[];
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

export type WebSearchResponse = {
  query: string;
  providerQuery: string;
  appliedDomainRestrictions: string[];
  unsupportedOperators: string[];
  sourceAttemptId: string;
  retrievedAt: number;
  provenance: WebSearchProvenance;
  results: WebSearchResult[];
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

type WebSearchAttemptDetails = {
  operation: "web_search";
  provider: string;
  query: string;
  providerQuery: string;
  includeDomains: string[];
  unsupportedOperators: string[];
  requestId: string | null;
  creditsUsed: number | null;
  returnedUrls: string[];
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
    this.requests.push({ ...request, includeDomains: [...request.includeDomains] });
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
      ...(request.includeDomains.length > 0 ? { includeDomains: request.includeDomains } : {}),
    };
    let response: Response | undefined;
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
        if (attempt === 0) continue;
        throw new WebSearchProviderError(
          "transient_failure",
          "Firecrawl is temporarily unavailable",
        );
      }
      if (response.ok) break;
      const requestId = safeRequestId(response.headers.get("x-request-id"));
      if (response.status === 401 || response.status === 403) {
        throw new WebSearchProviderError(
          "authentication",
          "Firecrawl rejected the configured key",
          requestId,
        );
      }
      if (response.status === 400 || response.status === 422) {
        throw new WebSearchProviderError(
          "invalid_request",
          "Firecrawl rejected the search request",
          requestId,
        );
      }
      if (![408, 429].includes(response.status) && response.status < 500) {
        throw new WebSearchProviderError(
          "provider_failure",
          "Firecrawl could not complete the search",
          requestId,
        );
      }
      if (attempt === 0) {
        const retryAfter = boundedRetryAfter(response.headers.get("retry-after"));
        if (retryAfter > 0) await delay(retryAfter);
        continue;
      }
      throw new WebSearchProviderError(
        response.status === 429 ? "rate_limited" : "transient_failure",
        response.status === 429
          ? "Firecrawl is temporarily rate limited"
          : "Firecrawl is temporarily unavailable",
        requestId,
      );
    }
    if (!response?.ok) {
      throw new WebSearchProviderError("transient_failure", "Firecrawl is temporarily unavailable");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WebSearchProviderError(
        "provider_failure",
        "Firecrawl returned an invalid response",
      );
    }
    const value = payload as Record<string, unknown>;
    const requestId =
      safeRequestId(response.headers.get("x-request-id")) ??
      safeRequestId(value.id) ??
      safeRequestId(value.requestId);
    const creditsUsed = safeCredits(value.creditsUsed);
    const rawResults = findResults(value);
    return {
      requestId,
      creditsUsed,
      results: rawResults.flatMap((raw) => normalizeProviderResult(raw)),
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
    let initialDetails: WebSearchAttemptDetails = {
      operation: "web_search",
      provider: providerName(this.provider),
      query: auditQuery(command.query),
      providerQuery: "",
      includeDomains: [],
      unsupportedOperators: [],
      requestId: null,
      creditsUsed: null,
      returnedUrls: [],
    };
    this.insertAttempt(attemptId, run.id, source.id, initialDetails, startedAt);
    const reject = (
      message: string,
      code: "CONFLICT" | "VALIDATION" | "NOT_FOUND" = "CONFLICT",
    ) => {
      this.completeAttempt(attemptId, "rejected", initialDetails, message);
      throw new RecruitingError(code, message);
    };
    let normalized: ReturnType<typeof normalizeQuery>;
    try {
      normalized = normalizeQuery(command.query, command.limit);
      initialDetails = {
        ...initialDetails,
        query: normalized.original,
        providerQuery: normalized.providerQuery,
        includeDomains: normalized.includeDomains,
        unsupportedOperators: normalized.unsupportedOperators,
      };
      this.db
        .update(sourceAttempts)
        .set({ requestedScope: JSON.stringify(initialDetails) })
        .where(eq(sourceAttempts.id, attemptId))
        .run();
    } catch (error) {
      const message =
        error instanceof RecruitingError ? error.message : "WebSearch request was rejected";
      return reject(message, "VALIDATION");
    }
    if (!selected) return reject("Web Search is not enabled for this Scout");
    if (!access) return reject("Web Search Source Access was not found", "NOT_FOUND");
    if (access.readiness === "candidate_disabled")
      return reject("The Candidate disabled Web Search");
    let response: WebSearchProviderResponse;
    try {
      response = await this.provider.search({
        query: normalized.providerQuery,
        limit: normalized.limit,
        includeDomains: normalized.includeDomains,
      });
    } catch (error) {
      const providerError = error instanceof WebSearchProviderError ? error : null;
      const details = {
        ...initialDetails,
        requestId: providerError?.requestId ?? null,
        creditsUsed: providerError?.creditsUsed ?? null,
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
      throw new RecruitingError("CONFLICT", safeMessage);
    }
    const retrievedAt = this.now();
    const results = response.results
      .map((result) => normalizeResult(result, retrievedAt))
      .filter((result): result is WebSearchResult => result !== null)
      .filter((result) =>
        isAllowedByDomainRestrictions(result.canonicalUrl, normalized.includeDomains),
      )
      .slice(0, normalized.limit);
    const details: WebSearchAttemptDetails = {
      ...initialDetails,
      requestId: safeRequestId(response.requestId),
      creditsUsed: safeCredits(response.creditsUsed),
      returnedUrls: results.map((result) => result.canonicalUrl),
    };
    this.completeAttempt(
      attemptId,
      results.length > 0 ? "succeeded_with_items" : "succeeded_empty",
      details,
      null,
    );
    return {
      query: normalized.original,
      providerQuery: normalized.providerQuery,
      appliedDomainRestrictions: normalized.includeDomains,
      unsupportedOperators: normalized.unsupportedOperators,
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
    this.db
      .update(sourceAttempts)
      .set({
        requestedScope: JSON.stringify(details),
        outcome,
        itemCount: details.returnedUrls.length,
        safeFailure,
        completedAt: this.now(),
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
      "WebSearch result limit must be an integer between 1 and 25",
    );
  }
  const domains: string[] = [];
  const providerQuery = removePositiveSiteRestrictions(providerInput, domains);
  const unsupportedOperators = findUnsupportedOperators(providerQuery);
  return {
    original,
    providerQuery,
    includeDomains: domains,
    unsupportedOperators: [...new Set(unsupportedOperators)],
    limit: resultLimit,
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

function removePositiveSiteRestrictions(query: string, domains: string[]): string {
  let providerQuery = "";
  let segmentStart = 0;
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

      providerQuery += query.slice(segmentStart, index);
      segmentStart = valueEnd < query.length ? valueEnd + 1 : valueEnd;
      index = valueEnd;
      continue;
    }
    index += 1;
  }

  providerQuery += query.slice(segmentStart);
  return providerQuery.trim();
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
): WebSearchResult | null {
  const canonicalUrl = canonicalizeUrl(result.url);
  if (!canonicalUrl) return null;
  const title =
    normalizeText(result.title ?? "Untitled Web Result", MAX_TITLE_LENGTH) || "Untitled Web Result";
  const excerpt = normalizeText(
    result.highlights?.find(Boolean) ?? result.description ?? "",
    MAX_EXCERPT_LENGTH,
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
  return normalizeText(value, MAX_QUERY_LENGTH);
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

function findResults(payload: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    payload.results,
    payload.data,
    (payload.data as Record<string, unknown> | null)?.web,
    (payload.data as Record<string, unknown> | null)?.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
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
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(2_000, Math.max(0, seconds * 1_000));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void FIRECRAWL_SEARCH_URL;
void boundedRetryAfter;
