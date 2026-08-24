import { Loader2, PlayCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";

/**
 * Safe Run center projection. It deliberately renders snapshots and structured
 * outcomes only; provider transcripts and credentials never cross tRPC.
 */
export function ScoutRunsScreen() {
  const utils = trpc.useUtils();
  const scouts = trpc.recruiting.scouts.useQuery();
  const sources = trpc.recruiting.sources.useQuery();
  const sourceAttempts = trpc.recruiting.sourceAttempts.useQuery();
  const signals = trpc.recruiting.signals.useQuery();
  const leads = trpc.recruiting.leads.useQuery();
  const [selectedLeadId, setSelectedLeadId] = useState<string | undefined>();
  const leadContext = trpc.recruiting.leadContext.useQuery(
    { id: selectedLeadId ?? "" },
    { enabled: Boolean(selectedLeadId) },
  );
  const profiles = trpc.recruiting.profiles.useQuery();
  const [selectedScoutId, setSelectedScoutId] = useState<string | undefined>();
  const [strategyMaterial, setStrategyMaterial] = useState("");
  const [policyMaterial, setPolicyMaterial] = useState("");
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const [profileOverrideId, setProfileOverrideId] = useState<string | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [feedName, setFeedName] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const selectedId = selectedScoutId ?? scouts.data?.[0]?.id;
  const runs = trpc.recruiting.scoutRuns.useQuery(
    selectedId ? { scoutId: selectedId } : undefined,
    {
      enabled: Boolean(selectedId),
    },
  );
  trpc.recruiting.onChanged.useSubscription(undefined, {
    onData: (event) => {
      if (
        event.reason === "resync" ||
        event.kind === "run" ||
        event.kind === "scout" ||
        event.kind === "source" ||
        event.kind === "lead"
      ) {
        void utils.recruiting.scoutRuns.invalidate();
        void utils.recruiting.scouts.invalidate();
        void utils.recruiting.sources.invalidate();
        void utils.recruiting.signals.invalidate();
        void utils.recruiting.leads.invalidate();
        void utils.recruiting.leadContext.invalidate();
      }
    },
  });
  const launch = trpc.recruiting.launchScoutRun.useMutation({
    onSuccess: () => {
      void utils.recruiting.scoutRuns.invalidate();
      void utils.recruiting.scouts.invalidate();
    },
  });
  const selected = scouts.data?.find((scout) => scout.id === selectedId);
  const update = trpc.recruiting.updateScout.useMutation({
    onSuccess: () => {
      void utils.recruiting.scouts.invalidate();
    },
  });
  const createRss = trpc.recruiting.createRssSource.useMutation({
    onSuccess: () => {
      setFeedName("");
      setFeedUrl("");
      void utils.recruiting.sources.invalidate();
    },
  });
  const checkReadiness = trpc.recruiting.checkSourceReadiness.useMutation({
    onSuccess: () => void utils.recruiting.sources.invalidate(),
  });
  useEffect(() => {
    if (!selected) return;
    setStrategyMaterial(selected.strategyMaterial);
    setPolicyMaterial(selected.policyMaterial);
    setDefaultProfileId(selected.defaultProfileId);
    setProfileOverrideId(null);
    setSourceIds(selected.sourceIds);
  }, [selected]);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Scout Run Center</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Launch bounded, Profile-pinned discovery Runs and inspect safe structured history.
            </p>
          </div>
          <RefreshCw
            className={cn("size-4 text-muted-foreground", runs.isFetching && "animate-spin")}
          />
        </div>
        <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
          <Card className="flex flex-col gap-2 p-3">
            <span className="px-2 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Scouts
            </span>
            {scouts.isLoading && <Loader2 className="mx-auto my-4 size-4 animate-spin" />}
            {scouts.data?.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">No Scouts yet.</p>
            )}
            {scouts.data?.map((scout) => (
              <button
                type="button"
                key={scout.id}
                onClick={() => setSelectedScoutId(scout.id)}
                className={cn(
                  "rounded-md px-2 py-2 text-left hover:bg-muted",
                  selected?.id === scout.id && "bg-muted",
                )}
              >
                <span className="block truncate text-sm font-medium">{scout.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {scout.sourceIds.length} Source{scout.sourceIds.length === 1 ? "" : "s"} ·{" "}
                  {scout.harness}
                </span>
              </button>
            ))}
          </Card>
          <div className="flex flex-col gap-5">
            {selected ? (
              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium">{selected.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selected.defaultProfileId
                        ? "Default Profile selected"
                        : "Default Profile required"}{" "}
                      · {selected.sourceIds.length} explicit Sources
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      launch.isPending ||
                      !selected.defaultProfileId ||
                      selected.sourceIds.length === 0
                    }
                    onClick={() =>
                      launch.mutate({
                        scoutId: selected.id,
                        profileOverrideId,
                        idempotencyKey: `manual-run-${crypto.randomUUID()}`,
                      })
                    }
                  >
                    {launch.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <PlayCircle className="size-4" />
                    )}
                    Launch manual Run
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label>Discovery Strategy</Label>
                    <Textarea
                      value={strategyMaterial}
                      onChange={(event) => setStrategyMaterial(event.target.value)}
                      rows={4}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>Scout Policy</Label>
                    <Textarea
                      value={policyMaterial}
                      onChange={(event) => setPolicyMaterial(event.target.value)}
                      rows={4}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="default-profile">Default confirmed Candidate Profile</Label>
                    <select
                      id="default-profile"
                      value={defaultProfileId ?? ""}
                      onChange={(event) => setDefaultProfileId(event.target.value || null)}
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Select a confirmed Profile</option>
                      {profiles.data
                        ?.filter((profile) => profile.state === "confirmed")
                        .map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name} · {profile.roleTarget}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="profile-override">One-run Profile Override (optional)</Label>
                    <select
                      id="profile-override"
                      value={profileOverrideId ?? ""}
                      onChange={(event) => setProfileOverrideId(event.target.value || null)}
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Use Scout default</option>
                      {profiles.data
                        ?.filter((profile) => profile.state === "confirmed")
                        .map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name} · {profile.roleTarget}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>Explicit Sources</Label>
                    <div className="flex flex-col gap-2 rounded-md border border-border p-2">
                      <span className="text-[11px] text-muted-foreground">
                        Add a public RSS or Atom feed
                      </span>
                      <input
                        value={feedName}
                        onChange={(event) => setFeedName(event.target.value)}
                        placeholder="Source name"
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                      />
                      <input
                        value={feedUrl}
                        onChange={(event) => setFeedUrl(event.target.value)}
                        placeholder="https://example.com/feed.xml"
                        type="url"
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={createRss.isPending || !feedName.trim() || !feedUrl.trim()}
                        onClick={() =>
                          createRss.mutate({
                            name: feedName,
                            url: feedUrl,
                            idempotencyKey: `rss-source-${crypto.randomUUID()}`,
                          })
                        }
                      >
                        {createRss.isPending ? <Loader2 className="size-3" /> : null}
                        Add RSS/Atom Source
                      </Button>
                      {createRss.error && (
                        <p className="text-[11px] text-destructive">{createRss.error.message}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {sources.data?.map((source) => (
                        <div key={source.id} className="flex items-center gap-1 text-xs">
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={sourceIds.includes(source.id)}
                              onChange={(event) =>
                                setSourceIds((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, source.id])]
                                    : current.filter((id) => id !== source.id),
                                )
                              }
                            />
                            {source.name}
                          </label>
                          <span className="text-muted-foreground">({source.readiness})</span>
                          <button
                            type="button"
                            className="text-primary underline-offset-2 hover:underline"
                            disabled={checkReadiness.isPending}
                            onClick={() => checkReadiness.mutate({ sourceId: source.id })}
                          >
                            Check
                          </button>
                        </div>
                      ))}
                    </div>
                    {sources.data?.map(
                      (source) =>
                        source.access && (
                          <p
                            key={`${source.id}-access`}
                            className="text-[11px] text-muted-foreground"
                          >
                            {source.name}: {source.access.nextAction ?? "No next action"}
                            {source.access.lastSuccessfulCheckAt
                              ? ` · last success ${new Date(source.access.lastSuccessfulCheckAt).toLocaleString()}`
                              : " · no successful check yet"}
                            {source.access.retryAt
                              ? ` · retry after ${new Date(source.access.retryAt).toLocaleString()}`
                              : ""}
                            {source.access.safeFailure ? ` · ${source.access.safeFailure}` : ""}
                          </p>
                        ),
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={update.isPending}
                    onClick={() =>
                      update.mutate({
                        scoutId: selected.id,
                        expectedRevision: selected.revision,
                        strategyMaterial,
                        policyMaterial,
                        defaultProfileId,
                        sourceIds,
                        idempotencyKey: `scout-update-${crypto.randomUUID()}`,
                      })
                    }
                  >
                    {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save Scout configuration
                  </Button>
                  {update.error && (
                    <p className="text-xs text-destructive">{update.error.message}</p>
                  )}
                </div>
                {launch.error && <p className="text-xs text-destructive">{launch.error.message}</p>}
                <div className="text-xs text-muted-foreground">
                  Selected Sources:{" "}
                  {selected.sourceIds
                    .map((id) => sources.data?.find((source) => source.id === id)?.name ?? id)
                    .join(", ") || "none"}
                </div>
              </Card>
            ) : (
              <Card className="p-5 text-sm text-muted-foreground">
                Select a Scout to inspect Runs.
              </Card>
            )}
            <Card className="flex flex-col gap-3 p-5">
              <h2 className="text-sm font-medium">Run history</h2>
              {runs.isLoading && <Loader2 className="size-4 animate-spin" />}
              {runs.data?.length === 0 && (
                <p className="text-sm text-muted-foreground">No Runs yet.</p>
              )}
              {runs.data?.map((run) => (
                <div key={run.id} className="rounded-md border border-border p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {run.status} · {run.trigger}
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    Profile Version: {run.profileVersionId ?? "not pinned"} · Sources:{" "}
                    {run.sourceIds.length} · Phase: {run.phase}
                  </p>
                  {sourceAttempts.data
                    ?.filter((attempt) => attempt.runId === run.id)
                    .map((attempt) => (
                      <p key={attempt.id} className="mt-1 text-muted-foreground">
                        {attempt.sourceId}: {attempt.outcome} · {attempt.itemCount} items ·{" "}
                        {attempt.pageCount} page{attempt.pageCount === 1 ? "" : "s"}
                        {attempt.safeFailure ? ` · ${attempt.safeFailure}` : ""}
                      </p>
                    ))}
                  <p className="mt-1 text-muted-foreground">
                    Signals: {signals.data?.filter((signal) => signal.runId === run.id).length ?? 0}{" "}
                    · Leads:{" "}
                    {
                      new Set(
                        signals.data
                          ?.filter((signal) => signal.runId === run.id)
                          .map(
                            (signal) =>
                              leads.data?.find((lead) => lead.signalIds.includes(signal.id))?.id,
                          )
                          .filter(Boolean),
                      ).size
                    }
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {leads.data
                      ?.filter((lead) =>
                        signals.data?.some(
                          (signal) => signal.runId === run.id && lead.signalIds.includes(signal.id),
                        ),
                      )
                      .map((lead) => (
                        <button
                          key={lead.id}
                          type="button"
                          className="rounded border border-border px-2 py-1 text-primary hover:bg-muted"
                          onClick={() => setSelectedLeadId(lead.id)}
                        >
                          {lead.title}
                        </button>
                      ))}
                  </div>
                  {run.safeFailure && <p className="mt-1 text-destructive">{run.safeFailure}</p>}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-muted-foreground">
                      Pinned Run inputs
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                      {run.profileSnapshot}\n{run.strategySnapshot}\n{run.policySnapshot}
                    </pre>
                  </details>
                </div>
              ))}
            </Card>
            {selectedLeadId && (
              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">Lead context</h2>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline"
                    onClick={() => setSelectedLeadId(undefined)}
                  >
                    Close
                  </button>
                </div>
                {leadContext.isLoading && <Loader2 className="size-4 animate-spin" />}
                {leadContext.data && (
                  <>
                    <div className="text-sm font-medium">{leadContext.data.lead.title}</div>
                    <p className="text-xs text-muted-foreground">
                      Canonical evidence:{" "}
                      {leadContext.data.lead.canonicalUrl ?? "provider identity"} {" · "}
                      Scouts: {leadContext.data.lead.scoutIds.length}
                    </p>
                    {leadContext.data.lead.conflicts.length > 0 && (
                      <div className="rounded border border-destructive/50 bg-destructive/5 p-2 text-xs">
                        <div className="font-medium text-destructive">Identity conflicts</div>
                        {leadContext.data.lead.conflicts.map((conflict, index) => (
                          <p
                            key={`${conflict.kind}-${conflict.signalId ?? index}`}
                            className="mt-1"
                          >
                            {conflict.detail}
                          </p>
                        ))}
                      </div>
                    )}
                    {leadContext.data.signals.map((signal) => (
                      <div key={signal.id} className="rounded border border-border p-2 text-xs">
                        <div className="font-medium">{signal.evidence.title}</div>
                        <p className="mt-1 text-muted-foreground">
                          {signal.evidence.canonicalUrl ??
                            signal.evidence.providerIdentity ??
                            "No URL"}
                          {" · "}
                          Run {signal.runId} · Scout {signal.scoutId} · {signal.processor}
                        </p>
                        <p className="mt-1 text-muted-foreground">
                          Attributed by {signal.attributions.length} Scout Run
                          {signal.attributions.length === 1 ? "" : "s"}
                        </p>
                      </div>
                    ))}
                    <div className="mt-2 rounded border border-border p-2">
                      <div className="text-xs font-medium">Opportunities</div>
                      {leadContext.data.opportunities.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          This Lead has not been promoted yet.
                        </p>
                      ) : (
                        leadContext.data.opportunities.map((opportunity) => (
                          <div key={opportunity.id} className="mt-1 text-xs">
                            {opportunity.title} · {opportunity.state}
                          </div>
                        ))
                      )}
                    </div>
                    <div className="mt-2 rounded border border-border p-2">
                      <div className="text-xs font-medium">Fit Evaluations</div>
                      {leadContext.data.fitEvaluations.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          No transparent evaluation has been recorded.
                        </p>
                      ) : (
                        leadContext.data.fitEvaluations.map((evaluation) => (
                          <div key={evaluation.id} className="mt-2 rounded bg-muted p-2 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">
                                {evaluation.freshness === "stale" ? "Stale" : "Current"} · Profile
                                Version {evaluation.profileVersionId}
                              </span>
                              <span className="text-muted-foreground">
                                {evaluation.hardConstraints.length} Hard Constraints ·{" "}
                                {evaluation.preferences.length} Preferences
                              </span>
                            </div>
                            <p className="mt-1 text-muted-foreground">
                              Evidence: {evaluation.evidence.length} cited · unknowns{" "}
                              {evaluation.unknowns.length} · conflicts {evaluation.conflicts.length}
                              {evaluation.staleReason ? ` · ${evaluation.staleReason}` : ""}
                            </p>
                            <div className="mt-1 grid gap-1 sm:grid-cols-2">
                              {evaluation.hardConstraints.map((constraint) => (
                                <span key={`hard-${constraint.key}`}>
                                  Hard: {constraint.key} · {constraint.result}
                                </span>
                              ))}
                              {evaluation.preferences.map((preference) => (
                                <span key={`preference-${preference.key}`}>
                                  Preference: {preference.key} · {preference.result}
                                </span>
                              ))}
                            </div>
                            <details className="mt-1">
                              <summary className="cursor-pointer text-muted-foreground">
                                Evidence links and reasoning
                              </summary>
                              {evaluation.evidence.map((citation) => (
                                <p key={`${evaluation.id}-${citation.signalId}`} className="mt-1">
                                  {citation.kind === "inference" ? "Inference" : "Fact"}:{" "}
                                  {citation.claim} · Signal {citation.signalId} ·{" "}
                                  {citation.freshness}
                                </p>
                              ))}
                            </details>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </Card>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
