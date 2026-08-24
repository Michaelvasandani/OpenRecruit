import type { Agent } from "@shared/agent";
import { CalendarClock, FileUser, Loader2, PlayCircle, Plus, Settings, X } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useAgents } from "../../hooks/useAgents";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connection";
import { useUIStore } from "../../stores/ui";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Separator } from "../ui/separator";
import { StatusDot } from "./StatusDot";

export function AgentSidebar() {
  const agents = useAgents();
  const reviewSidebar = trpc.recruiting.review.sidebar.useQuery();
  const scouts = reviewSidebar.data?.scouts ?? [];
  const utils = trpc.useUtils();
  const selectedId = useUIStore((s) => s.selectedAgentId);
  const selectedScoutId = useUIStore((s) => s.selectedScoutId);
  const select = useUIStore((s) => s.select);
  const selectScout = useUIStore((s) => s.selectScout);
  const view = useUIStore((s) => s.view);
  const setView = useUIStore((s) => s.setView);
  const openNewAgent = useUIStore((s) => s.openNewAgent);
  const backendConnected = useConnectionStore((s) => s.backendConnected);
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);

  const archiveAgent = trpc.agents.archive.useMutation();

  trpc.recruiting.onChanged.useSubscription(undefined, {
    onData: (event) => {
      if (event.reason === "resync" || event.kind) {
        void utils.recruiting.review.sidebar.invalidate();
      }
    },
  });

  // Selecting an agent always returns to the agent workspace from Settings.
  const openAgent = (id: string) => {
    select(id);
    setView("agents");
  };

  // Auto-select first agent when nothing is selected.
  useEffect(() => {
    if (!selectedId && agents.length > 0) select(agents[0].id);
  }, [agents, selectedId, select]);

  const confirmDelete = () => {
    const agent = pendingDelete;
    if (!agent) return;
    // Clear selection if we're deleting the focused agent; the auto-select
    // effect then picks the next remaining agent (or none).
    if (selectedId === agent.id) select(null);
    archiveAgent.mutate({ id: agent.id });
    setPendingDelete(null);
  };

  return (
    <div className="flex h-full w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
      <div className="h-10 shrink-0" style={{ WebkitAppRegion: "drag" } as CSSProperties} />

      {/* Top section: brand + new Scout */}
      <div className="px-3 pb-2 pt-1">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          OpenRecruit
        </span>
      </div>
      <div className="flex flex-col gap-1 px-2 pb-2">
        <button
          type="button"
          onClick={() => setView("scheduled")}
          disabled={!backendConnected}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
            view === "scheduled"
              ? "bg-sidebar-accent font-medium text-sidebar-foreground"
              : "text-muted-foreground",
            !backendConnected && "pointer-events-none opacity-50",
          )}
        >
          <CalendarClock className="size-4" /> Scheduled
        </button>
        <button
          type="button"
          onClick={openNewAgent}
          disabled={!backendConnected}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent",
            !backendConnected && "pointer-events-none opacity-50",
          )}
        >
          <Plus className="size-4" /> New Scout
        </button>
      </div>

      <Separator className="bg-sidebar-border" />

      <div className="px-3 pb-2 pt-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Scouts
        </span>
      </div>
      <div className="px-2 pb-2">
        {!backendConnected && reviewSidebar.data && (
          <p className="mb-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] text-warning">
            Scout summaries are stale while reconnecting.
          </p>
        )}
        {reviewSidebar.isLoading && (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading Scouts…
          </div>
        )}
        {reviewSidebar.error && !reviewSidebar.data && (
          <div className="rounded-md border border-destructive/30 px-2 py-2 text-xs text-destructive">
            Scout sidebar unavailable. Select Run Center to retry.
          </div>
        )}
        {!reviewSidebar.isLoading && !reviewSidebar.error && scouts.length === 0 && (
          <p className="px-2 py-1 text-sm text-muted-foreground">No Scouts yet.</p>
        )}
        {scouts.map((entry) => (
          <button
            type="button"
            key={entry.scout.id}
            onClick={() => {
              selectScout(entry.scout.id);
              setView("runs");
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent",
              view === "runs" &&
                selectedScoutId === entry.scout.id &&
                "bg-sidebar-accent font-medium",
            )}
            title={entry.scout.instructionPath}
          >
            <span
              className={cn(
                "size-2 rounded-full",
                entry.activeRun ? "bg-amber-500" : "bg-emerald-500",
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="block truncate">{entry.scout.name}</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {entry.activeRun?.status ?? entry.latestRun?.status ?? "No Run"} · last{" "}
                {entry.lastRunAt ? new Date(entry.lastRunAt).toLocaleDateString() : "—"} · next{" "}
                {entry.nextRunAt ? new Date(entry.nextRunAt).toLocaleDateString() : "manual"}
              </span>
            </span>
            <span className="text-[10px] uppercase text-muted-foreground">
              {entry.freshLeadCount > 0 ? `${entry.freshLeadCount} fresh` : entry.scout.harness}
              <span className="block normal-case">
                src {entry.sourceReadiness.ready}/{entry.sourceReadiness.total}
              </span>
            </span>
            {entry.dueRevisitCount > 0 && (
              <span className="text-[10px] text-warning">{entry.dueRevisitCount} due</span>
            )}
          </button>
        ))}
        {reviewSidebar.data && reviewSidebar.data.sourceReadiness.total > 0 && (
          <p className="px-2 pt-1 text-[10px] text-muted-foreground">
            Sources ready {reviewSidebar.data.sourceReadiness.ready}/
            {reviewSidebar.data.sourceReadiness.total}
          </p>
        )}
      </div>

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => setView("runs")}
          disabled={!backendConnected}
          className={cn(
            "mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
            view === "runs"
              ? "bg-sidebar-accent font-medium text-sidebar-foreground"
              : "text-muted-foreground",
            !backendConnected && "pointer-events-none opacity-50",
          )}
        >
          <PlayCircle className="size-4" /> Scout Runs
        </button>
        <button
          type="button"
          onClick={() => setView("profiles")}
          disabled={!backendConnected}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
            view === "profiles"
              ? "bg-sidebar-accent font-medium text-sidebar-foreground"
              : "text-muted-foreground",
            !backendConnected && "pointer-events-none opacity-50",
          )}
        >
          <FileUser className="size-4" /> Candidate Profiles
        </button>
      </div>

      <div className="px-3 pb-2 pt-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Local harnesses
        </span>
      </div>

      <div
        className={cn(
          "flex-1 overflow-y-auto px-2",
          // Backend down: agent rows are stale and can't be opened/acted on — grey them out.
          !backendConnected && "pointer-events-none opacity-50",
        )}
      >
        {agents.length === 0 && (
          <p className="px-2 py-3 text-sm text-muted-foreground">No local harnesses yet.</p>
        )}
        {agents.map((agent) => (
          <div
            key={agent.id}
            className={cn(
              "group flex w-full items-center gap-2 rounded-md pl-2 pr-1 text-sm",
              "hover:bg-sidebar-accent",
              view === "agents" && selectedId === agent.id && "bg-sidebar-accent font-medium",
            )}
          >
            <button
              type="button"
              onClick={() => openAgent(agent.id)}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            >
              <StatusDot status={agent.status} />
              <span className="flex-1 truncate">{agent.name}</span>
            </button>
            <button
              type="button"
              aria-label={`Delete ${agent.name}`}
              onClick={(e) => {
                e.stopPropagation();
                setPendingDelete(agent);
              }}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-border hover:text-foreground group-hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1 border-t border-sidebar-border p-2">
        {/* Reconnecting indicator: the renderer→host WebSocket is down (host
            restarting/briefly unreachable). wsLink auto-reconnects; this just tells
            the user the UI may be stale meanwhile. Hidden on the normal connected path. */}
        {!backendConnected && (
          <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-warning">
            <Loader2 className="size-4 animate-spin" />
            OpenRecruit connecting…
          </div>
        )}
        <button
          type="button"
          onClick={() => setView("settings")}
          disabled={!backendConnected}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
            view === "settings"
              ? "bg-sidebar-accent font-medium text-sidebar-foreground"
              : "text-muted-foreground",
            !backendConnected && "pointer-events-none opacity-50",
          )}
        >
          <Settings className="size-4" /> Settings
        </button>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete agent?"
        body={
          <>
            <span className="font-medium text-foreground">{pendingDelete?.name}</span> will be
            removed and its agent session stopped. Its folder on disk is kept.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
