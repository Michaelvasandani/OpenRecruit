import type { ReviewLeadPanelProjection, ReviewScoutRunCenterProjection } from "@shared/recruiting";
import { AlertTriangle, CheckCircle2, Loader2, PlayCircle, RefreshCw, WifiOff } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { deriveFitEvaluationDetails } from "../lib/review-fit";
import { deriveLeadPresentationLabels } from "../lib/review-labels";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { useConnectionStore } from "../stores/connection";
import { useUIStore } from "../stores/ui";

/**
 * Variant B's authoritative three-pane review surface. Each pane owns its
 * query and failure boundary, so a broken Source or selected Lead never blanks
 * unrelated operational state.
 */
export function ReviewWorkspaceScreen() {
  const connected = useConnectionStore((state) => state.backendConnected);
  const sidebar = trpc.recruiting.review.sidebar.useQuery();
  const selectedScoutId = useUIStore((state) => state.selectedScoutId);
  const setSelectedScoutId = useUIStore((state) => state.selectScout);
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
  const freshLeadId = center.data?.freshLeads[0]?.id;
  const leadId = selectedLeadId ?? freshLeadId;
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
    setSelectedLeadId(undefined);
  }, [scoutId]);

  useEffect(() => {
    if (leadId && center.data?.freshLeads.some((lead) => lead.id === leadId)) return;
    if (!selectedLeadId && freshLeadId) setSelectedLeadId(freshLeadId);
  }, [center.data?.freshLeads, freshLeadId, leadId, selectedLeadId]);

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

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Scout Runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Structured discovery activity and Candidate review context.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
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
          {launch.error ? (
            <p className="max-w-80 text-right text-xs text-destructive">{launch.error.message}</p>
          ) : null}
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem]">
        <RunCenterPane query={center} connected={connected} onSelectLead={setSelectedLeadId} />
        <LeadPanelPane
          query={leadPanel}
          connected={connected}
          onDecision={(kind) => {
            const lead = leadPanel.data?.lead;
            if (!lead) return;
            recordDecision.mutate({
              leadId: lead.id,
              kind,
              expectedRevision: lead.revision,
              detail: kind === "review_outcome" ? { outcome: "watch" } : undefined,
              idempotencyKey: `review-decision-${crypto.randomUUID()}`,
            });
          }}
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
  onSelectLead,
}: {
  query: QueryLike<ReviewScoutRunCenterProjection | null>;
  connected: boolean;
  onSelectLead: (id: string) => void;
}) {
  return (
    <section className="min-w-0 overflow-y-auto border-r border-border">
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

          <Card className="p-4">
            <h3 className="text-sm font-medium">Structured activity</h3>
            {query.data.activity.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">No activity recorded yet.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {query.data.activity.slice(0, 24).map((item) => (
                  <div key={item.id} className="flex items-start gap-2 text-xs">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                    <div className="min-w-0">
                      <p>{item.message}</p>
                      <p className="text-muted-foreground">
                        {new Date(item.at).toLocaleString()}
                        {item.outcome ? ` · ${item.outcome}` : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <ProjectionList
              title="Signals found"
              empty="This Run has no Signals yet."
              items={query.data.signals}
              renderItem={(signal) => (
                <div key={signal.id} className="rounded border border-border p-2 text-xs">
                  <p className="font-medium">{signal.evidence.title || "Untitled Signal"}</p>
                  <p className="mt-1 truncate text-muted-foreground">
                    {signal.canonicalUrl ?? signal.providerIdentity ?? "Safe provenance attached"}
                  </p>
                </div>
              )}
            />
            <ProjectionList
              title="Source Attempts"
              empty="No Source Attempts recorded."
              items={query.data.sourceAttempts}
              renderItem={(attempt) => (
                <div key={attempt.id} className="rounded border border-border p-2 text-xs">
                  <p className="font-medium">{attempt.outcome}</p>
                  <p className="mt-1 text-muted-foreground">
                    {attempt.itemCount} items · {attempt.pageCount} pages
                    {attempt.safeFailure ? ` · ${attempt.safeFailure}` : ""}
                  </p>
                </div>
              )}
            />
          </div>

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

          <div className="grid gap-4 sm:grid-cols-2">
            <ProjectionList
              title="Committed Checkpoints"
              empty="No checkpoints committed."
              items={query.data.checkpoints}
              renderItem={(checkpoint) => (
                <div key={checkpoint.id} className="text-xs">
                  <span className="font-medium">#{checkpoint.sequence}</span> {checkpoint.phase}
                  <span className="ml-1 text-muted-foreground">{checkpoint.checkpoint}</span>
                </div>
              )}
            />
            <ProjectionList
              title="Recent Run history"
              empty="No Run history yet."
              items={query.data.recentRuns}
              renderItem={(run) => (
                <div key={run.id} className="text-xs">
                  <span className="font-medium">{run.status}</span>
                  <span className="ml-1 text-muted-foreground">{run.trigger}</span>
                </div>
              )}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function LeadPanelPane({
  query,
  connected,
  onDecision,
  decisionPending,
}: {
  query: QueryLike<ReviewLeadPanelProjection | null>;
  connected: boolean;
  onDecision: (kind: "dismissal" | "reversal" | "review_outcome") => void;
  decisionPending: boolean;
}) {
  return (
    <aside className="min-w-0 overflow-y-auto bg-muted/20">
      <PanelStatus connected={connected} query={query} label="Lead panel" />
      <PanelFailure query={query} label="Lead panel" />
      {query.isLoading && !query.data && <PanelLoading label="Lead panel" />}
      {!query.isLoading && !query.error && !query.data && (
        <PanelEmpty label="No Lead selected" detail="Select a fresh Lead to inspect its context." />
      )}
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
