import type { JobBoardRow } from "@shared/recruiting";
import { ArrowDown, ArrowUp, ExternalLink, Loader2, Search } from "lucide-react";
import { type CSSProperties, Fragment, useMemo, useState } from "react";
import { dateTime } from "../lib/format";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { useConnectionStore } from "../stores/connection";
import { useUIStore } from "../stores/ui";
import {
  compactWhen,
  experienceLabel,
  groupByScout,
  type JobBoardSort,
  type SortKey,
  sourceOptions,
  viewRows,
} from "./job-board-model";

const DRAG = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

const COLUMNS: Array<{ key: SortKey; label: string; className?: string }> = [
  { key: "title", label: "Role" },
  { key: "company", label: "Company" },
  { key: "fit", label: "Fit" },
  { key: "minimumYears", label: "Experience" },
  { key: "sourceName", label: "Source" },
  { key: "scout", label: "Scout" },
  { key: "publicationAt", label: "Posted" },
  { key: "observedAt", label: "Found" },
];

/** Numeric columns read best high-to-low first; text columns A-to-Z. */
const DESCENDING_FIRST = new Set<SortKey>(["fit", "publicationAt", "observedAt"]);

const SOURCE_TONES: Record<string, string> = {
  ashby: "bg-violet-500/15 text-violet-400",
  hacker_news: "bg-amber-500/15 text-amber-500",
  x: "bg-sky-500/15 text-sky-400",
  web_search: "bg-emerald-500/15 text-emerald-500",
};

function fitTone(fit: number): { text: string; bar: string } {
  if (fit >= 0.8) return { text: "text-success", bar: "bg-success" };
  if (fit >= 0.6) return { text: "text-warning", bar: "bg-warning" };
  return { text: "text-muted-foreground", bar: "bg-muted-foreground" };
}

export function JobBoardScreen() {
  const board = trpc.recruiting.review.jobBoard.useQuery();
  const utils = trpc.useUtils();
  const backendConnected = useConnectionStore((s) => s.backendConnected);
  const selectScout = useUIStore((s) => s.selectScout);
  const setView = useUIStore((s) => s.setView);
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(false);
  const [sort, setSort] = useState<JobBoardSort>({ key: "observedAt", direction: "desc" });
  const [openId, setOpenId] = useState<string | null>(null);

  trpc.recruiting.onChanged.useSubscription(undefined, {
    onData: (event) => {
      if (event.reason === "resync" || event.kind)
        void utils.recruiting.review.jobBoard.invalidate();
    },
  });

  const rows = board.data?.rows ?? [];
  const sources = useMemo(() => sourceOptions(rows), [rows]);
  const visible = useMemo(
    () => viewRows(rows, { query, sourceId }, sort),
    [rows, query, sourceId, sort],
  );
  const groups = useMemo(() => (grouped ? groupByScout(visible) : null), [grouped, visible]);

  const sortBy = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: DESCENDING_FIRST.has(key) ? "desc" : "asc" },
    );

  const openScout = (id: string) => {
    selectScout(id);
    setView("runs");
  };

  const renderRow = (row: JobBoardRow, groupKey: string) => {
    const open = openId === row.signalId;
    const tone = row.fit === null ? null : fitTone(row.fit);
    return (
      <Fragment key={`${groupKey}:${row.signalId}`}>
        <tr
          onClick={() => setOpenId(open ? null : row.signalId)}
          className={cn(
            "cursor-pointer border-t border-border hover:bg-muted/50",
            open && "bg-muted/50",
          )}
        >
          <td className="max-w-0 py-2 pl-6 pr-3">
            <span className="block truncate font-medium" title={row.title}>
              {row.title}
            </span>
          </td>
          <td className="truncate px-3 py-2" title={row.company ?? row.author ?? undefined}>
            {row.company ?? row.author ?? <span className="text-muted-foreground">—</span>}
          </td>
          <td className="px-3 py-2">
            {row.fit === null || tone === null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <div className="flex w-24 items-center gap-2">
                <span className={cn("w-9 font-semibold tabular-nums", tone.text)}>
                  {Math.round(row.fit * 100)}%
                </span>
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", tone.bar)}
                    style={{ width: `${row.fit * 100}%` }}
                  />
                </div>
              </div>
            )}
          </td>
          <td className="truncate px-3 py-2 text-muted-foreground">
            {experienceLabel(row.experienceLevel)}
          </td>
          <td className="px-3 py-2">
            <span
              title={row.sourceName}
              className={cn(
                "inline-block max-w-full truncate rounded-full px-2 py-0.5 align-middle text-[11px]",
                SOURCE_TONES[row.sourceKind] ?? "bg-muted text-muted-foreground",
              )}
            >
              {row.sourceName}
            </span>
          </td>
          <td
            className="truncate px-3 py-2 text-muted-foreground"
            title={row.scouts.map((scout) => scout.name).join(", ")}
          >
            {row.scouts.map((scout) => scout.name).join(", ") || "—"}
          </td>
          <td
            className="truncate px-3 py-2 text-muted-foreground"
            title={row.publicationAt ? dateTime(row.publicationAt) : undefined}
          >
            {compactWhen(row.publicationAt)}
          </td>
          <td
            className="truncate py-2 pl-3 pr-6 text-muted-foreground"
            title={dateTime(row.observedAt)}
          >
            {compactWhen(row.observedAt)}
          </td>
        </tr>
        {open && (
          <tr className="bg-muted/50">
            <td colSpan={COLUMNS.length} className="px-6 pb-4 pt-1">
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                {row.excerpt || "No posting text was captured for this Signal."}
                {row.excerpt.length >= 600 && "…"}
              </p>
              {row.freshness === "stale" && (
                <p className="mt-2 text-xs text-warning">
                  This Signal's provider text is past retention and may be out of date.
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {row.url && (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
                  >
                    Open posting <ExternalLink className="size-3" />
                  </a>
                )}
                {row.scouts.map((scout) => (
                  <button
                    type="button"
                    key={scout.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      openScout(scout.id);
                    }}
                    className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    View {scout.name} Runs
                  </button>
                ))}
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-6"
        style={DRAG}
      >
        <h1 className="text-sm font-semibold tracking-tight">Job Board</h1>
        <span className="text-xs text-muted-foreground">
          {visible.length === rows.length
            ? `${rows.length} jobs`
            : `${visible.length} of ${rows.length} jobs`}
        </span>
        <div className="relative ml-auto" style={NO_DRAG}>
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search jobs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter roles, companies, Scouts…"
            className="h-7 w-64 rounded-md border border-border bg-transparent pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
      </header>

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          // Backend down: the sheet is stale, so grey it out (sidebar nav stays live).
          !backendConnected && "pointer-events-none opacity-50",
        )}
        style={NO_DRAG}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-6 py-2">
          <Pill active={sourceId === null} onClick={() => setSourceId(null)}>
            All sources
          </Pill>
          {sources.map((source) => (
            <Pill
              key={source.id}
              active={sourceId === source.id}
              onClick={() => setSourceId(sourceId === source.id ? null : source.id)}
            >
              {source.name} <span className="opacity-60">{source.count}</span>
            </Pill>
          ))}
          <span className="mx-1.5 h-4 w-px bg-border" />
          <Pill active={grouped} onClick={() => setGrouped(!grouped)}>
            Group by Scout
          </Pill>
        </div>

        {board.isLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading jobs…
          </div>
        ) : board.error && !board.data ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-destructive">
            The Job Board could not be loaded. {board.error.message}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
            <p className="text-sm font-medium">No jobs yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Every job Signal your Scouts record shows up here. Launch a Scout Run to start filling
              the board.
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-36" />
                <col className="w-32" />
                <col className="w-28" />
                <col className="w-32" />
                <col className="w-40" />
                <col className="w-24" />
                <col className="w-28" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-background">
                <tr>
                  {COLUMNS.map((column, index) => {
                    const sorted = sort.key === column.key;
                    const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
                    return (
                      <th
                        key={column.key}
                        aria-sort={
                          sorted ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                        }
                        className={cn(
                          "border-b border-border px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider",
                          index === 0 && "pl-6",
                          index === COLUMNS.length - 1 && "pr-6",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => sortBy(column.key)}
                          className={cn(
                            "inline-flex items-center gap-1 uppercase tracking-wider hover:text-foreground",
                            sorted ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {column.label}
                          {sorted && <Arrow className="size-3" />}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td
                      colSpan={COLUMNS.length}
                      className="px-6 py-10 text-center text-sm text-muted-foreground"
                    >
                      No jobs match these filters.
                    </td>
                  </tr>
                )}
                {groups
                  ? groups.map((group) => (
                      <Fragment key={group.id}>
                        <tr className="border-t border-border bg-sidebar">
                          <td
                            colSpan={COLUMNS.length}
                            className="px-6 py-1.5 text-xs font-medium text-muted-foreground"
                          >
                            {group.name} · {group.rows.length}{" "}
                            {group.rows.length === 1 ? "job" : "jobs"}
                          </td>
                        </tr>
                        {group.rows.map((row) => renderRow(row, group.id))}
                      </Fragment>
                    ))
                  : visible.map((row) => renderRow(row, "all"))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs",
        active
          ? "border-foreground bg-foreground font-medium text-background"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
