// Auto-update for the packaged macOS app, via electron-updater against GitHub
// Releases (publish config in electron-builder.yml bakes app-update.yml into the
// build, which electron-updater reads — no feed URL needed here).
//
// OpenTrade-specific wrinkle: the backend host is a DETACHED process that survives
// the GUI quitting. After an update swaps the .app and the app relaunches, the new
// launcher's `ensureHost` already refuses to adopt a version-mismatched host and
// SIGTERMs + respawns a fresh one (see host/manifest.ts). That version-aware
// adoption is the ONLY thing that retires the old host, and it runs at the right
// moment: on relaunch, not while the GUI is still live. We deliberately do NOT
// SIGTERM the host when the update merely finishes downloading — that killed the
// backend out from under a running session (nothing respawns it until relaunch, so
// the renderer hung on "OpenTrade connecting…"), and it was redundant with the
// relaunch-time version check anyway.

import { app, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4h

export function initAutoUpdate(
  _win: BrowserWindow,
  hooks: {
    /** Telemetry hook — the staged version. */
    onDownloaded?: (version: string) => void;
    /** Display hook — routed through the launcher's gated notification helper so the
     *  "App updates" toggle applies (§12.4). */
    showNotification?: (title: string, body: string) => void;
  } = {},
): void {
  // electron-updater requires a packaged app with a baked app-update.yml.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Differential downloads are flaky on macOS zip updates; full download is robust.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on("update-downloaded", (info) => {
    // Stage is complete; autoInstallOnAppQuit will apply it on the next quit, and
    // the relaunched launcher's version-aware `ensureHost` retires the old host (we
    // deliberately do NOT SIGTERM the host on download — see the header comment).
    // The banner goes through the gated helper so the "App updates" toggle applies.
    hooks.onDownloaded?.(info.version);
    hooks.showNotification?.(
      "OpenTrade update ready",
      `Version ${info.version} will install when you quit OpenTrade.`,
    );
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater]", err);
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => console.error("[updater] check failed", err));
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
