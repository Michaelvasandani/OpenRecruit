import { createHash } from "node:crypto";
import { RecruitingError } from "./errors";

export type FeedRequest = {
  url: string;
  headers: Record<string, string>;
  cursor: string | null;
  signal?: AbortSignal;
};

export type FeedResponse = {
  status: number;
  body: string;
  etag?: string | null;
  lastModified?: string | null;
  retryAfterMs?: number | null;
  costCents?: number;
  nextCursor?: string | null;
};

export interface FeedProvider {
  fetch(request: FeedRequest): Promise<FeedResponse>;
}

/** Production HTTP adapter. The application owns the URL, headers, response
 * size, and timeout policy; callers cannot provide arbitrary network capability. */
export class HttpFeedProvider implements FeedProvider {
  async fetch(request: FeedRequest): Promise<FeedResponse> {
    const response = await fetch(request.url, {
      method: "GET",
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        ...request.headers,
      },
      redirect: "error",
      signal: request.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      body,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    };
  }
}

/** A deterministic provider for tests and local host simulations. It never
 * performs network I/O and records only safe request metadata. */
export class DeterministicFeedProvider implements FeedProvider {
  readonly requests: FeedRequest[] = [];
  private readonly responses = new Map<string, FeedResponse[]>();

  constructor(fixtures: Record<string, FeedResponse | FeedResponse[]>) {
    for (const [url, response] of Object.entries(fixtures)) {
      this.responses.set(url, Array.isArray(response) ? [...response] : [response]);
    }
  }

  async fetch(request: FeedRequest): Promise<FeedResponse> {
    this.requests.push({ ...request, headers: { ...request.headers } });
    const queue = this.responses.get(request.url);
    if (!queue || queue.length === 0) {
      return { status: 404, body: "" };
    }
    return queue.length > 1 ? (queue.shift() as FeedResponse) : (queue[0] as FeedResponse);
  }
}

export type FeedItem = {
  identityKey: string;
  providerIdentity: string | null;
  canonicalUrl: string | null;
  title: string;
  content: string;
  publicationAt: number | null;
  /** Optional provider-specific evidence that remains safe to normalize into a Signal. */
  metadata?: FeedItemMetadata;
  /** Source-specific retention may be shorter than the default evidence window. */
  retentionUntil?: number;
};

export type FeedItemMetadata = {
  provider?: string;
  state?: "available" | "deleted" | "protected" | "withheld" | "deleted_or_unavailable";
  author?: {
    id: string;
    username: string | null;
    name: string | null;
    protected?: boolean;
    withheld?: unknown;
  } | null;
  editHistory?: string[];
  withheld?: unknown;
  protected?: boolean;
  retentionUntil?: number | null;
  [key: string]: unknown;
};

export type ParsedFeed = {
  format: "rss" | "atom";
  title: string;
  identity: string;
  items: FeedItem[];
};

export function validateFeedUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new RecruitingError("VALIDATION", "RSS/Atom feed URL must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RecruitingError("VALIDATION", "RSS/Atom feed URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new RecruitingError("VALIDATION", "RSS/Atom feed URL cannot contain credentials");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|secret|password|credential|authorization|api[_-]?key|signature|sig)/i.test(key)) {
      throw new RecruitingError(
        "VALIDATION",
        "RSS/Atom feed URL cannot contain authentication material",
      );
    }
  }
  parsed.hash = "";
  return parsed.toString();
}

export function feedUrlFromConfig(config: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new RecruitingError("VALIDATION", "RSS Source configuration is malformed");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new RecruitingError("VALIDATION", "RSS Source configuration is malformed");
  }
  const value = parsed as Record<string, unknown>;
  const url = value.feedUrl ?? value.url;
  if (typeof url !== "string") {
    throw new RecruitingError("VALIDATION", "RSS/Atom Source requires a feed URL");
  }
  return validateFeedUrl(url);
}

export function parseFeed(body: string, maxBytes = 2_000_000): ParsedFeed {
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new FeedParseError("Feed content exceeded the bounded parser limit");
  }
  const source = body.trim();
  const rss = /<rss(?:\s|>)/i.test(source) || /<rdf:RDF(?:\s|>)/i.test(source);
  const atom = /<feed(?:\s|>)/i.test(source);
  if (!rss && !atom) throw new FeedParseError("Content is not an RSS or Atom feed");

  const title = textBetween(source, atom ? "feed" : "channel", "title");
  const identity = textBetween(source, atom ? "feed" : "channel", atom ? "id" : "link") || title;
  if (!title && !identity) throw new FeedParseError("Feed has no attributable identity");

  const itemTag = atom ? "entry" : "item";
  const items: FeedItem[] = [];
  const itemPattern = new RegExp(`<${itemTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${itemTag}>`, "gi");
  for (const match of source.matchAll(itemPattern)) {
    const fragment = match[1] ?? "";
    const providerIdentity = textBetween(fragment, undefined, atom ? "id" : "guid");
    const canonicalUrl = atom ? atomLink(fragment) : textBetween(fragment, undefined, "link");
    const itemTitle = textBetween(fragment, undefined, "title");
    const content = textBetween(fragment, undefined, atom ? "content" : "description") || itemTitle;
    const publication =
      textBetween(fragment, undefined, atom ? "updated" : "pubDate") ||
      textBetween(fragment, undefined, "published");
    if (!itemTitle && !content && !providerIdentity && !canonicalUrl) continue;
    const identityKey =
      providerIdentity ||
      canonicalUrl ||
      `content:${digest(`${itemTitle}\0${publication}\0${content}`)}`;
    items.push({
      identityKey: normalizeIdentity(identityKey),
      providerIdentity: providerIdentity ? normalizeIdentity(providerIdentity) : null,
      canonicalUrl: canonicalUrl ? normalizeUrl(canonicalUrl) : null,
      title: limitText(itemTitle || "Untitled Signal", 500),
      content: limitText(content || itemTitle, 10_000),
      publicationAt: parseDate(publication),
    });
  }
  return {
    format: atom ? "atom" : "rss",
    title: limitText(title || identity, 500),
    identity,
    items,
  };
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

function textBetween(source: string, parent: string | undefined, tag: string): string {
  const scope = parent
    ? (source.match(new RegExp(`<${parent}(?:\\s[^>]*)?>([\\s\\S]*?)</${parent}>`, "i"))?.[1] ??
      source)
    : source;
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const match = scope.match(pattern);
  if (!match?.[1]) return "";
  return decodeXml(stripTags(match[1])).trim();
}

function atomLink(fragment: string): string {
  const links = [...fragment.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi)];
  const alternate = links.find((link) => !/rel\s*=\s*["']?(?:self|enclosure)/i.test(link[1] ?? ""));
  const match = (alternate ?? links[0])?.[1]?.match(/href\s*=\s*["']([^"']+)["']/i);
  return match?.[1]?.trim() ?? "";
}

function stripTags(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function normalizeIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 1_000);
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseDate(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function limitText(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}
