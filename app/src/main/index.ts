import { join } from "node:path";
import { errorNameOf, sanitizeStack } from "@shared/analytics";
import type { HostNotification, NotificationKind } from "@shared/notify";
import { type AppSettings, DEFAULT_SETTINGS } from "@shared/settings";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { app, BrowserWindow, Notification } from "electron";
import superjson from "superjson";
import { WebSocket as NodeWebSocket } from "ws";
import { OPENTRADE_HOME } from "./db/client";
import { ensureHost, type HostManifest } from "./host/manifest";
import type { AppRouter } from "./trpc/routers";
import { initAutoUpdate } from "./updater";
import { createMainWindow } from "./window";

let mainWindow: BrowserWindow | null = null;
let relayClient: ReturnType<typeof createWSClient> | null = null;
let relayTrpc: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;
/** The adopted host, kept so a notification click can recreate a closed window. */
let currentHost: HostManifest | null = null;
/** Live AppSettings mirror driven by `settings.onChanged`; gates notification display.
 *  Seeded with defaults (all on) so display works before the first push arrives. */
let liveSettings: AppSettings = DEFAULT_SETTINGS;

/** AppSettings toggle backing each notification kind. */
const NOTIFY_TOGGLE: Record<NotificationKind, keyof AppSettings> = {
  wake: "notifyWakes",
  order: "notifyOrders",
  approval: "notifyApprovals",
  restricted: "notifyRestricted",
  update: "notifyUpdates",
};

/** True only when a live (non-destroyed) window exists and is focused. */
function windowFocused(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused();
}

/** Restore/show/focus the window, recreating it if it was closed — on macOS the app
 *  outlives its window, so a click on a wake notification must be able to reopen it. */
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!currentHost) return;
    mainWindow = createMainWindow({ trpcPort: currentHost.trpcPort, token: currentHost.token });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** The single display path for every notification kind: gate on the per-kind toggle,
 *  show the banner, and on click focus the window + fire `notification_clicked`. Safe
 *  to call even when the relay never connected (the updater calls it regardless).
 *  Returns whether a banner was actually shown (false if the toggle is off or the OS
 *  can't display one) — callers that dedupe rely on this. */
function showAppNotification(kind: NotificationKind, title: string, body: string): boolean {
  if (!liveSettings[NOTIFY_TOGGLE[kind]]) return false;
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body });
  n.on("click", () => {
    focusMainWindow();
    relayTrpc?.analytics.track
      .mutate({ event: "notification_clicked", props: { kind } })
      .catch(() => {});
  });
  n.show();
  return true;
}

// Key Electron's per-instance state (including the single-instance lock) to this
// home so parallel dev instances with distinct OPENTRADE_HOME don't collide.
app.setPath("userData", join(OPENTRADE_HOME, "electron"));

if (!app.requestSingleInstanceLock()) {
  // Another OpenTrade GUI is already running for this home — defer to it and exit.
  // (The backend host is separate and keeps running regardless.)
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(main);
}

async function main() {
  // The backend brokers real trades; surface its version to the headless host.
  process.env.OPENTRADE_VERSION = app.getVersion();

  // Adopt a running backend host or spawn one (detached, supervised). This is the
  // only way the GUI reaches state now — services live in the host, not here.
  let host: HostManifest;
  try {
    host = await ensureHost(join(__dirname, "host.js"), app.getVersion());
  } catch (err) {
    console.error("[launcher] backend host unavailable", err);
    // Still open the window, but with a zeroed port. The renderer reads trpcPort===0
    // as "backend failed to start" and shows a dedicated screen (BackendFailed)
    // instead of hanging on a blank screen.
    host = { pid: 0, faucetPort: 0, trpcPort: 0, token: "", startedAt: 0 };
  }
  currentHost = host;

  const win = createMainWindow({ trpcPort: host.trpcPort, token: host.token });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (host.trpcPort) wireNotifications(win, host);

  // App updates against GitHub Releases (no-op in dev / unpackaged). User-in-charge:
  // we check on boot + every 4h but never auto-download or install-on-quit — the
  // renderer prompts and the user accepts, which downloads + relaunches (the new
  // launcher's version-aware ensureHost then retires the stale host). The
  // download-complete event rides the relay client to the host's telemetry funnel;
  // the "available" banner goes through the gated helper so the "App updates" toggle applies.
  initAutoUpdate(win, {
    onDownloaded: (toVersion) =>
      relayTrpc?.analytics.track
        .mutate({ event: "update_downloaded", props: { to_version: toVersion } })
        .catch(() => {}),
    // A failed update check/download rides the same relay to the host funnel as a
    // sanitized `app_error` (subsystem "updater") — class name + bundle frames only,
    // never the message — so update failures are triageable alongside other daemon errors.
    onError: (err) => {
      const frames = sanitizeStack(err);
      relayTrpc?.analytics.track
        .mutate({
          event: "app_error",
          props: {
            subsystem: "updater",
            error_name: errorNameOf(err),
            source: "caught",
            ...(frames.length ? { frames } : {}),
          },
        })
        .catch(() => {});
    },
    // The in-app "Update Available" button is the indicator when the window is open;
    // only fall back to an OS notification when the user is away, so we don't
    // double-notify on boot. Returns whether it displayed so the updater dedupes on a
    // real show (a focus-suppressed one leaves the next background re-check free to fire).
    showNotification: (title, body) =>
      windowFocused() ? false : showAppNotification("update", title, body),
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow({ trpcPort: host.trpcPort, token: host.token });
    }
  });
}

// macOS: closing the window does not quit the app. The backend host is detached
// and survives regardless, so agent sessions keep running with the GUI closed.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // GUI going away → drop the broker to the blurred poll cadence. We do NOT tear
  // down PTYs here: the host's gui-presence detector already fires on the renderer
  // WS dropping (covers Cmd-Q, window-close, and crash uniformly) and tears down
  // every interactive PTY on `gui:gone` (§12.2). Headless `-p` scheduled runs are
  // PTY-independent, so they run to completion regardless of the GUI.
  relayTrpc?.broker.setFocused.mutate({ focused: false }).catch(() => {});
  relayClient?.close();
});

/**
 * Notification relay. All app state lives in the backend host, so macOS
 * notifications, the dock badge, and the focus relay are driven by a small
 * tRPC-over-WS client — out of the data path. The host formats notifications
 * (`notifications.onNotify`); this launcher gates them (per-kind toggle, per-agent
 * mute, window focus for wakes) and displays them. The approval badge/flash stay
 * unconditional — only the approval *banner* is gated (§12.4).
 */
function wireNotifications(win: BrowserWindow, host: HostManifest) {
  const wsClient = createWSClient({
    // Tag this connection `&client=relay` so the host's gui-presence detector
    // excludes it — only true renderer connections count as "GUI present" (§12.2).
    url: `ws://127.0.0.1:${host.trpcPort}?token=${encodeURIComponent(host.token)}&client=relay`,
    // Electron main is a Node context; supply a WebSocket implementation.
    WebSocket: NodeWebSocket as unknown as typeof WebSocket,
  });
  relayClient = wsClient;
  const client = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient, transformer: superjson })],
  });
  relayTrpc = client;

  // Relay window focus to the host so it polls the broker at the fast cadence only
  // while the user is watching (the host defaults to the blurred cadence). The
  // window opens focused, so assert that once, then track focus/blur.
  const setFocused = (focused: boolean) =>
    client.broker.setFocused.mutate({ focused }).catch(() => {});
  setFocused(true);
  win.on("focus", () => setFocused(true));
  win.on("blur", () => setFocused(false));

  // Keep the notification gate live. `settings.onChanged` pushes the current
  // settings immediately on (re)connect, so this both seeds and refreshes the cache
  // and self-heals across a relay reconnect — no separate `get` query needed.
  client.settings.onChanged.subscribe(undefined, {
    onData: (s: AppSettings) => {
      liveSettings = s;
    },
  });

  const updateBadge = async () => {
    try {
      const n = await client.approvals.pendingCount.query();
      app.dock?.setBadge(n > 0 ? String(n) : "");
    } catch {
      // host briefly unreachable — leave the badge as-is
    }
  };

  // Approval alerts: the dock badge + frame flash + window focus are unconditional
  // (the user asked for an approval; they need to see it). Only the banner is gated,
  // and that happens on the `notify` stream below.
  client.approvals.onPending.subscribe(undefined, {
    onData: () => {
      if (!windowFocused()) win.flashFrame(true);
      win.focus();
      void updateBadge();
    },
  });

  client.approvals.onChanged.subscribe(undefined, {
    onData: () => void updateBadge(),
  });

  // Host-formatted notification banners. The host owns the copy; the launcher gates
  // per-agent mute + (for wakes) window focus, then displays via the shared helper
  // (which applies the per-kind toggle).
  client.notifications.onNotify.subscribe(undefined, {
    onData: (n: HostNotification) => {
      if (n.agentId && liveSettings.notifyMutedAgents.includes(n.agentId)) return;
      // Wakes only interrupt when you're away — you'd see the terminal light up otherwise.
      if (n.kind === "wake" && windowFocused()) return;
      showAppNotification(n.kind, n.title, n.body);
    },
  });
}
