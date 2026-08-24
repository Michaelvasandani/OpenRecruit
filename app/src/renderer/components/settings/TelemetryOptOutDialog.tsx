import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";

/** OpenRecruit's source issue tracker — the opt-out alternative feedback channel. */
export const OPENRECRUIT_ISSUES_URL = "https://github.com/Michaelvasandani/OpenRecruit/issues";

/**
 * Every event in the `shared/analytics.ts` allowlist, bucketed three ways. The dialog
 * calls this exhaustive, so it must stay exhaustive — each bucket below covers a
 * contiguous group of `TELEMETRY_EVENTS`, and a new event there needs a home here:
 *  1. app — `host_started`, `app_opened`, `app_updated`, `update_downloaded`, the
 *     `onboarding_*` funnel, `setting_changed`, `telemetry_enabled|disabled`,
 *     `notification_clicked`.
 *  2. agents — `agent_created|archived|restarted`, `terminal_session_started|respawned`,
 *     `schedule_created|fired`, `headless_run_finished`, `agent_marked_broken`,
 *     `turn_limit_reached`.
 *  3. errors — `app_error`.
 */
const COLLECTED = [
  {
    label: "App usage",
    detail: "launches, onboarding progress, and settings you change",
  },
  {
    label: "Agent activity",
    detail: "Scouts created or archived, schedules firing, and background runs",
  },
  { label: "Errors", detail: "the error type and the code line it came from" },
];

/**
 * Shown when the user moves the telemetry toggle to **off** (never when turning it
 * on). Telemetry is deliberately the only product-feedback channel OpenRecruit has —
 * local-first, no accounts, no backend holding user data — so the opt-out states what
 * it costs, the exhaustive `COLLECTED` breakdown, what is never collected (both
 * mirroring the allowlist in `shared/analytics.ts` — keep in sync if that changes),
 * and the Discord as the alternative. Deliberately terse: a wall of text at a toggle
 * goes unread. The setting only flips once `onConfirm` fires; cancelling leaves
 * telemetry on.
 */
export function TelemetryOptOutDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent className="gap-3 sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Turn off anonymous usage data?</AlertDialogTitle>
          <AlertDialogDescription>
            It's our only product feedback — OpenRecruit has no accounts and no server holding your
            data. Here's an exhaustive list of usage we collect:
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="space-y-1.5">
          {COLLECTED.map(({ label, detail }) => (
            <li key={label} className="flex gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="select-none text-muted-foreground/60">
                &bull;
              </span>
              <span>
                <span className="font-medium text-foreground">{label}</span> — {detail}
              </span>
            </li>
          ))}
        </ul>

        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Never collected:</span> your conversations,
          candidate data, source contents, or anything identifying you.
        </p>

        <p className="text-sm text-muted-foreground">
          If you decide to opt out, please{" "}
          <a
            href={OPENRECRUIT_ISSUES_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            open an issue
          </a>{" "}
          so we can still hear from you!
        </p>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Keep it on</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Turn it off
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
