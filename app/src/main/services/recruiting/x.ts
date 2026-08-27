import {
  XSourceProvider as XSourceProviderSchema,
  type XSourceProvider as XSourceProviderValue,
} from "@shared/recruiting";
import type { BirdAccess } from "../settings";
import {
  BIRD_OUTPUT_LIMIT_BYTES,
  BIRD_SUPPORTED_VERSION,
  BirdOperationCancelledError,
  birdAccountQueueKey,
  enqueueBirdOperation,
  executeBirdRead,
  executeBirdSearch,
} from "../settings/bird";
import type { FeedItem, FeedItemMetadata } from "./source";

export const XSourceProvider = XSourceProviderSchema;
export type XSourceProvider = XSourceProviderValue;

export const X_API_BASE_URL = "https://api.x.com";

export class XApiError extends Error {
  constructor(
    message: string,
    readonly kind: "malformed_config" | "malformed_content",
  ) {
    super(message);
    this.name = "XApiError";
  }
}

export type XOperation = "search_recent" | "lookup" | "read";

/** Safe provider failure labels. Raw Bird diagnostics never cross this seam. */
export type XProviderFailureCategory =
  | "missing_configuration"
  | "stale_consent"
  | "authentication"
  | "reauthentication_required"
  | "rate_limited"
  | "deleted_or_unavailable"
  | "unsupported_version"
  | "timed_out"
  | "cancelled"
  | "malformed_content"
  | "provider_failure";

/** Request metadata deliberately contains no Authorization header or secret. */
export type XApiRequest = {
  operation: XOperation;
  query?: string;
  postIds?: string[];
  startTime?: string;
  endTime?: string;
  maxResults?: number;
  paginationToken?: string | null;
  fields: readonly string[];
  expansions: readonly string[];
  userFields: readonly string[];
  signal?: AbortSignal;
  /** Host-only deadline for the single Bird subprocess. */
  timeoutMs?: number;
};

export type XApiResponse = {
  status: number;
  body: string;
  retryAfterMs?: number | null;
  costCents?: number;
  failureCategory?: XProviderFailureCategory;
  /** Safe operational timing; never includes provider payloads. */
  queueWaitMs?: number;
  executionMs?: number;
};

export type XSearchEvidence = {
  evidenceReference: string;
  sourceAttemptId: string;
  providerIdentity: string;
  canonicalUrl: string;
  text: string;
  author: {
    id: string;
    username: string | null;
    name: string | null;
  } | null;
  createdAt: number | null;
  retrievedAt: number;
  available: boolean;
  trust: "untrusted_evidence";
  provenance: { provider: "bird" };
};

export type XSearchResult = {
  query: string;
  limit: number;
  sourceAttemptId: string;
  retrievedAt: number;
  provider: "bird";
  trust: "untrusted_evidence";
  trustBoundary: {
    content: "untrusted_evidence";
    instructionsAndHostPolicy: "immutable";
  };
  availableCount: number;
  resultCount: number;
  results: XSearchEvidence[];
};

export type XReadAuthor = {
  id: string;
  username: string | null;
  name: string | null;
};

export type XReadEngagement = {
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  quoteCount?: number;
  bookmarkCount?: number;
  viewCount?: number;
};

export type XReadReplyParent = {
  postId: string;
  canonicalUrl: string | null;
  author: XReadAuthor | null;
};

export type XReadQuotedPost = {
  postId: string;
  canonicalUrl: string | null;
  text: string;
  author: XReadAuthor | null;
  createdAt: number | null;
  engagement: XReadEngagement | null;
  conversationId: string | null;
  replyParent: XReadReplyParent | null;
  mediaUrls: string[];
};

export type XReadEvidence = {
  /** Alias for providerIdentity that makes the public post identity explicit. */
  postId: string;
  evidenceReference: string;
  sourceAttemptId: string;
  providerIdentity: string;
  canonicalUrl: string;
  text: string;
  author: XReadAuthor | null;
  createdAt: number | null;
  engagement: XReadEngagement | null;
  conversationId: string | null;
  /** Identity returned passively by Bird; no parent is fetched. */
  replyParent: XReadReplyParent | null;
  /** At most one quoted post, with no nested quote. */
  quotedPost: XReadQuotedPost | null;
  /** URL metadata only; media is never downloaded. */
  mediaUrls: string[];
  retrievedAt: number;
  available: true;
  trust: "untrusted_evidence";
  provenance: { provider: "bird" };
};

export type XReadResult = XReadEvidence;

export type NormalizedXRead = { item: FeedItem };

export interface XProvider {
  request(request: XApiRequest): Promise<XApiResponse>;
}

/** Host-owned Bird adapter. A Scout can provide only the query and limit; the
 * consent-bound settings callback supplies the executable identity. */
export class BirdXProvider implements XProvider {
  constructor(private readonly access: () => BirdAccess | null) {}

  async request(request: XApiRequest): Promise<XApiResponse> {
    if (request.operation === "read") {
      const postId = request.postIds?.length === 1 ? request.postIds[0] : null;
      if (
        !postId ||
        !/^\d{1,30}$/.test(postId) ||
        request.query !== undefined ||
        request.paginationToken !== undefined ||
        request.maxResults !== undefined
      ) {
        return { status: 400, body: "" };
      }
      const access = this.access();
      if (!access || !access.resolvedPath)
        return { status: 401, body: "", failureCategory: "reauthentication_required" };
      if (access.version !== BIRD_SUPPORTED_VERSION) {
        return { status: 426, body: "", failureCategory: "unsupported_version" };
      }
      const queued = await this.enqueue(access, request, async () => {
        if (!sameBirdConsent(access, this.access())) return unavailableBirdExecution();
        const executionStartedAt = Date.now();
        const result = await executeBirdRead(
          access.resolvedPath,
          postId,
          request.signal,
          request.timeoutMs,
        );
        return { ...result, executionMs: Math.max(0, Date.now() - executionStartedAt) };
      });
      const execution = queued.value;
      const queueWaitMs = queued.queueWaitMs;
      const executionMs = execution.executionMs;
      if (execution.timedOut)
        return {
          status: 504,
          body: "",
          failureCategory: "timed_out",
          queueWaitMs,
          executionMs,
        };
      if (execution.cancelled)
        return { status: 499, body: "", failureCategory: "cancelled", queueWaitMs, executionMs };
      if (execution.outputExceededLimit)
        return {
          status: 413,
          body: "",
          failureCategory: "malformed_content",
          queueWaitMs,
          executionMs,
        };
      if (execution.spawnError || execution.exitCode !== 0) {
        return {
          status: execution.failureCategory === "rate_limited" ? 429 : 503,
          body: "",
          failureCategory: execution.failureCategory ?? "provider_failure",
          queueWaitMs,
          executionMs,
        };
      }
      return { status: 200, body: execution.stdout, queueWaitMs, executionMs };
    }
    if (
      request.operation !== "search_recent" ||
      typeof request.query !== "string" ||
      !request.query.trim()
    ) {
      return { status: 400, body: "" };
    }
    const limit = request.maxResults ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25 || request.query.trim().length > 512) {
      return { status: 400, body: "" };
    }
    const access = this.access();
    if (!access || !access.resolvedPath) {
      return { status: 401, body: "", failureCategory: "reauthentication_required" };
    }
    if (access.version !== BIRD_SUPPORTED_VERSION) {
      return { status: 426, body: "", failureCategory: "unsupported_version" };
    }
    const queued = await this.enqueue(access, request, async () => {
      if (!sameBirdConsent(access, this.access())) return unavailableBirdExecution();
      const executionStartedAt = Date.now();
      const result = await executeBirdSearch(
        access.resolvedPath,
        request.query?.trim() ?? "",
        limit,
        request.signal,
        request.timeoutMs,
      );
      return { ...result, executionMs: Math.max(0, Date.now() - executionStartedAt) };
    });
    const execution = queued.value;
    const queueWaitMs = queued.queueWaitMs;
    const executionMs = execution.executionMs;
    if (execution.timedOut)
      return {
        status: 504,
        body: "",
        failureCategory: "timed_out",
        queueWaitMs,
        executionMs,
      };
    if (execution.cancelled)
      return { status: 499, body: "", failureCategory: "cancelled", queueWaitMs, executionMs };
    if (execution.outputExceededLimit)
      return {
        status: 413,
        body: "",
        failureCategory: "malformed_content",
        queueWaitMs,
        executionMs,
      };
    if (execution.spawnError || execution.exitCode !== 0) {
      return {
        status: execution.failureCategory === "rate_limited" ? 429 : 503,
        body: "",
        failureCategory: execution.failureCategory ?? "provider_failure",
        queueWaitMs,
        executionMs,
      };
    }
    return { status: 200, body: execution.stdout, queueWaitMs, executionMs };
  }

  private async enqueue<T extends { failureCategory: string | null }>(
    access: BirdAccess,
    request: XApiRequest,
    operation: () => Promise<T>,
  ): Promise<{ value: T; queueWaitMs: number }> {
    try {
      return await enqueueBirdOperation(
        birdAccountQueueKey({
          accountIdentity: access.accountIdentity,
          fingerprint: access.fingerprint,
        }),
        request.signal,
        operation,
      );
    } catch (error) {
      if (error instanceof BirdOperationCancelledError) {
        return {
          value: {
            failureCategory: "cancelled",
            cancelled: true,
            timedOut: false,
            outputExceededLimit: false,
            spawnError: false,
            exitCode: null,
            stdout: "",
            executionMs: 0,
          } as unknown as T,
          queueWaitMs: error.queueWaitMs,
        };
      }
      throw error;
    }
  }
}

function sameBirdConsent(expected: BirdAccess, current: BirdAccess | null): boolean {
  return Boolean(
    current &&
      current.version === expected.version &&
      current.fingerprint === expected.fingerprint &&
      current.resolvedPath === expected.resolvedPath &&
      birdAccountQueueKey({
        accountIdentity: current.accountIdentity,
        fingerprint: current.fingerprint,
      }) ===
        birdAccountQueueKey({
          accountIdentity: expected.accountIdentity,
          fingerprint: expected.fingerprint,
        }),
  );
}

function unavailableBirdExecution() {
  return {
    exitCode: null,
    stdout: "",
    outputExceededLimit: false,
    timedOut: false,
    cancelled: false,
    spawnError: false,
    failureCategory: "reauthentication_required" as const,
    executionMs: 0,
  };
}

/** Official X API v2 public-read client. The token is process configuration,
 * never part of an XApiRequest or persisted Source configuration. */
export class HttpXProvider implements XProvider {
  private readonly bearerToken: string | null;

  constructor(bearerToken = configuredBearerToken()) {
    this.bearerToken = bearerToken?.trim() || null;
  }

  async request(request: XApiRequest): Promise<XApiResponse> {
    if (!this.bearerToken) return { status: 401, body: "" };
    const url = requestUrl(request);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.bearerToken}`,
      },
      redirect: "error",
      signal: request.signal,
    });
    return {
      status: response.status,
      body: await response.text(),
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    };
  }
}

/** Deterministic, network-free provider used by tests and local simulations. */
export class DeterministicXProvider implements XProvider {
  readonly requests: XApiRequest[] = [];
  private readonly searchResponses: XApiResponse[];
  private readonly lookupResponses: XApiResponse[];
  private readonly readResponses: XApiResponse[];
  private readonly readinessResponses: XApiResponse[];

  constructor(input: {
    search?: XApiResponse | XApiResponse[];
    lookup?: XApiResponse | XApiResponse[];
    read?: XApiResponse | XApiResponse[];
    readiness?: XApiResponse | XApiResponse[];
  }) {
    this.searchResponses = asQueue(input.search ?? { status: 404, body: "" });
    this.lookupResponses = asQueue(input.lookup ?? { status: 404, body: "" });
    this.readResponses = asQueue(input.read ?? input.search ?? { status: 404, body: "" });
    this.readinessResponses = asQueue(input.readiness ?? input.search ?? { status: 404, body: "" });
  }

  async request(request: XApiRequest): Promise<XApiResponse> {
    this.requests.push({
      ...request,
      postIds: request.postIds ? [...request.postIds] : undefined,
      fields: [...request.fields],
      expansions: [...request.expansions],
      userFields: [...request.userFields],
    });
    return take(
      request.operation === "lookup"
        ? this.lookupResponses
        : request.operation === "read"
          ? this.readResponses
          : this.searchResponses,
    );
  }

  async readiness(request: XApiRequest): Promise<XApiResponse> {
    this.requests.push({
      ...request,
      postIds: request.postIds ? [...request.postIds] : undefined,
      fields: [...request.fields],
      expansions: [...request.expansions],
      userFields: [...request.userFields],
    });
    return take(this.readinessResponses);
  }
}

export const XApiProvider = HttpXProvider;

export type XSourceConfig = {
  /** Immutable retrieval provider for this X Source. Legacy config defaults to X API v2. */
  provider: XSourceProviderValue;
  query: string | null;
  postIds: string[];
  windowHours: number;
  maxPages: number;
  maxItems: number;
  maxSpendCents: number;
  maxRequestsPerRun: number;
};

export const X_POST_FIELDS = [
  "id",
  "text",
  "created_at",
  "author_id",
  "edit_history_tweet_ids",
  "entities",
  "attachments",
  "referenced_tweets",
  "withheld",
] as const;

export const X_EXPANSIONS = ["author_id"] as const;
export const X_USER_FIELDS = ["id", "name", "username", "protected", "withheld"] as const;

export function xConfigFromSource(config: string): XSourceConfig {
  let value: unknown;
  try {
    value = JSON.parse(config);
  } catch {
    throw new XApiError("X Source configuration is malformed", "malformed_config");
  }
  if (!value || typeof value !== "object")
    throw new XApiError("X Source configuration is malformed", "malformed_config");
  const record = value as Record<string, unknown>;
  const providerValue = record.provider;
  const provider =
    providerValue === undefined
      ? "x-api-v2"
      : XSourceProviderSchema.safeParse(providerValue).success
        ? (providerValue as XSourceProviderValue)
        : null;
  if (!provider) {
    throw new XApiError("X Source provider must be X API v2 or Bird", "malformed_config");
  }
  const queryValue = record.query ?? record.searchQuery;
  const query = typeof queryValue === "string" && queryValue.trim() ? queryValue.trim() : null;
  const idsValue = record.postIds ?? record.ids;
  if (idsValue !== undefined && !Array.isArray(idsValue))
    throw new XApiError("X Post IDs must be an array", "malformed_config");
  if (
    Array.isArray(idsValue) &&
    idsValue.some((item) => typeof item !== "string" || !/^\d{1,30}$/.test(item))
  )
    throw new XApiError("X Post IDs must be numeric public IDs", "malformed_config");
  const postIds = Array.isArray(idsValue)
    ? idsValue.filter((item): item is string => typeof item === "string" && /^\d{1,30}$/.test(item))
    : [];
  if (!query && postIds.length === 0) {
    throw new XApiError(
      "X Source requires recent-search terms derived from the Discovery Strategy or public Post IDs",
      "malformed_config",
    );
  }
  if (query && query.length > 512)
    throw new XApiError(
      "X recent-search terms derived from the Discovery Strategy exceed the bounded length",
      "malformed_config",
    );
  if (postIds.length > 100)
    throw new XApiError("X Post lookup is limited to 100 IDs", "malformed_config");
  const configuredWindowHours =
    record.windowHours ??
    record.lookbackHours ??
    (typeof record.windowDays === "number" ? record.windowDays * 24 : undefined);
  const windowHours = boundedNumber(configuredWindowHours, 168, 1, 168);
  const maxPages = boundedNumber(record.maxPages, 10, 1, 100);
  const maxItems = boundedNumber(record.maxItems, 100, 1, 10_000);
  const maxSpendCents = boundedNumber(record.maxSpendCents, 0, 0, 10_000_000);
  const maxRequestsPerRun = boundedNumber(
    record.maxRequestsPerRun ??
      record.rateLimitPerRun ??
      record.maxRequestsPerMinute ??
      record.rateLimitPerMinute,
    maxPages,
    1,
    100,
  );
  return {
    provider,
    query,
    postIds,
    windowHours,
    maxPages,
    maxItems,
    maxSpendCents,
    maxRequestsPerRun,
  };
}

export function xRequestForSearch(
  config: XSourceConfig,
  now: number,
  paginationToken: string | null = null,
  maxResults = Math.min(100, Math.max(10, config.maxItems)),
): XApiRequest {
  return {
    operation: "search_recent",
    query: config.query ?? "-is:retweet",
    startTime: new Date(now - config.windowHours * 60 * 60 * 1_000).toISOString(),
    endTime: new Date(now).toISOString(),
    maxResults,
    paginationToken,
    fields: X_POST_FIELDS,
    expansions: X_EXPANSIONS,
    userFields: X_USER_FIELDS,
  };
}

export function xRequestForLookup(config: XSourceConfig): XApiRequest {
  return {
    operation: "lookup",
    postIds: config.postIds.slice(0, 100),
    fields: X_POST_FIELDS,
    expansions: X_EXPANSIONS,
    userFields: X_USER_FIELDS,
  };
}

/** Construct the only Bird read request exposed by the host boundary. */
export function xRequestForRead(postId: string): XApiRequest {
  return {
    operation: "read",
    postIds: [postId],
    fields: X_POST_FIELDS,
    expansions: X_EXPANSIONS,
    userFields: X_USER_FIELDS,
  };
}

export type NormalizedXPage = {
  items: FeedItem[];
  nextCursor: string | null;
  resultCount: number;
};

/** Normalize Bird's stable JSON search output into the same bounded FeedItem
 * shape used by the official X adapter. Only public post identity, text,
 * author, and timestamps are retained; unknown provider fields are dropped. */
export function normalizeBirdResponse(body: string, retentionUntil?: number): NormalizedXPage {
  if (Buffer.byteLength(body, "utf8") > BIRD_OUTPUT_LIMIT_BYTES)
    throw new XApiError("Bird response exceeded the bounded parser limit", "malformed_content");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new XApiError("Bird returned malformed JSON", "malformed_content");
  }
  const records = birdRecords(value);
  if (!records) throw new XApiError("Bird search output is malformed", "malformed_content");
  const items = records.flatMap((record) => normalizeBirdPost(record, retentionUntil));
  if (records.length > 0 && items.length === 0) {
    throw new XApiError("Bird search output has no valid public posts", "malformed_content");
  }
  const resultCount = birdResultCount(value) ?? items.length;
  return { items, nextCursor: null, resultCount };
}

/** Normalize one Bird `read --json` result. This parser accepts only a
 * provider object for the requested post and never follows related objects.
 * A missing post is represented as a typed unavailable error so callers can
 * distinguish it from a successful empty result. */
export function normalizeBirdReadResponse(
  body: string,
  requestedPostId: string,
  requestedCanonicalUrl?: string,
  retentionUntil?: number,
): NormalizedXRead {
  if (!/^\d{1,30}$/.test(requestedPostId)) {
    throw new XReadContentError("The requested X post identity is malformed", "malformed_content");
  }
  if (Buffer.byteLength(body, "utf8") > BIRD_OUTPUT_LIMIT_BYTES) {
    throw new XReadContentError(
      "Bird response exceeded the bounded parser limit",
      "malformed_content",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new XReadContentError("Bird returned malformed JSON", "malformed_content");
  }
  const record = birdReadRecord(value);
  if (!record) {
    if (birdUnavailable(value)) {
      throw new XReadContentError(
        "Bird could not find the requested public X post",
        "deleted_or_unavailable",
      );
    }
    throw new XReadContentError("Bird read output is malformed", "malformed_content");
  }
  const postId = birdPostId(record);
  if (!postId || postId !== requestedPostId) {
    throw new XReadContentError(
      "Bird read output did not contain the requested public X post",
      "malformed_content",
    );
  }
  if (birdRecordUnavailable(record)) {
    throw new XReadContentError(
      "Bird could not find the requested public X post",
      "deleted_or_unavailable",
    );
  }

  const author = birdReadAuthor(record);
  const canonicalUrl =
    birdCanonicalUrl(
      record.canonical_url ?? record.canonicalUrl ?? record.url ?? record.permalink,
      postId,
    ) ??
    requestedCanonicalUrl ??
    `https://x.com/i/web/status/${postId}`;
  const text = stringValue(record.text ?? record.full_text ?? record.content, 10_000) ?? "";
  const createdAt = normalizeBirdTimestamp(
    record.created_at ?? record.createdAt ?? record.timestamp,
  );
  const engagement = birdEngagement(record);
  const conversationId = birdPostId(
    record.conversation_id ?? record.conversationId ?? record.conversation,
  );
  const replyParent = birdReplyParent(record);
  const quotedPost = birdQuotedPost(record);
  const mediaUrls = birdMediaUrls(record);
  const metadata: FeedItemMetadata = {
    provider: "bird",
    state: "available",
    trust: "untrusted_evidence",
    author: author
      ? {
          id: author.id,
          username: author.username,
          name: author.name,
          protected: false,
          withheld: null,
        }
      : null,
    editHistory: [postId],
    withheld: null,
    protected: false,
    retentionUntil: retentionUntil ?? null,
    xRead: {
      postId,
      canonicalUrl,
      text,
      author,
      createdAt,
      engagement,
      conversationId,
      replyParent,
      quotedPost,
      mediaUrls,
    },
  };
  const item: FeedItem = {
    identityKey: `x:${postId}`,
    providerIdentity: postId,
    canonicalUrl,
    title: author?.username ? `@${author.username}` : "X Post",
    content: text,
    publicationAt: createdAt,
    metadata,
    retentionUntil,
  };
  return { item };
}

/** Structured read parsing failures retain a safe category for Source Attempt
 * audit while avoiding provider payloads and diagnostics. */
export class XReadContentError extends XApiError {
  constructor(
    message: string,
    readonly category: "malformed_content" | "deleted_or_unavailable",
  ) {
    super(message, "malformed_content");
    this.name = "XReadContentError";
  }
}

function birdReadRecord(value: unknown): Record<string, unknown> | null {
  return birdReadRecordAtDepth(value, 0);
}

function birdReadRecordAtDepth(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 3) return null;
  if (isRecord(value) && birdPostId(value)) return value;
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    const only = value[0];
    return birdReadRecordAtDepth(only, depth + 1);
  }
  if (!isRecord(value)) return null;
  for (const key of ["post", "tweet", "result", "data"]) {
    const nested = value[key];
    const found = birdReadRecordAtDepth(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function birdUnavailable(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (typeof value === "string") {
    return /(?:not found|deleted|unavailable|no such post|does not exist|status\s*404|\b404\b)/i.test(
      value,
    );
  }
  if (Array.isArray(value) && value.length === 0) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((entry) => birdUnavailable(entry, depth + 1));
}

function birdRecordUnavailable(value: Record<string, unknown>): boolean {
  if (value.deleted === true || value.available === false) return true;
  const status = value.status ?? value.code ?? value.error_code ?? value.errorCode;
  return status === 404 || status === 410 || status === "404" || status === "410";
}

function birdPostId(value: unknown): string | null {
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return value;
  if (!isRecord(value)) return null;
  const candidate = value.id ?? value.post_id ?? value.postId ?? value.tweet_id ?? value.tweetId;
  return typeof candidate === "string" && /^\d{1,30}$/.test(candidate) ? candidate : null;
}

function birdReadAuthor(value: Record<string, unknown>): XReadAuthor | null {
  const source = isRecord(value.author)
    ? value.author
    : isRecord(value.user)
      ? value.user
      : isRecord(value.author_identity)
        ? value.author_identity
        : birdIncludedAuthor(value);
  const id = stringValue(
    source?.id ?? source?.user_id ?? source?.userId ?? value.author_id ?? value.authorId,
    64,
  );
  if (!id) return null;
  const rawUsername = stringValue(
    source?.username ?? source?.handle ?? source?.screen_name,
    30,
  )?.replace(/^@/, "");
  const username = rawUsername && /^[A-Za-z0-9_]{1,15}$/.test(rawUsername) ? rawUsername : null;
  const name = stringValue(source?.name ?? source?.display_name ?? source?.displayName, 160);
  return { id, username, name };
}

function birdIncludedAuthor(value: Record<string, unknown>): Record<string, unknown> | null {
  const includes = isRecord(value.includes) ? value.includes : null;
  const users = includes?.users;
  if (!Array.isArray(users)) return null;
  const authorId = stringValue(value.author_id ?? value.authorId, 64);
  const match = users.find(
    (entry) => isRecord(entry) && (!authorId || String(entry.id ?? "") === authorId),
  );
  return isRecord(match) ? match : null;
}

function birdEngagement(value: Record<string, unknown>): XReadEngagement | null {
  const source = [value.public_metrics, value.publicMetrics, value.engagement, value.metrics].find(
    isRecord,
  );
  if (!source) return null;
  const result: XReadEngagement = {};
  const count = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const candidate = source[key];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
        return candidate;
      }
    }
    return undefined;
  };
  const likeCount = count(["like_count", "likeCount", "likes", "favorite_count", "favoriteCount"]);
  const replyCount = count(["reply_count", "replyCount", "replies"]);
  const repostCount = count([
    "retweet_count",
    "retweetCount",
    "repost_count",
    "repostCount",
    "reposts",
  ]);
  const quoteCount = count(["quote_count", "quoteCount", "quotes"]);
  const bookmarkCount = count(["bookmark_count", "bookmarkCount", "bookmarks"]);
  const viewCount = count([
    "impression_count",
    "impressionCount",
    "view_count",
    "viewCount",
    "views",
  ]);
  if (likeCount !== undefined) result.likeCount = likeCount;
  if (replyCount !== undefined) result.replyCount = replyCount;
  if (repostCount !== undefined) result.repostCount = repostCount;
  if (quoteCount !== undefined) result.quoteCount = quoteCount;
  if (bookmarkCount !== undefined) result.bookmarkCount = bookmarkCount;
  if (viewCount !== undefined) result.viewCount = viewCount;
  return Object.keys(result).length > 0 ? result : null;
}

function birdReplyParent(value: Record<string, unknown>): XReadReplyParent | null {
  const raw =
    value.reply_parent ??
    value.replyParent ??
    value.in_reply_to ??
    value.inReplyTo ??
    value.in_reply_to_status_id ??
    value.inReplyToStatusId;
  const postId = birdPostId(raw);
  if (!postId) return null;
  const record = isRecord(raw) ? raw : null;
  const author = record ? birdReadAuthor({ author: record.author ?? record.user }) : null;
  const canonicalUrl = record
    ? birdCanonicalUrl(record.canonical_url ?? record.canonicalUrl ?? record.url, postId, false)
    : null;
  return { postId, canonicalUrl, author };
}

function birdQuotedPost(value: Record<string, unknown>): XReadQuotedPost | null {
  const raw =
    value.quoted_post ?? value.quotedPost ?? value.quoted_tweet ?? value.quotedTweet ?? value.quote;
  if (!isRecord(raw)) return null;
  const postId = birdPostId(raw);
  if (!postId) return null;
  const author = birdReadAuthor(raw);
  const canonicalUrl = birdCanonicalUrl(
    raw.canonical_url ?? raw.canonicalUrl ?? raw.url ?? raw.permalink,
    postId,
    false,
  );
  const text = stringValue(raw.text ?? raw.full_text ?? raw.content, 10_000) ?? "";
  const replyParent = birdReplyParent(raw);
  return {
    postId,
    canonicalUrl,
    text,
    author,
    createdAt: normalizeBirdTimestamp(raw.created_at ?? raw.createdAt ?? raw.timestamp),
    engagement: birdEngagement(raw),
    conversationId: birdPostId(raw.conversation_id ?? raw.conversationId ?? raw.conversation),
    replyParent,
    mediaUrls: birdMediaUrls(raw),
  };
}

function birdMediaUrls(value: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    value.media,
    value.media_urls,
    value.mediaUrls,
    isRecord(value.attachments) ? value.attachments.media : undefined,
    isRecord(value.attachments) ? value.attachments.images : undefined,
    isRecord(value.entities) ? value.entities.media : undefined,
  ];
  const result: string[] = [];
  for (const candidate of candidates) {
    const entries = Array.isArray(candidate) ? candidate : [candidate];
    for (const entry of entries) {
      const raw =
        typeof entry === "string"
          ? entry
          : isRecord(entry)
            ? (entry.url ??
              entry.media_url ??
              entry.mediaUrl ??
              entry.expanded_url ??
              entry.expandedUrl)
            : null;
      if (typeof raw !== "string") continue;
      let url: URL;
      try {
        url = new URL(raw.trim());
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      const normalized = url.toString();
      if (!result.includes(normalized)) result.push(normalized);
      if (result.length >= 25) return result;
    }
  }
  return result;
}

function birdCanonicalUrl(value: unknown, postId: string, deriveWhenMissing = true): string | null {
  if (typeof value === "string" && value.trim()) {
    try {
      const url = new URL(value.trim());
      const host = url.hostname.toLowerCase();
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        new RegExp(`^/(?:[A-Za-z0-9_]{1,15}|i/web)/status/${postId}/?$`, "i").test(url.pathname)
      ) {
        url.hash = "";
        url.pathname = url.pathname.replace(/\/$/, "");
        return url.toString();
      }
    } catch {
      // Derive the canonical X URL from the requested public identity below.
    }
  }
  return value === null || value === undefined
    ? deriveWhenMissing
      ? `https://x.com/i/web/status/${postId}`
      : null
    : null;
}

function birdRecords(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) return value.every(isRecord) ? value : null;
  if (!isRecord(value)) return null;
  for (const key of ["data", "posts", "tweets", "results"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.every(isRecord) ? candidate : null;
  }
  return null;
}

function birdResultCount(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const meta = isRecord(value.meta) ? value.meta : value;
  for (const key of ["result_count", "resultCount", "count", "total"]) {
    const candidate = meta[key];
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      return Math.min(candidate, 10_000);
    }
  }
  return null;
}

function normalizeBirdPost(value: Record<string, unknown>, retentionUntil?: number): FeedItem[] {
  const idValue = value.id ?? value.post_id ?? value.tweet_id;
  if (typeof idValue !== "string" || !/^\d{1,30}$/.test(idValue)) return [];
  const id = idValue;
  const authorValue = isRecord(value.author)
    ? value.author
    : isRecord(value.user)
      ? value.user
      : null;
  const authorId = stringValue(value.author_id ?? value.authorId ?? authorValue?.id, 64);
  const rawUsername = stringValue(
    value.username ?? authorValue?.username ?? authorValue?.handle ?? authorValue?.screen_name,
    30,
  );
  const usernameCandidate = rawUsername?.replace(/^@/, "").trim() || null;
  const username =
    usernameCandidate && /^[A-Za-z0-9_]{1,15}$/.test(usernameCandidate) ? usernameCandidate : null;
  const name = stringValue(
    value.author_name ?? authorValue?.name ?? authorValue?.display_name,
    160,
  );
  const text = stringValue(value.text ?? value.full_text ?? value.content, 10_000) ?? "";
  const createdAt = normalizeBirdTimestamp(value.created_at ?? value.createdAt ?? value.timestamp);
  const author = authorId
    ? {
        id: authorId,
        username,
        name,
        protected: false,
        withheld: null,
      }
    : null;
  const metadata: FeedItemMetadata = {
    provider: "bird",
    state: "available",
    trust: "untrusted_evidence",
    author,
    editHistory: [id],
    withheld: null,
    protected: false,
    retentionUntil: retentionUntil ?? null,
  };
  return [
    {
      identityKey: `x:${id}`,
      providerIdentity: id,
      canonicalUrl: `https://x.com/${username ?? "i/web"}/status/${id}`,
      title: username ? `@${username}` : "X Post",
      content: text,
      publicationAt: createdAt,
      metadata,
      retentionUntil,
    },
  ];
}

function normalizeBirdTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(millis) ? Math.round(millis) : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

type XPost = {
  id?: unknown;
  text?: unknown;
  created_at?: unknown;
  author_id?: unknown;
  edit_history_tweet_ids?: unknown;
  withheld?: unknown;
  protected?: unknown;
  deleted?: unknown;
};

type XUser = {
  id?: unknown;
  name?: unknown;
  username?: unknown;
  protected?: unknown;
  withheld?: unknown;
};

export function normalizeXResponse(
  body: string,
  requestedIds: string[] = [],
  retentionUntil?: number,
  provider: XSourceProviderValue = "x-api-v2",
): NormalizedXPage {
  if (Buffer.byteLength(body, "utf8") > 2_000_000)
    throw new XApiError("X response exceeded the bounded parser limit", "malformed_content");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new XApiError("X API returned malformed JSON", "malformed_content");
  }
  if (!value || typeof value !== "object")
    throw new XApiError("X API response is malformed", "malformed_content");
  const record = value as Record<string, unknown>;
  if (record.data === undefined && record.errors === undefined && record.meta === undefined)
    throw new XApiError(
      "X API response has no data, errors, or pagination metadata",
      "malformed_content",
    );
  if (record.errors !== undefined && !Array.isArray(record.errors))
    throw new XApiError("X API errors are malformed", "malformed_content");
  const data = record.data;
  if (data !== undefined && !Array.isArray(data))
    throw new XApiError("X API data is malformed", "malformed_content");
  const users = new Map<string, XUser>();
  const includes = record.includes;
  if (includes !== undefined && (!includes || typeof includes !== "object"))
    throw new XApiError("X API includes are malformed", "malformed_content");
  const userData = (includes as Record<string, unknown> | undefined)?.users;
  if (userData !== undefined && !Array.isArray(userData))
    throw new XApiError("X API user expansions are malformed", "malformed_content");
  for (const user of (userData ?? []) as unknown[]) {
    if (!user || typeof user !== "object") continue;
    const item = user as XUser;
    if (typeof item.id === "string") users.set(item.id, item);
  }
  const posts = (data ?? []) as unknown[];
  const items = posts.flatMap((post) => normalizeXPost(post, users, retentionUntil, provider));
  const presentIds = new Set(
    items.map((item) => item.providerIdentity).filter((id): id is string => Boolean(id)),
  );
  for (const id of requestedIds) {
    if (!presentIds.has(id))
      items.push(unavailableXItem(id, "deleted_or_unavailable", retentionUntil, provider));
  }
  const meta = record.meta;
  if (meta !== undefined && (!meta || typeof meta !== "object"))
    throw new XApiError("X API meta is malformed", "malformed_content");
  const resultCountValue = (meta as Record<string, unknown> | undefined)?.result_count;
  if (resultCountValue !== undefined && typeof resultCountValue !== "number")
    throw new XApiError("X API result count is malformed", "malformed_content");
  const resultCount =
    typeof resultCountValue === "number" ? Number(resultCountValue) : items.length;
  const nextToken = (meta as Record<string, unknown> | undefined)?.next_token;
  if (nextToken !== undefined && typeof nextToken !== "string")
    throw new XApiError("X API pagination token is malformed", "malformed_content");
  return { items, nextCursor: nextToken ?? null, resultCount };
}

function normalizeXPost(
  post: unknown,
  users: Map<string, XUser>,
  retentionUntil?: number,
  provider: XSourceProviderValue = "x-api-v2",
): FeedItem[] {
  if (!post || typeof post !== "object")
    throw new XApiError("X API returned a malformed Post object", "malformed_content");
  const value = post as XPost;
  if (typeof value.id !== "string" || !/^\d{1,30}$/.test(value.id))
    throw new XApiError(
      "X API returned a Post without a valid public identity",
      "malformed_content",
    );
  const author = typeof value.author_id === "string" ? users.get(value.author_id) : undefined;
  const authorMetadata =
    author && typeof author.id === "string"
      ? {
          id: author.id,
          username: typeof author.username === "string" ? author.username : null,
          name: typeof author.name === "string" ? author.name : null,
          protected: author.protected === true,
          withheld: author.withheld ?? null,
        }
      : value.author_id === undefined
        ? null
        : {
            id: String(value.author_id),
            username: null,
            name: null,
            protected: false,
            withheld: null,
          };
  const state = stateForPost(value, author);
  const editHistory = Array.isArray(value.edit_history_tweet_ids)
    ? value.edit_history_tweet_ids.filter((id): id is string => typeof id === "string")
    : [value.id];
  const metadata: FeedItemMetadata = {
    provider,
    state,
    author: authorMetadata,
    editHistory,
    withheld: value.withheld ?? author?.withheld ?? null,
    protected: value.protected === true || author?.protected === true,
    retentionUntil: retentionUntil ?? null,
  };
  const username =
    authorMetadata && typeof authorMetadata.username === "string" ? authorMetadata.username : null;
  return [
    {
      identityKey: `x:${value.id}`,
      providerIdentity: value.id,
      canonicalUrl: `https://x.com/${username ?? "i/web"}/status/${value.id}`,
      title: username ? `@${username}` : "X Post",
      content: typeof value.text === "string" ? value.text.slice(0, 10_000) : "",
      publicationAt:
        typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at))
          ? Date.parse(value.created_at)
          : null,
      metadata,
      retentionUntil,
    },
  ];
}

function unavailableXItem(
  id: string,
  state: FeedItemMetadata["state"],
  retentionUntil?: number,
  provider: XSourceProviderValue = "x-api-v2",
): FeedItem {
  return {
    identityKey: `x:${id}`,
    providerIdentity: id,
    canonicalUrl: `https://x.com/i/web/status/${id}`,
    title: "Unavailable X Post",
    content: "",
    publicationAt: null,
    metadata: {
      provider,
      state,
      author: null,
      editHistory: [id],
      withheld: null,
      protected: false,
      retentionUntil: retentionUntil ?? null,
    },
    retentionUntil,
  };
}

function stateForPost(post: XPost, author?: XUser): FeedItemMetadata["state"] {
  if (post.deleted === true) return "deleted";
  if (post.protected === true || author?.protected === true) return "protected";
  if (
    (post.withheld !== undefined && post.withheld !== null) ||
    (author?.withheld !== undefined && author.withheld !== null)
  )
    return "withheld";
  return "available";
}

function requestUrl(request: XApiRequest): string {
  const path = request.operation === "lookup" ? "/2/tweets" : "/2/tweets/search/recent";
  const query = new URLSearchParams();
  if (request.query) query.set("query", request.query);
  if (request.postIds?.length) query.set("ids", request.postIds.join(","));
  if (request.startTime) query.set("start_time", request.startTime);
  if (request.endTime) query.set("end_time", request.endTime);
  if (request.maxResults) query.set("max_results", String(request.maxResults));
  if (request.paginationToken) query.set("pagination_token", request.paginationToken);
  query.set("tweet.fields", request.fields.join(","));
  query.set("expansions", request.expansions.join(","));
  query.set("user.fields", request.userFields.join(","));
  return `${X_API_BASE_URL}${path}?${query.toString()}`;
}

function configuredBearerToken(): string | null {
  return (
    process.env.OPENRECRUIT_X_BEARER_TOKEN?.trim() || process.env.X_API_BEARER_TOKEN?.trim() || null
  );
}

function asQueue(value: XApiResponse | XApiResponse[]): XApiResponse[] {
  return Array.isArray(value) ? [...value] : [value];
}

function take(queue: XApiResponse[]): XApiResponse {
  return queue.length > 1 ? (queue.shift() as XApiResponse) : (queue[0] as XApiResponse);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new XApiError("X Source configuration contains an invalid bound", "malformed_config");
  return value;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}
