import { Clock, Info, type LucideIcon, Radio } from "lucide-react";
import { useState } from "react";
import monitorExample from "../../assets/monitor-example.webp";
import timerExample from "../../assets/timer-example.webp";
import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

// ─────────────────────────────────────────────────────────────────────────────
// Autonomy explainer — shown wherever an agent has no timers or monitors armed.
// Agents create these themselves via the `opentrade` MCP server (§12.2), so the
// only thing the user can do is *ask*; this nudges them to, and the dialog
// explains what the two trigger kinds actually are.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The nudge itself: an info icon + one line of copy, clickable to open
 * {@link AutonomyInfoDialog}. Rendered in the Monitor tab's Active slot when the
 * selected agent has nothing armed.
 */
export function AutonomyHint({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask your agent to set up a timer or monitor — learn more"
        className={cn(
          "group flex w-full items-start gap-2 py-2 text-left text-sm text-muted-foreground",
          "transition-colors hover:text-foreground",
          className,
        )}
      >
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
          <Info className="size-3.5 text-muted-foreground transition-colors group-hover:text-sky-400" />
        </span>
        <span className="min-w-0 flex-1">Ask your agent to set up a timer or monitor.</span>
      </button>
      <AutonomyInfoDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * A bare info icon that opens the same explainer — for surfaces that already
 * have their own empty-state copy (the Scheduled screen) and just need the
 * "what are these?" affordance.
 */
export function AutonomyInfoButton({
  label = "What are timers and monitors?",
}: {
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Info className="size-3.5" />
        {label}
      </button>
      <AutonomyInfoDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The explainer: what a timer is and what a monitor is, nothing more. */
export function AutonomyInfoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Scheduling Agents</DialogTitle>
          <DialogDescription>
            Agents can proactively react to events by setting up Timers and Monitors. These continue
            to run in the background after the app is closed so agents don&apos;t miss events.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 flex flex-col gap-6">
          <Explainer
            icon={Clock}
            tone="text-sky-400"
            title="Timers"
            body="Notify agents on a schedule. Provide a schedule - every weekday at 9:30am, once at 3:55pm, every 15 minutes - and some instructions on what the agent should do. Perfect for periodic tasks and portfolio monitoring."
            image={timerExample}
            alt="OpenTrade's Monitor tab showing an armed timer: a pre-market news scan that runs weekdays at 6:00 AM, with its prompt and next run."
          />
          <Explainer
            icon={Radio}
            tone="text-emerald-400"
            title="Monitors"
            body="Notify agents on a signal. Describe what needs monitoring - price thresholds, volatility spikes, X posts, API responses - and some instructions. Perfect for reacting to market events and integrating with other systems."
            image={monitorExample}
            alt="OpenTrade's Monitor tab showing a live monitor: a shell command watching AAPL and MU for a 10% drawdown from their running peak, with its description and command."
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One trigger kind, as a row: a real screenshot of that kind expanded in the
 * Monitor tab on the left, its tinted icon / name / description on the right. The
 * two kinds stack vertically (the shots are full app frames — two per row would
 * shrink them past reading size); the dialog scrolls if they outrun the window.
 * Below `sm` the row itself stacks, image first.
 */
function Explainer({
  icon: Icon,
  tone,
  title,
  body,
  image,
  alt,
}: {
  icon: LucideIcon;
  tone: string;
  title: string;
  body: string;
  image: string;
  alt: string;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <img
        src={image}
        alt={alt}
        className="w-full shrink-0 rounded-md border border-border sm:w-[60%]"
        draggable={false}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className={cn("size-4", tone)} />
          </span>
          <p className="text-sm font-medium text-foreground">{title}</p>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
