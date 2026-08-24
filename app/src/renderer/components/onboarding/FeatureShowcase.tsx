import { StatusDot } from "@renderer/components/layout/StatusDot";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import type { AgentStatus } from "@shared/agent";
import { Clock, Radio } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

/**
 * Onboarding step shown right before "Create your first agent": three core
 * features side by side, each a tinted card holding a small static preview built
 * from the OpenRecruit Candidate workspace (Runs, Sources, and Scouts). Purely presentational — no live data, just a taste
 * of what the app does before the user creates anything.
 */
export function FeatureShowcase({ onNext, className }: { onNext: () => void; className?: string }) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Feature
          tint="sky"
          title="Durable Scout Runs"
          blurb="Runs stay checkpointed and resumable while the detached local host keeps scheduled discovery moving after you close the app."
          mock={<TimersMock />}
        />
        <Feature
          tint="emerald"
          title="Candidate Profile + Sources"
          blurb="Review a versioned Candidate Profile, select explicit Sources, and keep provenance attached to every Signal and Lead."
          mock={<ProfileMock />}
        />
        <Feature
          tint="violet"
          title="Review employment paths"
          blurb="Compare Scouts, Fit Evaluation evidence, Revisit Plans, and Candidate Decisions in one private workspace."
          mock={<AgentsMock />}
        />
      </div>

      <div className="mt-8 flex justify-center">
        <Button type="button" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feature column: tinted card holding the mock, with copy beneath.    */
/* ------------------------------------------------------------------ */

type Tint = "sky" | "emerald" | "violet";

const TINTS: Record<Tint, string> = {
  sky: "bg-sky-500/10 ring-sky-500/15",
  emerald: "bg-emerald-500/10 ring-emerald-500/15",
  violet: "bg-violet-500/10 ring-violet-500/15",
};

function Feature({
  tint,
  title,
  blurb,
  mock,
}: {
  tint: Tint;
  title: string;
  blurb: string;
  mock: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className={cn("rounded-2xl p-4 ring-1", TINTS[tint])}>
        {/* The inset preview: a compact OpenRecruit workspace card. */}
        <div className="h-60 overflow-hidden rounded-xl border border-border bg-card shadow-xl shadow-black/30">
          {mock}
        </div>
      </div>
      <div className="mt-5 px-1">
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mock 1 — Persistent timers & crons (slice of Scheduled / Monitor).  */
/* ------------------------------------------------------------------ */

function TimersMock() {
  return (
    <div className="p-3">
      <SectionLabel>Scheduled</SectionLabel>
      <div className="mt-1 flex flex-col">
        <CronRow
          icon={Clock}
          tone="text-sky-400"
          title="New source review"
          schedule="Weekdays · 9:30 AM"
          right="in 3h"
        />
        <CronRow
          icon={Clock}
          tone="text-sky-400"
          title="Candidate follow-up"
          schedule="Weekdays · 12:00 PM"
          right="in 6h"
        />
        <CronRow
          icon={Radio}
          tone="text-emerald-400"
          title="Source changes"
          schedule="On signal"
          right="live"
          rightTone="text-emerald-400"
        />
        <CronRow
          icon={Clock}
          tone="text-sky-400"
          title="Weekly profile check"
          schedule="Sundays · 6:00 PM"
          right="in 2d"
        />
      </div>
    </div>
  );
}

function CronRow({
  icon: Icon,
  tone,
  title,
  schedule,
  right,
  rightTone = "text-muted-foreground",
}: {
  icon: ComponentType<{ className?: string }>;
  tone: string;
  title: string;
  schedule: string;
  right: string;
  rightTone?: string;
}) {
  return (
    <div className="flex items-start gap-2 border-t border-border py-2 text-sm first:border-t-0">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
          <span className={cn("shrink-0 text-[11px] tabular-nums", rightTone)}>{right}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{schedule}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mock 2 — Candidate Profile and Source readiness.                   */
/* ------------------------------------------------------------------ */

function ProfileMock() {
  return (
    <div className="p-3">
      <SectionLabel>Candidate Profile · confirmed v3</SectionLabel>
      <div className="mt-2 rounded border border-border bg-background/50 p-2 text-sm">
        <div className="font-medium text-foreground">Senior product engineer</div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          CV + public GitHub · updated today
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <SectionLabel>Sources</SectionLabel>
          <span className="text-[10px] text-success">2 ready</span>
        </div>
        <div className="mt-1">
          <PosRow symbol="RSS / jobs" last="ready" pnl="public" dir="up" />
          <PosRow symbol="X API v2" last="ready" pnl="public" dir="up" />
        </div>
      </div>
    </div>
  );
}

function PosRow({
  symbol,
  last,
  pnl,
  dir,
}: {
  symbol: string;
  last: string;
  pnl: string;
  dir: "up" | "down";
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 py-1 text-sm">
      <span className="font-medium text-foreground">{symbol}</span>
      <span className="text-right text-[11px] tabular-nums text-muted-foreground">{last}</span>
      <span
        className={cn(
          "w-16 text-right tabular-nums",
          dir === "up" ? "text-success" : "text-destructive",
        )}
      >
        {pnl}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mock 3 — Persistent Scouts (slice of the Scout sidebar).               */
/* ------------------------------------------------------------------ */

function AgentsMock() {
  return (
    <div className="h-full bg-sidebar p-2 text-sidebar-foreground">
      <div className="px-2 pb-1 pt-1">
        <SectionLabel>Scouts</SectionLabel>
      </div>
      <AgentRow name="Product roles" status="working" note="running" selected />
      <AgentRow name="Startup paths" status="idle" />
      <AgentRow
        name="Remote roles"
        status="needs-input"
        note="needs input"
        noteTone="text-amber-400"
      />
      <AgentRow name="Founder signals" status="idle" badge="2" />
      <AgentRow name="Open-source leads" status="idle" />
      <AgentRow name="Revisit queue" status="working" />
    </div>
  );
}

function AgentRow({
  name,
  status,
  note,
  noteTone = "text-muted-foreground",
  badge,
  selected,
}: {
  name: string;
  status: AgentStatus;
  note?: string;
  noteTone?: string;
  badge?: string;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        selected && "bg-sidebar-accent font-medium",
      )}
    >
      <StatusDot status={status} />
      <span className="flex-1 truncate">{name}</span>
      {note && <span className={cn("shrink-0 text-[11px]", noteTone)}>{note}</span>}
      {badge && (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-red-500 text-[10px] font-medium text-white">
          {badge}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}
