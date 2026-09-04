import type {
  ReviewLeadPanelProjection,
  ReviewScoutRunCenterProjection,
  ScoutSummary,
} from "@shared/recruiting";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
  WifiOff,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { deriveFitEvaluationDetails } from "../lib/review-fit";
import { deriveLeadPresentationLabels } from "../lib/review-labels";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { useConnectionStore } from "../stores/connection";
import { useUIStore } from "../stores/ui";

type RunCenterTab = "overview" | "signals" | "history";

/** Signal-first Run Center with independent query boundaries for the Run and Lead projections. */
export function ReviewWorkspaceScreen() {
  const connected = useConnectionStore((state) => state.backendConnected);
  const sidebar = trpc.recruiting.review.sidebar.useQuery();
  const selectedScoutId = useUIStore((state) => state.selectedScoutId);
  const setSelectedScoutId = useUIStore((state) => state.selectScout);
  const [tab, setTab] = useState<RunCenterTab>("signals");
  const [selectedSignalId, setSelectedSignalId] = useState<string>();
  const [selectedLeadId, setSelectedLeadId] = useState<string>();
  const selectedScout = useMemo(
    () => sidebar.data?.scouts.find((entry) => entry.scout.id === selectedScoutId),
    [sidebar.data?.scouts, selectedScoutId],
  );
  const scoutId = selectedScout?.scout.id ?? sidebar.data?.scouts[0]?.scout.id;
  const center = trpc.recruiting.review.scoutRunCenter.useQuery(
    { scoutId: scoutId ?? "" },
    { enabled: Boolean(scoutId) },
  );
  const latestSignals = useMemo(() => {
    const latestRunId = center.data?.latestRun?.id;
    if (!center.data || !latestRunId) return [];
    return center.data.signals.filter((signal) => signal.runId === latestRunId);
  }, [center.data]);
  const selectedSignal = useMemo(
    () =>
      center.data?.signals.find((signal) => signal.id === selectedSignalId) ??
      latestSignals[0] ??
      center.data?.signals[0],
    [center.data?.signals, latestSignals, selectedSignalId],
  );
  const selectedSignalLeadId = center.data?.freshLeads.find((lead) =>
    selectedSignal ? lead.signalIds.includes(selectedSignal.id) : false,
  )?.id;
  const leadId = selectedLeadId ?? selectedSignalLeadId;
  const leadPanel = trpc.recruiting.review.leadPanel.useQuery(
    { id: leadId ?? "" },
    { enabled: Boolean(leadId) },
  );
  const utils = trpc.useUtils();

  trpc.recruiting.onChanged.useSubscription(undefined, {
    onData: (event) => {
      // The envelope is deliberately compact; queries remain authoritative.
      // A resync is treated as a full projection refresh after every reconnect.
      if (event.reason === "resync" || event.kind) {
        void utils.recruiting.review.sidebar.invalidate();
        void utils.recruiting.review.scoutRunCenter.invalidate();
        void utils.recruiting.review.leadPanel.invalidate();
      }
    },
  });

  useEffect(() => {
    if (
      sidebar.data?.scouts[0] &&
      (!selectedScoutId || !sidebar.data.scouts.some((entry) => entry.scout.id === selectedScoutId))
    ) {
      setSelectedScoutId(sidebar.data.scouts[0].scout.id);
    }
  }, [selectedScoutId, setSelectedScoutId, sidebar.data?.scouts]);

  useEffect(() => {
    if (!scoutId) return;
    setSelectedSignalId(undefined);
    setSelectedLeadId(undefined);
  }, [scoutId]);

  const launch = trpc.recruiting.launchScoutRun.useMutation({
    onSuccess: () => {
      void utils.recruiting.review.sidebar.invalidate();
      void utils.recruiting.review.scoutRunCenter.invalidate();
    },
  });
  const recordDecision = trpc.recruiting.recordCandidateDecision.useMutation({
    onSuccess: () => {
      void leadPanel.refetch();
      void utils.recruiting.review.sidebar.invalidate();
      void utils.recruiting.review.scoutRunCenter.invalidate();
    },
    onError: () => void leadPanel.refetch(),
  });
  const onDecision = (kind: "dismissal" | "reversal" | "review_outcome") => {
    const lead = leadPanel.data?.lead;
    if (!lead) return;
    recordDecision.mutate({
      leadId: lead.id,
      kind,
      expectedRevision: lead.revision,
      detail: kind === "review_outcome" ? { outcome: "watch" } : undefined,
      idempotencyKey: `review-decision-${crypto.randomUUID()}`,
    });
  };
  const selectSignal = (signalId: string) => {
    setSelectedSignalId(signalId);
    const lead = center.data?.freshLeads.find((entry) => entry.signalIds.includes(signalId));
    setSelectedLeadId(lead?.id);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex min-h-20 shrink-0 items-stretch justify-between border-b border-border px-6">
        <div className="flex min-w-0 items-stretch gap-8">
          <div className="flex min-w-40 flex-col justify-center py-3">
            <h1 className="text-lg font-semibold">Scout Runs</h1>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {center.data?.scout.name ?? "Select a Scout"}
            </p>
          </div>
          <div className="flex items-stretch gap-5" role="tablist" aria-label="Scout Run views">
            {(["overview", "signals", "history"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "relative flex items-center border-b-2 border-transparent text-xs capitalize text-muted-foreground",
                  tab === value && "border-foreground font-medium text-foreground",
                )}
              >
                {value}
                {value === "signals" && latestSignals.length > 0 ? (
                  <span className="ml-1.5 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
                    {latestSignals.length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 py-3">
          {center.data?.sources.length ? (
            <span
              className={cn(
                "rounded-full px-2 py-1 text-[11px]",
                center.data.sources.every((source) => source.readiness === "ready")
                  ? "bg-success/10 text-success"
                  : "bg-warning/10 text-warning",
              )}
            >
              {center.data.sources.filter((source) => source.readiness === "ready").length}/
              {center.data.sources.length} Sources ready
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={!scoutId || launch.isPending || Boolean(center.data?.activeRun)}
            onClick={() =>
              scoutId &&
              launch.mutate({
                scoutId,
                idempotencyKey: `review-run-${crypto.randomUUID()}`,
              })
            }
          >
            {launch.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PlayCircle className="size-4" />
            )}
            {center.data?.activeRun ? "Run in progress" : "Run now"}
          </Button>
        </div>
      </header>
      {launch.error ? (
        <p className="border-b border-destructive/20 bg-destructive/5 px-6 py-2 text-right text-xs text-destructive">
          {launch.error.message}
        </p>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem]">
        <RunCenterPane
          query={center}
          connected={connected}
          tab={tab}
          selectedSignalId={selectedSignal?.id}
          onSelectSignal={selectSignal}
          onSelectLead={setSelectedLeadId}
        />
        <SignalDetailPane
          signal={selectedSignal}
          source={center.data?.sources.find((entry) => entry.id === selectedSignal?.sourceId)}
          query={leadPanel}
          connected={connected}
          onDecision={onDecision}
          decisionPending={recordDecision.isPending}
        />
      </div>
    </main>
  );
}

type QueryLike<T> = {
  data: T | undefined;
  error: { message: string } | null;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => unknown;
};

function PanelStatus<T>({
  connected,
  query,
  label,
}: {
  connected: boolean;
  query: QueryLike<T>;
  label: string;
}) {
  if (!connected && query.data) {
    return (
      <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        <WifiOff className="size-3.5" /> {label} is stale while reconnecting; showing the last
        authoritative snapshot.
      </div>
    );
  }
  if (query.isFetching && query.data) {
    return (
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <RefreshCw className="size-3.5 animate-spin" /> Refreshing {label}…
      </div>
    );
  }
  return null;
}

function PanelFailure<T>({ query, label }: { query: QueryLike<T>; label: string }) {
  if (!query.error || query.data) return null;
  return (
    <Card className="m-4 flex flex-col gap-3 border-destructive/40 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="size-4" /> {label} unavailable
      </div>
      <p className="text-xs text-muted-foreground">{query.error.message}</p>
      <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
        Retry {label}
      </Button>
    </Card>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Loading {label}…
    </div>
  );
}

function PanelEmpty({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="m-4 rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{label}</p>
      <p className="mt-1 text-xs">{detail}</p>
    </div>
  );
}

function RunCenterPane({
  query,
  connected,
  tab,
  selectedSignalId,
  onSelectSignal,
  onSelectLead,
}: {
  query: QueryLike<ReviewScoutRunCenterProjection | null>;
  connected: boolean;
  tab: RunCenterTab;
  selectedSignalId: string | undefined;
  onSelectSignal: (id: string) => void;
  onSelectLead: (id: string) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden border-r border-border">
      <PanelStatus connected={connected} query={query} label="Run Center" />
      <PanelFailure query={query} label="Run Center" />
      {query.isLoading && !query.data ? <PanelLoading label="Run Center" /> : null}
      {!query.isLoading && !query.error && !query.data ? (
        <PanelEmpty label="No Scout selected" detail="Create or select a Scout to inspect Runs." />
      ) : null}
      {query.data ? (
        <>
          <RunSnapshotBar data={query.data} />
          <RunStory data={query.data} />
          {tab === "signals" ? (
            <SignalWorkspace
              data={query.data}
              selectedSignalId={selectedSignalId}
              onSelectSignal={onSelectSignal}
            />
          ) : null}
          {tab === "overview" ? (
            <OverviewPane query={query} connected={connected} onSelectLead={onSelectLead} />
          ) : null}
          {tab === "history" ? <RunHistoryPane data={query.data} /> : null}
        </>
      ) : null}
    </section>
  );
}

type RunCenterData = ReviewScoutRunCenterProjection;
type RunSignal = RunCenterData["signals"][number];

function RunSnapshotBar({ data }: { data: RunCenterData }) {
  const latestRun = data.latestRun;
  const latestSignals = latestRun
    ? data.signals.filter((signal) => signal.runId === latestRun.id)
    : [];
  const latestCheckpoint = latestRun ? latestCheckpointFor(data, latestRun.id) : undefined;

  return (
    <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-success/[0.035] px-5 py-2 text-[11px] whitespace-nowrap">
      <span className="font-semibold uppercase tracking-wider text-muted-foreground">
        Latest Run
      </span>
      <span className="text-muted-foreground">›</span>
      <span
        className={cn(
          "rounded-full px-2 py-0.5 font-medium capitalize",
          data.activeRun
            ? "bg-warning/10 text-warning"
            : latestRun?.status === "completed"
              ? "bg-success/10 text-success"
              : "bg-muted text-muted-foreground",
        )}
      >
        {data.activeRun?.status ?? latestRun?.status ?? "No Runs"}
      </span>
      <span className="text-muted-foreground">›</span>
      <strong>{latestSignals.length} Signals found</strong>
      <span className="text-muted-foreground">›</span>
      <span>{data.freshLeads.length} fresh Leads</span>
      <span className="ml-auto text-muted-foreground">
        {latestCheckpoint
          ? `Checkpoint #${latestCheckpoint.sequence} saved · ${formatTime(latestCheckpoint.createdAt)}`
          : "No committed checkpoint"}
      </span>
      {latestCheckpoint ? (
        <details className="relative">
          <summary className="cursor-pointer font-medium text-primary">Details</summary>
          <div className="absolute right-0 z-20 mt-2 w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg whitespace-normal">
            <p className="font-medium">Committed checkpoint</p>
            <p className="mt-1 text-muted-foreground">
              {humanize(latestCheckpoint.phase)} · sequence #{latestCheckpoint.sequence}
            </p>
            <p className="mt-2 max-h-24 overflow-y-auto rounded bg-muted p-2 font-mono text-[10px] break-words">
              {latestCheckpoint.checkpoint}
            </p>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function RunStory({ data }: { data: RunCenterData }) {
  const [expanded, setExpanded] = useState(true);
  const run = data.activeRun ?? data.latestRun;
  const runId = run?.id;
  const attempts = runId ? data.sourceAttempts.filter((attempt) => attempt.runId === runId) : [];
  const signals = runId ? data.signals.filter((signal) => signal.runId === runId) : [];
  const runSignalIds = new Set(signals.map((signal) => signal.id));
  const freshLeadCount = data.freshLeads.filter((lead) =>
    lead.signalIds.some((signalId) => runSignalIds.has(signalId)),
  ).length;
  const checkpoint = runId ? latestCheckpointFor(data, runId) : undefined;
  const itemCount = attempts.reduce((total, attempt) => total + attempt.itemCount, 0);
  const duration = run?.startedAt
    ? formatDuration((run.completedAt ?? data.generatedAt) - run.startedAt)
    : null;
  const running = Boolean(data.activeRun);
  const steps = [
    {
      title: run?.profileVersionId ? "Profile confirmed" : "Run prepared",
      detail: `${run?.sourceIds.length ?? data.scout.sourceIds.length} Sources pinned`,
      pending: !run,
    },
    {
      title: `${itemCount} items collected`,
      detail: `${attempts.length} Source Attempt${attempts.length === 1 ? "" : "s"}`,
      pending: !run || (running && attempts.length === 0),
    },
    {
      title: `${signals.length} Signals recorded`,
      detail: `${freshLeadCount} fresh Lead${freshLeadCount === 1 ? "" : "s"}`,
      pending: !run || (running && signals.length === 0),
    },
    {
      title: data.activeRun
        ? humanize(data.activeRun.status)
        : run
          ? "Run saved"
          : "Waiting for a Run",
      detail: checkpoint
        ? `Committed checkpoint #${checkpoint.sequence}`
        : running
          ? "Checkpoint pending"
          : "No committed checkpoint",
      pending: !run || running,
    },
  ];

  return (
    <section className="shrink-0 border-b border-border bg-card px-5 py-3" aria-label="Run story">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs font-semibold">Run story</h2>
          <span className="text-[10px] text-muted-foreground">
            {run ? `${steps.length} steps${duration ? ` · ${duration}` : ""}` : "No Run yet"}
          </span>
        </div>
        <button
          type="button"
          className="text-[11px] font-medium text-primary hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide story" : "Show story"}
        </button>
      </div>
      {expanded ? (
        <div className="mt-3 grid grid-cols-4 gap-3">
          {steps.map((step, index) => (
            <div key={step.title} className="relative flex min-w-0 gap-2 pr-2">
              {index < steps.length - 1 ? (
                <span className="absolute top-2.5 left-5 h-px w-[calc(100%-1rem)] bg-border" />
              ) : null}
              <span className="relative z-10 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                {step.pending ? (
                  index === steps.length - 1 && running ? (
                    <Loader2 className="size-3 animate-spin text-warning" />
                  ) : (
                    <Circle className="size-2.5 text-muted-foreground" />
                  )
                ) : (
                  <CheckCircle2 className="size-3.5 text-success" />
                )}
              </span>
              <div className="relative z-10 min-w-0 bg-card pr-2">
                <p className="truncate text-[11px] font-medium">{step.title}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{step.detail}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SignalWorkspace({
  data,
  selectedSignalId,
  onSelectSignal,
}: {
  data: RunCenterData;
  selectedSignalId: string | undefined;
  onSelectSignal: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"latest" | "all">("latest");
  const [sourceId, setSourceId] = useState("all");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const signals = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const latestRunId = data.latestRun?.id;
    return data.signals
      .filter((signal) => scope === "all" || signal.runId === latestRunId)
      .filter((signal) => sourceId === "all" || signal.sourceId === sourceId)
      .filter(
        (signal) =>
          !normalizedSearch ||
          `${signal.evidence.title} ${signal.evidence.content}`
            .toLocaleLowerCase()
            .includes(normalizedSearch),
      )
      .toSorted((left, right) =>
        sort === "newest" ? right.observedAt - left.observedAt : left.observedAt - right.observedAt,
      );
  }, [data.latestRun?.id, data.signals, scope, search, sort, sourceId]);
  const sourceById = useMemo(
    () => new Map(data.sources.map((source) => [source.id, source])),
    [data.sources],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-3">
        <label className="flex h-8 min-w-52 flex-1 items-center gap-2 rounded-md border border-input bg-muted/30 px-2.5 focus-within:bg-background focus-within:ring-1 focus-within:ring-ring">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label="Search signals"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search signals…"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </label>
        <SignalFilter value={scope} onChange={(value) => setScope(value as "latest" | "all")}>
          <option value="latest">Latest Run</option>
          <option value="all">All Runs</option>
        </SignalFilter>
        <SignalFilter value={sourceId} onChange={setSourceId}>
          <option value="all">All Sources</option>
          {data.sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </SignalFilter>
        <SignalFilter value={sort} onChange={(value) => setSort(value as "newest" | "oldest")}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </SignalFilter>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        {signals.length === 0 ? (
          <PanelEmpty
            label="No Signals found"
            detail={search ? "Try a different search or filter." : "This Run has no Signals yet."}
          />
        ) : (
          <table className="w-full table-fixed border-collapse text-left text-xs">
            <colgroup>
              <col />
              <col className="w-36" />
              <col className="w-24" />
              <col className="w-28" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-muted/70 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
              <tr>
                <th className="border-b border-border px-4 py-2 font-medium">Signal</th>
                <th className="border-b border-border px-3 py-2 font-medium">Source</th>
                <th className="border-b border-border px-3 py-2 font-medium">Freshness</th>
                <th className="border-b border-border px-3 py-2 font-medium">Found</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => {
                const source = sourceById.get(signal.sourceId);
                const selected = selectedSignalId === signal.id;
                return (
                  <tr
                    key={signal.id}
                    className={cn(
                      "cursor-pointer border-b border-border hover:bg-muted/35",
                      selected && "bg-success/[0.055] shadow-[inset_3px_0_0_var(--color-success)]",
                    )}
                    tabIndex={0}
                    aria-selected={selected}
                    onClick={() => onSelectSignal(signal.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") onSelectSignal(signal.id);
                    }}
                  >
                    <td className="px-4 py-3">
                      <p className="truncate font-medium">
                        <span className="mr-2 inline-block size-1.5 rounded-full bg-success" />
                        {signal.evidence.title || "Untitled Signal"}
                      </p>
                      <p className="mt-1 truncate pl-3.5 text-[10px] text-muted-foreground">
                        {signal.evidence.content ||
                          signal.providerIdentity ||
                          "Safe provenance attached"}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <p className="truncate font-medium">
                        {source?.name ?? humanize(signal.provider ?? "Source")}
                      </p>
                      <p className="mt-1 truncate text-[10px] text-muted-foreground">
                        {signal.provider ? humanize(signal.provider) : "Public"}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={cn(
                          "rounded-full px-2 py-1 text-[10px] capitalize",
                          signal.freshness === "fresh"
                            ? "bg-success/10 text-success"
                            : "bg-warning/10 text-warning",
                        )}
                      >
                        {signal.freshness}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-[10px] text-muted-foreground">
                      {formatDate(signal.observedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SignalFilter({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 max-w-40 rounded-md border border-input bg-background px-2 text-[11px]"
    >
      {children}
    </select>
  );
}

function RunHistoryPane({ data }: { data: RunCenterData }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/15 p-5">
      <div className="grid gap-4 xl:grid-cols-2">
        <ProjectionList
          title="Recent Run history"
          empty="No Run history yet."
          items={data.recentRuns}
          renderItem={(run) => (
            <div
              key={run.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-xs"
            >
              <div>
                <p className="font-medium capitalize">{run.status}</p>
                <p className="mt-1 text-muted-foreground">
                  {humanize(run.trigger)} · {run.signalIds.length} Signals · {run.sourceIds.length}{" "}
                  Sources
                </p>
              </div>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatDate(run.completedAt ?? run.createdAt)}
              </span>
            </div>
          )}
        />
        <ProjectionList
          title="Structured activity"
          empty="No activity recorded yet."
          items={data.activity.slice(0, 24)}
          renderItem={(item) => (
            <div key={item.id} className="flex items-start gap-2 text-xs">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
              <div className="min-w-0">
                <p>{item.message}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {formatDate(item.at)}
                  {item.outcome ? ` · ${humanize(item.outcome)}` : ""}
                </p>
              </div>
            </div>
          )}
        />
        <div className="xl:col-span-2">
          <Card className="p-4">
            <h3 className="text-sm font-medium">Committed checkpoints</h3>
            {data.checkpoints.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">No checkpoints committed.</p>
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {data.checkpoints.map((checkpoint) => (
                  <details
                    key={checkpoint.id}
                    className="rounded-md border border-border p-3 text-xs"
                  >
                    <summary className="cursor-pointer font-medium">
                      #{checkpoint.sequence} · {humanize(checkpoint.phase)}
                      <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                        {formatDate(checkpoint.createdAt)}
                      </span>
                    </summary>
                    <p className="mt-2 max-h-28 overflow-y-auto rounded bg-muted p-2 font-mono text-[10px] break-words">
                      {checkpoint.checkpoint}
                    </p>
                  </details>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function latestCheckpointFor(data: RunCenterData, runId: string) {
  return data.checkpoints.reduce<RunCenterData["checkpoints"][number] | undefined>(
    (latest, checkpoint) =>
      checkpoint.runId === runId && (!latest || checkpoint.sequence > latest.sequence)
        ? checkpoint
        : latest,
    undefined,
  );
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function formatDate(value: number) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function OverviewPane({
  query,
  connected,
  onSelectLead,
}: {
  query: QueryLike<ReviewScoutRunCenterProjection | null>;
  connected: boolean;
  onSelectLead: (id: string) => void;
}) {
  return (
    <section className="min-w-0 overflow-y-auto">
      <PanelStatus connected={connected} query={query} label="Run Center" />
      <PanelFailure query={query} label="Run Center" />
      {query.isLoading && !query.data && <PanelLoading label="Run Center" />}
      {!query.isLoading && !query.error && !query.data && (
        <PanelEmpty label="No Scout selected" detail="Create or select a Scout to inspect Runs." />
      )}
      {query.data && (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Scout</p>
              <h2 className="mt-1 text-base font-semibold">{query.data.scout.name}</h2>
            </div>
            <span className="rounded-full bg-muted px-2 py-1 text-xs">
              {query.data.activeRun?.status ?? "idle"}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Last Run" value={query.data.latestRun?.status ?? "No Runs"} />
            <Metric
              label="Next Run"
              value={
                query.data.nextRunAt ? new Date(query.data.nextRunAt).toLocaleString() : "Manual"
              }
            />
            <Metric label="Due Revisits" value={String(query.data.dueRevisitCount)} />
          </div>

          <SourceConfigurationCard scout={query.data.scout} />

          <Card className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Source readiness</h3>
              <span className="text-xs text-muted-foreground">safe metadata only</span>
            </div>
            {query.data.sources.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">No explicit Sources selected.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {query.data.sources.map((source) => (
                  <div key={source.id} className="flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{source.name}</p>
                      <p className="truncate text-muted-foreground">
                        {source.safeReason ?? source.nextAction ?? "No additional action"}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0",
                        source.readiness === "ready" ? "text-emerald-600" : "text-warning",
                      )}
                    >
                      {source.readiness}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Fresh Leads</h3>
              <span className="text-xs text-muted-foreground">derived from recent Signals</span>
            </div>
            {query.data.freshLeads.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                No fresh Leads from this Scout yet.
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {query.data.freshLeads.map((lead) => (
                  <button
                    type="button"
                    key={lead.id}
                    onClick={() => onSelectLead(lead.id)}
                    className={cn(
                      "rounded border border-border p-3 text-left text-xs hover:bg-muted",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    <span className="font-medium">{lead.title || "Untitled Lead"}</span>
                    <span className="mt-1 block text-muted-foreground">
                      {lead.scoutIds.length} Scout{lead.scoutIds.length === 1 ? "" : "s"} ·{" "}
                      {lead.signalIds.length} Signal{lead.signalIds.length === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </section>
  );
}

function SourceConfigurationCard({ scout }: { scout: ScoutSummary }) {
  const utils = trpc.useUtils();
  const sources = trpc.recruiting.sources.useQuery();
  const [xSourceName, setXSourceName] = useState("X — Bird");
  const [selectedSourceIds, setSelectedSourceIds] = useState(scout.sourceIds);

  useEffect(() => {
    setSelectedSourceIds(scout.sourceIds);
  }, [scout.sourceIds]);

  const refreshSources = () => {
    void utils.recruiting.sources.invalidate();
    void utils.recruiting.review.sidebar.invalidate();
    void utils.recruiting.review.scoutRunCenter.invalidate();
  };
  const createX = trpc.recruiting.createXSource.useMutation({
    onSuccess: refreshSources,
  });
  const checkReadiness = trpc.recruiting.checkSourceReadiness.useMutation({
    onSuccess: refreshSources,
  });
  const saveSources = trpc.recruiting.setScoutSources.useMutation({
    onSuccess: refreshSources,
  });
  const birdSourceExists = Boolean(
    sources.data?.some((source) => source.kind === "x" && source.provider === "bird"),
  );

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Explicit Sources</h3>
        <span className="text-xs text-muted-foreground">read-only access</span>
      </div>
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-xs text-muted-foreground">
          Add a consented Bird provider for public X discovery, then select it for this Scout.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={xSourceName}
            onChange={(event) => setXSourceName(event.target.value)}
            placeholder="X Source name"
            className="h-8 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={createX.isPending || !xSourceName.trim() || birdSourceExists}
            onClick={() =>
              createX.mutate({
                name: xSourceName,
                provider: "bird",
                idempotencyKey: `bird-x-source-${crypto.randomUUID()}`,
              })
            }
          >
            {createX.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
            Add Bird X Source
          </Button>
        </div>
        {birdSourceExists ? (
          <p className="text-xs text-muted-foreground">
            A Bird-backed X Source already exists. Select it below and save this Scout.
          </p>
        ) : null}
        {createX.error ? <p className="text-xs text-destructive">{createX.error.message}</p> : null}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {sources.isLoading ? <PanelLoading label="Sources" /> : null}
        {sources.data?.map((source) => (
          <div
            key={source.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-xs"
          >
            <label className="flex min-w-0 items-center gap-2">
              <input
                type="checkbox"
                checked={selectedSourceIds.includes(source.id)}
                onChange={(event) =>
                  setSelectedSourceIds((current) =>
                    event.target.checked
                      ? [...new Set([...current, source.id])]
                      : current.filter((id) => id !== source.id),
                  )
                }
              />
              <span className="truncate font-medium">{source.name}</span>
              <span className="text-muted-foreground">({source.readiness})</span>
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={checkReadiness.isPending}
              onClick={() => checkReadiness.mutate({ sourceId: source.id })}
            >
              Check Source
            </Button>
          </div>
        ))}
        {sources.error ? <p className="text-xs text-destructive">{sources.error.message}</p> : null}
        {checkReadiness.error ? (
          <p className="text-xs text-destructive">{checkReadiness.error.message}</p>
        ) : null}
        {saveSources.error ? (
          <p className="text-xs text-destructive">{saveSources.error.message}</p>
        ) : null}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={saveSources.isPending}
            onClick={() =>
              saveSources.mutate({
                scoutId: scout.id,
                expectedRevision: scout.revision,
                sourceIds: selectedSourceIds,
                idempotencyKey: `scout-sources-${crypto.randomUUID()}`,
              })
            }
          >
            {saveSources.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
            Save Sources
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SignalDetailPane({
  signal,
  source,
  query,
  connected,
  onDecision,
  decisionPending,
}: {
  signal: RunSignal | undefined;
  source: RunCenterData["sources"][number] | undefined;
  query: QueryLike<ReviewLeadPanelProjection | null>;
  connected: boolean;
  onDecision: (kind: "dismissal" | "reversal" | "review_outcome") => void;
  decisionPending: boolean;
}) {
  return (
    <aside className="min-w-0 overflow-y-auto bg-muted/20">
      {signal ? (
        <div className="border-b border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Signal detail
            </p>
            <span
              className={cn(
                "rounded-full px-2 py-1 text-[10px] capitalize",
                signal.freshness === "fresh"
                  ? "bg-success/10 text-success"
                  : "bg-warning/10 text-warning",
              )}
            >
              {signal.freshness}
            </span>
          </div>
          <h2 className="mt-3 text-base font-semibold leading-snug">
            {signal.evidence.title || "Untitled Signal"}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-1 font-medium text-foreground">
              {source?.name.slice(0, 1).toUpperCase() ?? "S"}
            </span>
            <span className="font-medium text-foreground">{source?.name ?? "Public Source"}</span>
            <span>·</span>
            <span>{formatDate(signal.observedAt)}</span>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {signal.evidence.content || "No evidence excerpt is retained for this Signal."}
          </p>
          {signal.canonicalUrl ? (
            <a
              href={signal.canonicalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Open source <ExternalLink className="size-3" />
            </a>
          ) : null}
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 text-[10px]">
            <div>
              <p className="uppercase tracking-wider text-muted-foreground">Provider</p>
              <p className="mt-1 font-medium">{humanize(signal.provider ?? "Public")}</p>
            </div>
            <div>
              <p className="uppercase tracking-wider text-muted-foreground">Run</p>
              <p className="mt-1 truncate font-medium" title={signal.runId}>
                {signal.runId}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <PanelEmpty label="No Signal selected" detail="Select a Signal to inspect its evidence." />
      )}
      <PanelStatus connected={connected} query={query} label="Lead panel" />
      <PanelFailure query={query} label="Lead panel" />
      {query.isLoading && !query.data && <PanelLoading label="Lead panel" />}
      {!query.isLoading && !query.error && !query.data && signal ? (
        <p className="border-b border-border px-4 py-3 text-xs text-muted-foreground">
          No fresh Lead is linked to this Signal yet.
        </p>
      ) : null}
      {query.data && (
        <div className="flex flex-col gap-4 p-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Lead context</p>
            <h2 className="mt-1 text-base font-semibold">
              {query.data.lead.title || "Untitled Lead"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {query.data.lead.canonicalUrl ?? query.data.lead.canonicalKey}
            </p>
            <div className="mt-3 flex flex-wrap gap-1">
              {deriveLeadPresentationLabels(query.data).map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-primary/10 px-2 py-1 text-[11px] text-primary"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          <Card className="p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Candidate decision
            </h3>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={decisionPending}
                onClick={() => onDecision("review_outcome")}
              >
                Watch
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={decisionPending}
                onClick={() => onDecision("dismissal")}
              >
                Dismiss
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={decisionPending || !query.data.decisionState.resurfacingSuppressed}
                onClick={() => onDecision("reversal")}
              >
                Reverse
              </Button>
            </div>
          </Card>

          <PanelSection title="Opportunities">
            {query.data.opportunities.length === 0 ? (
              <EmptyLine text="No Opportunity linked; the Lead remains intact." />
            ) : (
              query.data.opportunities.map((opportunity) => (
                <div key={opportunity.id} className="rounded border border-border p-2 text-xs">
                  <p className="font-medium">{opportunity.title}</p>
                  <p className="mt-1 text-muted-foreground">{opportunity.state}</p>
                </div>
              ))
            )}
          </PanelSection>
          <PanelSection title="Scout attribution">
            {query.data.attributions.map((attribution) => (
              <div key={attribution.scoutId} className="flex justify-between text-xs">
                <span>{attribution.scoutName}</span>
                <span className="text-muted-foreground">{attribution.signalCount} Signals</span>
              </div>
            ))}
          </PanelSection>
          <PanelSection title="Signals and evidence">
            {query.data.signals.length === 0 ? (
              <EmptyLine text="No evidence remains in scope." />
            ) : (
              query.data.signals.map((signal) => (
                <div key={signal.id} className="rounded border border-border p-2 text-xs">
                  <p className="font-medium">{signal.evidence.title || "Untitled Signal"}</p>
                  <a
                    className="mt-1 block truncate text-primary underline-offset-2 hover:underline"
                    href={signal.canonicalUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {signal.canonicalUrl ?? signal.providerIdentity ?? "Safe provenance attached"}
                  </a>
                </div>
              ))
            )}
          </PanelSection>
          <PanelSection title="Investigations">
            {query.data.investigations.length === 0 ? (
              <EmptyLine text="No shared Investigation for this Lead." />
            ) : (
              query.data.investigations.map((investigation) => (
                <div key={investigation.id} className="text-xs">
                  <span className="font-medium">{investigation.questionKey}</span>
                  <span className="ml-1 text-muted-foreground">
                    · {investigation.latestAttempt?.outcome ?? "no Attempt"}
                  </span>
                </div>
              ))
            )}
          </PanelSection>
          <PanelSection title="Fit Evaluations">
            {query.data.fitEvaluations.length === 0 ? (
              <EmptyLine text="No Fit Evaluation yet." />
            ) : (
              query.data.fitEvaluations.map((evaluation) => (
                <FitEvaluationCard key={evaluation.id} evaluation={evaluation} />
              ))
            )}
          </PanelSection>
          <PanelSection title="Revisit Plan">
            {query.data.revisitPlans.length === 0 ? (
              <EmptyLine text="No Revisit Plan; explicit Candidate requests remain available." />
            ) : (
              query.data.revisitPlans.map((plan) => (
                <div key={plan.id} className="text-xs">
                  <span className="font-medium">{plan.state}</span>
                  <span className="ml-1 text-muted-foreground">
                    · {plan.cadence ?? "manual only"}
                    {plan.dueAt ? ` · due ${new Date(plan.dueAt).toLocaleString()}` : ""}
                  </span>
                </div>
              ))
            )}
          </PanelSection>
          <PanelSection title="Source readiness">
            {query.data.sourceReadiness.length === 0 ? (
              <EmptyLine text="No related Source readiness." />
            ) : (
              query.data.sourceReadiness.map((source) => (
                <div key={source.id} className="flex items-start justify-between gap-2 text-xs">
                  <span>{source.name}</span>
                  <span
                    className={cn(
                      source.readiness === "ready" ? "text-emerald-600" : "text-warning",
                    )}
                  >
                    {source.readiness}
                  </span>
                </div>
              ))
            )}
          </PanelSection>
          <PanelSection title="Decision history">
            {query.data.candidateDecisions.length === 0 ? (
              <EmptyLine text="No Candidate Decisions recorded." />
            ) : (
              query.data.candidateDecisions.map((decision) => (
                <div key={decision.id} className="text-xs">
                  <span className="font-medium">{decision.kind}</span>
                  <span className="ml-1 text-muted-foreground">
                    · {new Date(decision.createdAt).toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </PanelSection>
        </div>
      )}
    </aside>
  );
}

function FitEvaluationCard({
  evaluation,
}: {
  evaluation: ReviewLeadPanelProjection["fitEvaluations"][number];
}) {
  const details = deriveFitEvaluationDetails(evaluation);
  return (
    <Card className="flex flex-col gap-3 p-3 text-xs">
      <div>
        <p className="font-medium">
          {details.label} Fit Evaluation · {details.freshness}
        </p>
        <p className="mt-1 text-muted-foreground">
          Profile Version {evaluation.profileVersionId} · Scout Run {evaluation.runId}
        </p>
        {details.staleReason && (
          <p className="mt-1 text-warning">Historical because {details.staleReason}.</p>
        )}
      </div>
      <FitConclusionGroup title="Hard Constraints" conclusions={details.hardConstraints} />
      <FitConclusionGroup title="Preferences" conclusions={details.preferences} />
      <div>
        <p className="font-medium">Evaluation-to-evidence relationships</p>
        {details.evidence.length === 0 ? (
          <p className="mt-1 text-muted-foreground">No Signal citations recorded.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {details.evidence.map(({ citation, referencedBy }) => (
              <div
                key={`${evaluation.id}-${citation.signalId}-${citation.claim}`}
                className="rounded border p-2"
              >
                <p className="font-medium">
                  Signal {citation.signalId} · {citation.kind} · {citation.freshness}
                </p>
                <p className="mt-1">{citation.claim}</p>
                <p className="mt-1 text-muted-foreground">
                  Referenced by: {referencedBy.length > 0 ? referencedBy.join(", ") : "none"}
                </p>
                <FitCitationAttribution citation={citation} />
              </div>
            ))}
          </div>
        )}
      </div>
      {(details.conflicts.length > 0 || details.unknowns.length > 0) && (
        <div>
          <p className="font-medium">Conflicts and unknowns</p>
          {details.conflicts.length > 0 && (
            <p className="mt-1 text-warning">Conflicts: {details.conflicts.join(" · ")}</p>
          )}
          {details.unknowns.length > 0 && (
            <p className="mt-1 text-muted-foreground">Unknowns: {details.unknowns.join(" · ")}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function FitConclusionGroup({
  title,
  conclusions,
}: {
  title: string;
  conclusions: ReturnType<typeof deriveFitEvaluationDetails>["hardConstraints"];
}) {
  return (
    <div>
      <p className="font-medium">{title}</p>
      {conclusions.length === 0 ? (
        <p className="mt-1 text-muted-foreground">No {title.toLowerCase()} recorded.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {conclusions.map((conclusion) => (
            <div key={`${conclusion.category}-${conclusion.key}`} className="rounded border p-2">
              <p className="font-medium">
                {conclusion.key} · {conclusion.result}
              </p>
              <p className="mt-1">{conclusion.explanation}</p>
              <p className="mt-1 text-muted-foreground">
                {conclusion.inferred ? "Inferred" : "Factual"} · evidence{" "}
                {conclusion.evidenceFreshness}
              </p>
              <p className="mt-1 text-muted-foreground">
                Signals:{" "}
                {conclusion.signalIds.length > 0 ? conclusion.signalIds.join(", ") : "none"}
              </p>
              {conclusion.citations.length > 0 ? (
                <div className="mt-2 flex flex-col gap-2 border-l border-border pl-2">
                  {conclusion.citations.map((citation) => (
                    <div key={`${conclusion.key}-${citation.signalId}-${citation.claim}`}>
                      <p>
                        Citation: {citation.claim} · {citation.kind} · {citation.freshness}
                      </p>
                      <FitCitationAttribution citation={citation} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-muted-foreground">No citation detail recorded.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FitCitationAttribution({
  citation,
}: {
  citation: ReturnType<typeof deriveFitEvaluationDetails>["evidence"][number]["citation"];
}) {
  return citation.attribution ? (
    <p className="mt-1 text-muted-foreground">
      Attribution: Source {citation.attribution.sourceId} · Scout Run {citation.attribution.runId} ·
      Scout {citation.attribution.scoutId}
    </p>
  ) : (
    <p className="mt-1 text-warning">Attribution unavailable.</p>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-3">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium">{value}</p>
    </Card>
  );
}

function ProjectionList<T>({
  title,
  empty,
  items,
  renderItem,
}: {
  title: string;
  empty: string;
  items: T[];
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        renderItem(items[0])
      )}
      {items.length > 1 && (
        <div className="flex flex-col gap-2">{items.slice(1).map(renderItem)}</div>
      )}
    </Card>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border pb-3 last:border-0">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground">{text}</p>;
}
