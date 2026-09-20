import type { JobBoardRow } from "@shared/recruiting";

export type SortKey =
  | "title"
  | "company"
  | "fit"
  | "minimumYears"
  | "sourceName"
  | "scout"
  | "publicationAt"
  | "observedAt";

export type JobBoardSort = { key: SortKey; direction: "asc" | "desc" };
export type JobBoardFilter = { query: string; sourceId: string | null };

const EXPERIENCE_LABELS: Record<string, string> = {
  entry_level: "Entry level",
  two_years: "2 years",
  three_to_four_years: "3–4 years",
  five_plus_years: "5+ years",
  not_stated: "Not stated",
};

export function experienceLabel(level: string | null): string {
  if (level === null) return "—";
  return EXPERIENCE_LABELS[level] ?? level;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A date short enough for a narrow column: relative for the last month, then
 * a bare calendar date. The full timestamp belongs in the cell's tooltip. */
export function compactWhen(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return "—";
  const elapsed = Math.max(0, now - ts);
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.round(elapsed / MINUTE_MS))}m ago`;
  if (elapsed < DAY_MS) return `${Math.round(elapsed / HOUR_MS)}h ago`;
  if (elapsed < 30 * DAY_MS) return `${Math.round(elapsed / DAY_MS)}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

function sortValue(row: JobBoardRow, key: SortKey): string | number | null {
  if (key === "scout") return row.scouts[0]?.name ?? null;
  return row[key];
}

function matchesQuery(row: JobBoardRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    row.title,
    row.company,
    row.author,
    row.sourceName,
    row.excerpt,
    ...row.scouts.map((s) => s.name),
  ]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

/** Filter then sort. Rows missing the sorted value sink to the bottom in both
 * directions, so reversing a sort never buries the judged rows. */
export function viewRows(
  rows: readonly JobBoardRow[],
  filter: JobBoardFilter,
  sort: JobBoardSort,
): JobBoardRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows
    .filter((row) => filter.sourceId === null || row.sourceId === filter.sourceId)
    .filter((row) => matchesQuery(row, filter.query))
    .sort((left, right) => {
      const a = sortValue(left, sort.key);
      const b = sortValue(right, sort.key);
      if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
      return String(a).localeCompare(String(b), undefined, { sensitivity: "base" }) * sign;
    });
}

export function sourceOptions(
  rows: readonly JobBoardRow[],
): Array<{ id: string; name: string; count: number }> {
  const options = new Map<string, { id: string; name: string; count: number }>();
  for (const row of rows) {
    const option = options.get(row.sourceId) ?? {
      id: row.sourceId,
      name: row.sourceName,
      count: 0,
    };
    option.count += 1;
    options.set(row.sourceId, option);
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function groupByScout(
  rows: readonly JobBoardRow[],
): Array<{ id: string; name: string; rows: JobBoardRow[] }> {
  const groups = new Map<string, { id: string; name: string; rows: JobBoardRow[] }>();
  for (const row of rows) {
    for (const scout of row.scouts) {
      const group = groups.get(scout.id) ?? { ...scout, rows: [] };
      group.rows.push(row);
      groups.set(scout.id, group);
    }
  }
  return [...groups.values()];
}
