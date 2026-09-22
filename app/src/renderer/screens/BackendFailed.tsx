import { ServerCrash } from "lucide-react";
import type { CSSProperties } from "react";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { useConnectionStatus } from "../lib/connection";

/**
 * Shown when the backend host could not be reached (the renderer got trpcPort===0 and
 * can never reach state). Local mode: the launcher couldn't spawn/adopt a host, so the
 * user quits and reopens. Remote mode: the SSH tunnel to the configured machine failed;
 * the launcher's error explains why, and the user can fall back to a local host —
 * without this the app would be locked out by one bad address.
 */
export function BackendFailed() {
  const status = useConnectionStatus();
  const remote =
    status && status.config.mode === "remote" ? { ...status, config: status.config } : null;
  const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;
  return (
    <Empty
      className="h-full w-full bg-background"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      <EmptyMedia>
        <ServerCrash className="size-12 text-foreground" strokeWidth={1.5} />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>
          {remote ? `Could not reach ${remote.config.sshTarget}` : "OpenRecruit failed to start"}
        </EmptyTitle>
        <EmptyDescription>
          {remote
            ? (remote.error ?? "The remote host did not answer.")
            : "Failed to connect to the backend. Please restart OpenRecruit to try again."}
        </EmptyDescription>
      </EmptyHeader>
      {remote && (
        <div className="flex gap-2" style={NO_DRAG}>
          <Button
            type="button"
            onClick={() => void window.__opentradeConnection?.apply(remote.config)}
          >
            Try again
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void window.__opentradeConnection?.apply({ mode: "local" })}
          >
            Use this Mac instead
          </Button>
        </div>
      )}
    </Empty>
  );
}
