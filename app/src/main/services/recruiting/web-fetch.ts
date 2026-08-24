import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

const ACTIVE_RUN_STATUSES = ["queued", "preflight", "running", "finalizing"] as const;
const DEFAULT_CONTENT_LIMIT = 12_000;
const MAX_CONTENT_LIMIT = 30_000;
const MAX_URLS = 5;
const MAX_TITLE_LENGTH = 500;
const MAX_REQUEST_ID_LENGTH = 200;
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const WEB_SEARCH_SOURCE_ID = "source-web-search";

export type WebFetchRequest = {
  urls: string[];
  contentLimit?: number;
};

export type WebFetchProviderRequest = {
  url: string;
  contentLimit: number;
};

export type WebFetchProviderPage = {
  title?: string | null;
  canonicalUrl?: string | null;
  content: string;
  requestId?: string | null;
  creditsUsed?: number | null;
  retryCount?: number;
  retryAt?: number | null;
};

export type WebFetchProvider = {
  fetch(request: WebFetchProviderRequest): Promise<WebFetchProviderPage>;
};

export type WebFetchProviderErrorCategory =
  | "not_configured"
  | "authentication"
  | "rate_limited"
  | "transient_failure"
  | "invalid_request"
  | "not_found"
  | "malformed_content"
  | "provider_failure";

export class WebFetchProviderError extends Error {
  constructor(
    readonly category: WebFetchProviderErrorCategory,
    message: string,
    readonly requestId: string | null = null,
    readonly creditsUsed: number | null = null,
    readonly retryCount = 0,
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "WebFetchProviderError";
  }
}

export type WebFetchProvenance = {
  provider: string;
  requestId: string | null;
  sourceId: string;
  runId: string;
  scoutId: string;
};

export type WebFetchSuccess = {
  requestedUrl: string;
  canonicalUrl: string;
  title: string | null;
  content: string;
  retrievedAt: number;
  truncated: boolean;
  trust: "untrusted_evidence";
  provenance: WebFetchProvenance;
};

export type WebFetchPageError = {
  category: WebFetchProviderErrorCategory | "invalid_url";
  message: string;
};

export type WebFetchFailure = {
  requestedUrl: string;
  canonicalUrl: string | null;
  error: WebFetchPageError;
  provenance: WebFetchProvenance;
};

export type WebFetchOutcome = WebFetchSuccess | WebFetchFailure;

export type WebFetchResponse = {
  urls: string[];
  contentLimit: number;
  sourceAttemptId: string;
  retrievedAt: number;
  trustBoundary: {
    content: "untrusted_evidence";
    instructionsAndHostPolicy: "immutable";
  };
  outcomes: WebFetchOutcome[];
};

export type WebFetchApplicationOptions = {
  provider?: WebFetchProvider;
  apiKey?: () => string | undefined;
  webSearchSettings?: () => {
    configured: boolean;
    readiness: string;
    safeFailure: string | null;
  };
  webFetchResolveHostname?: (hostname: string) => Promise<readonly string[]>;
};

type WebFetchAttemptDetails = {
  operation: "web_fetch";
  provider: string;
  requestedUrls: string[];
  urls: string[];
  contentLimit: number | null;
  requestIds: string[];
  creditsUsed: number[];
  retryCount: number;
  retryAt: number | null;
  retryDisposition: "not_retried" | "recovered" | "exhausted" | "mixed";
  attemptCount: number;
  returnedUrls: string[];
  errorCategories: string[];
  errorCategory: string | null;
  startedAt: number;
  completedAt: number | null;
};

/** A deterministic provider for high-level recruiting tests. It never performs
 * network I/O and records only normalized, safe requests. */
export class DeterministicWebFetchProvider implements WebFetchProvider {
  readonly requests: WebFetchProviderRequest[] = [];
  private readonly responses: Map<string, WebFetchProviderPage>;

  constructor(fixtures: Record<string, WebFetchProviderPage>) {
    this.responses = new Map(Object.entries(fixtures).map(([url, page]) => [url, { ...page }]));
  }

  async fetch(request: WebFetchProviderRequest): Promise<WebFetchProviderPage> {
    this.requests.push({ ...request });
    const page = this.responses.get(request.url);
    if (!page) throw new WebFetchProviderError("not_found", "The selected page was not found");
    return { ...page };
  }
}

/** Firecrawl Cloud adapter. Only selected pages reach this scrape boundary;
 * provider-specific payloads and credentials stop here. */
export class FirecrawlWebFetchProvider implements WebFetchProvider {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetch(request: WebFetchProviderRequest): Promise<WebFetchProviderPage> {
    const key = this.apiKey()?.trim();
    if (!key) throw new WebFetchProviderError("not_configured", "Firecrawl is not configured");
    const body = {
      url: request.url,
      formats: ["markdown"],
      onlyMainContent: true,
    };
    let response: Response | undefined;
    let retryCount = 0;
    let retryAt: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.fetchImpl(FIRECRAWL_SCRAPE_URL, {
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
        throw new WebFetchProviderError(
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
        throw new WebFetchProviderError(
          "authentication",
          "Firecrawl rejected the configured key",
          requestId,
          null,
          retryCount,
          retryAt,
        );
      }
      if (response.status === 400 || response.status === 422) {
        throw new WebFetchProviderError(
          "invalid_request",
          "Firecrawl rejected the page request",
          requestId,
          null,
          retryCount,
          retryAt,
        );
      }
      if (response.status === 404) {
        throw new WebFetchProviderError(
          "not_found",
          "Firecrawl could not find the page",
          requestId,
          null,
          retryCount,
          retryAt,
        );
      }
      if (response.status !== 408 && response.status !== 429 && response.status < 500) {
        throw new WebFetchProviderError(
          "provider_failure",
          "Firecrawl could not fetch the page",
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
        await delay(retryAfter);
        continue;
      }
      throw new WebFetchProviderError(
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
      throw new WebFetchProviderError("transient_failure", "Firecrawl is temporarily unavailable");
    }
    const requestId = safeRequestId(response.headers.get("x-request-id"));
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WebFetchProviderError(
        "malformed_content",
        "Firecrawl returned an invalid page response",
        requestId,
        null,
        retryCount,
        retryAt,
      );
    }
    const value = asRecord(payload);
    const data = asRecord(value?.data) ?? value;
    const content =
      typeof data?.markdown === "string"
        ? data.markdown
        : typeof data?.content === "string"
          ? data.content
          : null;
    if (content === null) {
      throw new WebFetchProviderError(
        "malformed_content",
        "Firecrawl returned no page content",
        requestId,
        null,
        retryCount,
        retryAt,
      );
    }
    const metadata = asRecord(data?.metadata);
    const title =
      typeof metadata?.title === "string"
        ? metadata.title
        : typeof data?.title === "string"
          ? data.title
          : null;
    const canonicalUrl =
      typeof metadata?.url === "string"
        ? metadata.url
        : typeof data?.url === "string"
          ? data.url
          : null;
    return {
      title,
      canonicalUrl,
      content,
      requestId,
      creditsUsed: safeCredits(value?.creditsUsed ?? data?.creditsUsed),
      retryCount,
      retryAt,
    };
  }
}

export class WebFetchApplication {
  private readonly provider: WebFetchProvider;
  private readonly webSearchSettings?: WebFetchApplicationOptions["webSearchSettings"];
  private readonly resolveHostname: (hostname: string) => Promise<readonly string[]>;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    options: WebFetchApplicationOptions = {},
  ) {
    this.provider =
      options.provider ?? new FirecrawlWebFetchProvider(options.apiKey ?? (() => undefined));
    this.webSearchSettings = options.webSearchSettings;
    this.resolveHostname = options.webFetchResolveHostname ?? resolveHostname;
  }

  async fetch(command: WebFetchRequest & { scoutId: string }): Promise<WebFetchResponse> {
    const context = requireWebFetchContext(this.db, command.scoutId);
    const attemptId = randomUUID();
    const startedAt = this.now();
    let details: WebFetchAttemptDetails = {
      operation: "web_fetch",
      provider: providerName(this.provider),
      requestedUrls: auditUrls(command.urls),
      urls: auditUrls(command.urls),
      contentLimit: null,
      requestIds: [],
      creditsUsed: [],
      retryCount: 0,
      retryAt: null,
      retryDisposition: "not_retried",
      attemptCount: 0,
      returnedUrls: [],
      errorCategories: [],
      errorCategory: null,
      startedAt,
      completedAt: null,
    };
    this.insertAttempt(attemptId, context.run.id, context.source.id, details, startedAt);
    const reject = (
      message: string,
      code: "CONFLICT" | "VALIDATION" | "NOT_FOUND" = "CONFLICT",
      category: RecruitingFailureCategory = "invalid_input",
    ) => {
      const rejectedDetails = {
        ...details,
        errorCategory: category,
        retryDisposition: "not_retried" as const,
      };
      this.completeAttempt(attemptId, "rejected", rejectedDetails, message, 0);
      throw new RecruitingError(code, message, category);
    };
    let normalized: NormalizedFetchRequest;
    try {
      normalized = normalizeFetchRequest(command.urls, command.contentLimit);
      details = {
        ...details,
        urls: normalized.urls.map((entry) => entry.canonicalUrl),
        contentLimit: normalized.contentLimit,
      };
      this.updateAttempt(attemptId, details);
      await assertResolvedPublicUrls(normalized.urls, this.resolveHostname);
    } catch (error) {
      const message =
        error instanceof RecruitingError ? error.message : "WebFetch request was rejected";
      return reject(message, "VALIDATION", "invalid_url");
    }
    if (!context.selected)
      return reject(
        "Web Search is not enabled for this Scout",
        "CONFLICT",
        "disabled_source_access",
      );
    if (!context.access)
      return reject("Web Search Source Access was not found", "NOT_FOUND", "missing_source_access");
    if (context.access.readiness === "candidate_disabled")
      return reject("The Candidate disabled Web Search", "CONFLICT", "disabled_source_access");
    if (context.access.readiness !== "ready" && context.access.readiness !== "not_configured") {
      return reject(`Web Search Source is ${context.access.readiness}`, "CONFLICT", "not_ready");
    }
    const settings = this.webSearchSettings?.();
    if (settings && (!settings.configured || settings.readiness !== "ready")) {
      return reject(
        settings.safeFailure ?? "Web Search Source is not ready",
        "CONFLICT",
        "not_ready",
      );
    }

    const retrievedAt = this.now();
    const outcomes: WebFetchOutcome[] = [];
    for (const entry of normalized.urls) {
      const provenanceBase = {
        provider: providerName(this.provider),
        requestId: null,
        sourceId: context.source.id,
        runId: context.run.id,
        scoutId: context.scout.id,
      } satisfies WebFetchProvenance;
      try {
        const page = await this.provider.fetch({
          url: entry.canonicalUrl,
          contentLimit: normalized.contentLimit,
        });
        const requestId = safeRequestId(page.requestId);
        const creditsUsed = safeCredits(page.creditsUsed);
        const canonicalUrl =
          canonicalizePublicUrl(page.canonicalUrl ?? entry.canonicalUrl) ?? entry.canonicalUrl;
        const content = typeof page.content === "string" ? page.content : null;
        if (content === null)
          throw new WebFetchProviderError("malformed_content", "Page content was not text");
        const boundedContent = content.slice(0, normalized.contentLimit);
        details = {
          ...details,
          requestIds: requestId ? [...details.requestIds, requestId] : details.requestIds,
          creditsUsed:
            creditsUsed === null ? details.creditsUsed : [...details.creditsUsed, creditsUsed],
          retryCount: details.retryCount + safeRetryCount(page.retryCount),
          retryAt: safeRetryAt(page.retryAt) ?? details.retryAt,
          retryDisposition: mergeRetryDisposition(
            details.retryDisposition,
            page.retryCount ?? 0,
            false,
          ),
          attemptCount: details.attemptCount + 1 + safeRetryCount(page.retryCount),
          returnedUrls: [...details.returnedUrls, auditUrl(canonicalUrl)],
        };
        outcomes.push({
          requestedUrl: entry.requestedUrl,
          canonicalUrl,
          title: normalizeTitle(page.title),
          content: boundedContent,
          retrievedAt,
          truncated: content.length > normalized.contentLimit,
          trust: "untrusted_evidence",
          provenance: { ...provenanceBase, requestId },
        });
      } catch (error) {
        const providerError =
          error instanceof WebFetchProviderError
            ? error
            : new WebFetchProviderError(
                "provider_failure",
                "Web Fetch provider could not complete the page",
              );
        const requestId = safeRequestId(providerError.requestId);
        const creditsUsed = safeCredits(providerError.creditsUsed);
        details = {
          ...details,
          requestIds: requestId ? [...details.requestIds, requestId] : details.requestIds,
          creditsUsed:
            creditsUsed === null ? details.creditsUsed : [...details.creditsUsed, creditsUsed],
          retryCount: details.retryCount + safeRetryCount(providerError.retryCount),
          retryAt: safeRetryAt(providerError.retryAt) ?? details.retryAt,
          retryDisposition: mergeRetryDisposition(
            details.retryDisposition,
            providerError.retryCount,
            true,
          ),
          attemptCount: details.attemptCount + 1 + safeRetryCount(providerError.retryCount),
          errorCategories: [...details.errorCategories, providerError.category],
          errorCategory: mergeErrorCategory(details.errorCategory, providerError.category),
        };
        outcomes.push({
          requestedUrl: entry.requestedUrl,
          canonicalUrl: entry.canonicalUrl,
          error: {
            category: providerError.category,
            message: safePageError(providerError.category),
          },
          provenance: {
            ...provenanceBase,
            requestId,
          },
        });
      }
    }
    this.completeAttempt(
      attemptId,
      attemptOutcome(outcomes),
      details,
      outcomes.every((outcome) => "error" in outcome)
        ? "Web Fetch could not fetch any selected page"
        : null,
      outcomes.filter((outcome) => "content" in outcome).length,
    );
    return {
      urls: normalized.urls.map((entry) => entry.requestedUrl),
      contentLimit: normalized.contentLimit,
      sourceAttemptId: attemptId,
      retrievedAt,
      trustBoundary: {
        content: "untrusted_evidence",
        instructionsAndHostPolicy: "immutable",
      },
      outcomes,
    };
  }

  private insertAttempt(
    id: string,
    runId: string,
    sourceId: string,
    details: WebFetchAttemptDetails,
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

  private updateAttempt(id: string, details: WebFetchAttemptDetails): void {
    this.db
      .update(sourceAttempts)
      .set({ requestedScope: JSON.stringify(details) })
      .where(eq(sourceAttempts.id, id))
      .run();
  }

  private completeAttempt(
    id: string,
    outcome: SourceAttemptSummary["outcome"],
    details: WebFetchAttemptDetails,
    safeFailure: string | null,
    itemCount: number,
  ): void {
    const completedAt = this.now();
    this.db
      .update(sourceAttempts)
      .set({
        requestedScope: JSON.stringify({ ...details, completedAt }),
        outcome,
        itemCount,
        pageCount: details.urls.length,
        retryAt: details.retryAt,
        safeFailure,
        completedAt,
      })
      .where(eq(sourceAttempts.id, id))
      .run();
  }
}

type NormalizedFetchUrl = { requestedUrl: string; canonicalUrl: string };
type NormalizedFetchRequest = { urls: NormalizedFetchUrl[]; contentLimit: number };

export function normalizeFetchRequest(
  urls: string[],
  contentLimit?: number,
): NormalizedFetchRequest {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_URLS) {
    throw new RecruitingError("VALIDATION", "WebFetch accepts between 1 and 5 URLs");
  }
  const normalized = urls.map((value) => {
    if (typeof value !== "string") {
      throw new RecruitingError("VALIDATION", "WebFetch URLs must be public HTTP(S) URLs");
    }
    const canonicalUrl = canonicalizePublicUrl(value);
    if (!canonicalUrl) {
      throw new RecruitingError(
        "VALIDATION",
        "WebFetch URLs must be public HTTP(S) URLs without credentials",
      );
    }
    return { requestedUrl: value, canonicalUrl };
  });
  const limit = contentLimit ?? DEFAULT_CONTENT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTENT_LIMIT) {
    throw new RecruitingError(
      "VALIDATION",
      "WebFetch content limit must be an integer between 1 and 30,000 characters (default 12,000)",
    );
  }
  return { urls: normalized, contentLimit: limit };
}

function requireWebFetchContext(db: Db, scoutId: string) {
  const scout = db.select().from(scouts).where(eq(scouts.id, scoutId)).get();
  if (!scout) throw new RecruitingError("NOT_FOUND", `Scout ${scoutId} was not found`);
  if (scout.lifecycleState !== "active") {
    throw new RecruitingError("CONFLICT", "Archived Scouts cannot use Web Fetch");
  }
  const run = db
    .select()
    .from(scoutRuns)
    .where(
      and(eq(scoutRuns.scoutId, scout.id), inArray(scoutRuns.status, [...ACTIVE_RUN_STATUSES])),
    )
    .orderBy(asc(scoutRuns.createdAt), asc(scoutRuns.id))
    .get();
  if (!run) throw new RecruitingError("CONFLICT", `Scout ${scout.id} has no active Scout Run`);
  const source = db.select().from(sources).where(eq(sources.id, WEB_SEARCH_SOURCE_ID)).get();
  if (!source) throw new RecruitingError("NOT_FOUND", "Web Search Source was not found");
  const snapshotSourceIds = parseSnapshotSourceIds(run.overrideSnapshot);
  const selected = snapshotSourceIds
    ? snapshotSourceIds.includes(source.id)
    : Boolean(
        db
          .select({ sourceId: scoutSources.sourceId })
          .from(scoutSources)
          .where(and(eq(scoutSources.scoutId, scout.id), eq(scoutSources.sourceId, source.id)))
          .get(),
      );
  const access = db
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
  return { scout, run, source, selected, access };
}

function canonicalizePublicUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
      return null;
    if (hasSensitiveQueryParameter(url)) return null;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isPrivateHostname(hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".intranet") ||
    normalized.endsWith(".home.arpa")
  )
    return true;
  const family = isIP(normalized);
  if (family === 4) {
    const octets = normalized.split(".").map(Number);
    const [a, b, c] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("fec") ||
      normalized.startsWith("ff")
    );
  }
  return false;
}

async function assertResolvedPublicUrls(
  entries: NormalizedFetchUrl[],
  resolve: (hostname: string) => Promise<readonly string[]>,
): Promise<void> {
  for (const entry of entries) {
    const hostname = new URL(entry.canonicalUrl).hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname)) continue;
    let addresses: readonly string[];
    try {
      addresses = await resolveWithTimeout(resolve(hostname));
    } catch {
      throw new RecruitingError("VALIDATION", "WebFetch URLs must resolve to public hosts");
    }
    if (addresses.length === 0 || addresses.some((address) => isPrivateHostname(address))) {
      throw new RecruitingError("VALIDATION", "WebFetch URLs must resolve to public hosts");
    }
  }
}

async function resolveWithTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveHostname(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

function normalizeTitle(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
  return title || null;
}

function auditUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((url): url is string => typeof url === "string").map((url) => auditUrl(url));
}

function auditUrl(value: string): string {
  const trimmed = value.trim().slice(0, 2_000);
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (
        /(?:token|secret|password|credential|authorization|api[_-]?key|signature|sig)/i.test(key)
      ) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString().slice(0, 2_000);
  } catch {
    return "[invalid_url]";
  }
}

function hasSensitiveQueryParameter(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) =>
    /(?:token|secret|password|credential|authorization|api[_-]?key|signature|sig)/i.test(key),
  );
}

function providerName(provider: WebFetchProvider): string {
  return provider instanceof DeterministicWebFetchProvider ? "deterministic" : "firecrawl";
}

function attemptOutcome(outcomes: WebFetchOutcome[]): SourceAttemptSummary["outcome"] {
  const successCount = outcomes.filter((outcome) => "content" in outcome).length;
  if (successCount > 0 && successCount < outcomes.length) return "partial";
  if (successCount > 0) return "succeeded_with_items";
  const categories = outcomes
    .filter((outcome): outcome is WebFetchFailure => "error" in outcome)
    .map((outcome) => outcome.error.category);
  if (categories.every((category) => category === "rate_limited")) return "rate_limited";
  if (categories.every((category) => category === "transient_failure")) return "transient_failure";
  return "rejected";
}

function safePageError(category: WebFetchProviderErrorCategory): string {
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
      return "Web Fetch provider rejected the page request";
    case "not_found":
      return "The selected page was not found";
    case "malformed_content":
      return "The selected page returned malformed content";
    default:
      return "Web Fetch provider could not complete this page";
  }
}

function safeRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/(?:bearer|api[_-]?key|secret|password|credential)/i.test(value)) return null;
  const result = value.replace(/\s+/g, " ").trim().slice(0, MAX_REQUEST_ID_LENGTH);
  return result || null;
}

function safeCredits(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(2_000, Math.max(0, seconds * 1_000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(2_000, Math.max(0, timestamp - Date.now())) : 0;
}

function safeRetryCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 2)
    : 0;
}

function safeRetryAt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function mergeRetryDisposition(
  current: WebFetchAttemptDetails["retryDisposition"],
  retryCount: number,
  failed: boolean,
): WebFetchAttemptDetails["retryDisposition"] {
  const next = retryCount === 0 ? "not_retried" : failed ? "exhausted" : "recovered";
  if (current === "not_retried") return next;
  if (next === "not_retried") return "mixed";
  if (current === next) return current;
  return "mixed";
}

function mergeErrorCategory(current: string | null, next: string): string {
  if (!current) return next;
  return current === next ? current : "mixed";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
