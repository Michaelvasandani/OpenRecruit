import { Download, Loader2 } from "lucide-react";
import { useUpdater } from "../../lib/updater";
import { cn } from "../../lib/utils";

/**
 * Sidebar call-to-action shown just above Settings when an update is actionable.
 * Updates are user-in-charge (the app checks on boot + every 4h but never
 * auto-downloads/installs — see main/updater.ts). When a newer version is found the
 * button reads "Update Available"; clicking it downloads (if needed) and relaunches
 * immediately, with the label tracking status. Renders nothing otherwise — the manual
 * check and idle/error/up-to-date states live in Settings → About.
 */
export function UpdateButton() {
  const { state, install } = useUpdater();
  const status = state?.status;
  if (status !== "available" && status !== "downloading" && status !== "downloaded") return null;

  const available = status === "available";
  const label = available
    ? "Update Available"
    : status === "downloading"
      ? `Downloading${state?.progressPercent != null ? ` ${state.progressPercent}%` : "…"}`
      : "Restarting…";

  return (
    <button
      type="button"
      onClick={available ? install : undefined}
      disabled={!available}
      // Available: styled exactly like the Settings button (muted text/icon, same
      // padding/hover). While downloading/restarting: the whole row goes orange with a
      // spinner, matching the "OpenTrade connecting…" indicator.
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
        available ? "text-muted-foreground" : "pointer-events-none text-warning",
      )}
    >
      {available ? <Download className="size-4" /> : <Loader2 className="size-4 animate-spin" />}
      {label}
    </button>
  );
}
