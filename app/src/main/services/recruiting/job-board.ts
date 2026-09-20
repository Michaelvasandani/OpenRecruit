import type { JobBoardRow, SignalSummary } from "@shared/recruiting";

const EXCERPT_LENGTH = 600;
const TITLE_LENGTH = 160;

export type JobBoardLookups = {
  sources: ReadonlyMap<string, { kind: string; name: string }>;
  /** Scout names by id, archived Scouts included, so old Signals stay attributed. */
  scouts: ReadonlyMap<string, string>;
};

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const COMPANY_SUFFIX = /\s@\s+([^@]+)$/;

/** Best-effort organization for a job Signal. Order: an explicit "@ Company"
 * title suffix, a "Company (YC X00) Is Hiring" title, an "At Company" opener,
 * then the board slug of an Ashby posting URL. */
export function deriveCompany(title: string, url: string | null): string | null {
  const suffix = COMPANY_SUFFIX.exec(title);
  if (suffix) return suffix[1].trim();
  const hiring = /^(.+?)\s*(?:\([^)]*\))?\s+is hiring\b/i.exec(title);
  if (hiring) return hiring[1].trim();
  const opener = /^At ([A-Z][\w.&-]*(?: [A-Z][\w.&-]*)*)\b.*\bhiring\b/.exec(title);
  if (opener) return opener[1];
  if (url) {
    const ashby = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i.exec(url);
    if (ashby) return titleCaseSlug(decodeURIComponent(ashby[1]));
  }
  return null;
}

export function toJobBoardRow(signal: SignalSummary, lookups: JobBoardLookups): JobBoardRow {
  const { evidence } = signal;
  const url = signal.canonicalUrl ?? evidence.canonicalUrl;
  const handle = evidence.author?.username ? `@${evidence.author.username}` : null;
  // X Signals are titled with the author handle; the post's first line says more.
  const firstLine = evidence.content.split("\n").find((line) => line.trim()) ?? "";
  // Withheld post text leaves no first line; the handle is then all there is.
  const rawTitle = (handle && evidence.title === handle && firstLine) || evidence.title;
  const company = deriveCompany(rawTitle, url);
  const title = rawTitle.replace(COMPANY_SUFFIX, "").trim().slice(0, TITLE_LENGTH);
  const source = lookups.sources.get(signal.sourceId);
  const scoutIds = [...new Set([...signal.attributions.map((a) => a.scoutId), signal.scoutId])];
  const judgment = evidence.fitJudgment;
  return {
    signalId: signal.id,
    title,
    company,
    author: handle,
    url,
    excerpt: evidence.content.replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH),
    sourceId: signal.sourceId,
    sourceKind: source?.kind ?? "unknown",
    sourceName: source?.name ?? "Unknown Source",
    scouts: scoutIds.flatMap((id) => {
      const name = lookups.scouts.get(id);
      return name ? [{ id, name }] : [];
    }),
    fit: judgment?.scoutFitProbability ?? null,
    experienceLevel: judgment?.requiredExperience.level ?? null,
    minimumYears: judgment?.requiredExperience.minimumYears ?? null,
    publicationAt: signal.publicationAt,
    observedAt: signal.observedAt,
    freshness: signal.freshness,
  };
}
