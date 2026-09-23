import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

/** Backend endpoint the renderer connects its tRPC client to (passed via preload). */
export interface HostEndpoint {
  trpcPort: number;
  /**
   * Local port to reach the host's terminal WebSocket on, overriding the one in the
   * URL the host hands out — nonzero only through a remote tunnel, where the host's
   * own port exists only on the other machine. 0 = use the URL as given.
   */
  terminalPort: number;
  token: string;
}

export function createMainWindow(host: HostEndpoint): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#121212",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      // The renderer reads these from the preload bridge to build its tRPC client.
      additionalArguments: [
        `--opentrade-trpc-port=${host.trpcPort}`,
        `--opentrade-terminal-port=${host.terminalPort}`,
        `--opentrade-token=${host.token}`,
      ],
    },
  });

  win.on("ready-to-show", () => win.show());

  // Surface renderer console + crashes in the main process log (dev diagnostics).
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer:err] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[renderer gone]", details.reason, details.exitCode);
  });
  win.webContents.on("preload-error", (_e, path, error) => {
    console.error("[preload error]", path, error);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}
