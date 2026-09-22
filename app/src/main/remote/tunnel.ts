import { execFile, spawn } from "node:child_process";
import { get } from "node:http";
import { createServer } from "node:net";
import type { HostManifest } from "../host/manifest";

/**
 * SSH reachability for a backend host on another machine.
 *
 * The remote host binds loopback only (its token + open CORS were never meant to
 * face a network), so the launcher reaches it the way `ssh -L` always has: a local
 * port on THIS machine forwards to the host's tRPC port on THAT one. The renderer
 * keeps talking to `127.0.0.1:<port>` and cannot tell the difference.
 *
 * The local port is chosen once and kept for the tunnel's lifetime — it is baked
 * into the renderer at window creation — while the remote port is re-read from the
 * remote manifest on every (re)connect, since a restarted host picks a new one.
 */

/** Non-interactive: a GUI app has no tty to answer a passphrase/host-key prompt on. */
const SSH_BASE_ARGS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

export interface ForwardProcess {
  onExit(cb: () => void): void;
  kill(): void;
}

export interface TunnelDeps {
  readManifest(target: string): Promise<HostManifest>;
  openForward(target: string, localPort: number, remotePort: number): ForwardProcess;
  /** Does anything answer HTTP on the local end of the forward? */
  probe(localPort: number): Promise<boolean>;
  freePort(): Promise<number>;
  delay(ms: number): Promise<void>;
}

/** Read `~/.opentrade/host.json` off the remote machine. */
export function readRemoteManifest(target: string): Promise<HostManifest> {
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      // `--` ends option parsing: the target can never be read as an ssh flag.
      [...SSH_BASE_ARGS, "--", target, "cat ~/.opentrade/host.json"],
      { timeout: 20_000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim().split("\n").pop() || err.message;
          const hint = /No such file/.test(detail)
            ? "no OpenRecruit host is running there (is openrecruit-host.service started?)"
            : /Host key verification failed/.test(detail)
              ? `unknown host key — run \`ssh ${target}\` once in a terminal to accept it`
              : /Permission denied/.test(detail)
                ? "SSH key not accepted — the app cannot answer password or passphrase prompts"
                : detail;
          reject(new Error(hint));
          return;
        }
        try {
          const m = JSON.parse(stdout) as HostManifest;
          if (!m.trpcPort || !m.token) throw new Error("incomplete");
          resolve(m);
        } catch {
          reject(new Error("the remote host manifest is unreadable"));
        }
      },
    );
  });
}

function openSshForward(target: string, localPort: number, remotePort: number): ForwardProcess {
  const child = spawn(
    "ssh",
    [
      ...SSH_BASE_ARGS,
      "-N",
      // Notice a dead peer (laptop sleep, Wi-Fi change) within ~45s and exit, so the
      // supervisor reconnects instead of holding a forward that goes nowhere.
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      "--",
      target,
    ],
    { stdio: "ignore" },
  );
  return {
    onExit: (cb) => {
      child.once("exit", cb);
      child.once("error", cb);
    },
    kill: () => child.kill(),
  };
}

/** Any HTTP response at all proves the forward reaches a listening host; a forward
 *  to a dead remote port accepts the TCP connection and then resets it. */
function probeHttp(localPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port: localPort, path: "/", timeout: 3000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const REAL_DEPS: TunnelDeps = {
  readManifest: readRemoteManifest,
  openForward: openSshForward,
  probe: probeHttp,
  freePort: findFreePort,
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const CONNECT_PROBES = 40; // × 250ms = 10s for ssh to authenticate and bind
const HEALTH_INTERVAL_MS = 15_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10_000];

export class SshTunnel {
  private _localPort = 0;
  private forward: ForwardProcess | null = null;
  private stopped = false;
  private reconnecting = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private missedProbes = 0;

  constructor(
    private readonly target: string,
    private readonly deps: TunnelDeps = REAL_DEPS,
  ) {}

  get localPort(): number {
    return this._localPort;
  }

  /** Open the tunnel; resolves with the remote manifest once the host answers through
   *  it. Rejects (leaving nothing running) if the first connection cannot be made. */
  async start(): Promise<HostManifest> {
    this._localPort = await this.deps.freePort();
    try {
      const manifest = await this.connect();
      this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
      return manifest;
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.forward?.kill();
    this.forward = null;
  }

  private async connect(): Promise<HostManifest> {
    const manifest = await this.deps.readManifest(this.target);
    const forward = this.deps.openForward(this.target, this._localPort, manifest.trpcPort);
    let exited = false;
    forward.onExit(() => {
      exited = true;
      if (this.forward === forward) {
        this.forward = null;
        void this.reconnect();
      }
    });
    for (let i = 0; i < CONNECT_PROBES && !exited && !this.stopped; i++) {
      if (await this.deps.probe(this._localPort)) {
        this.forward = forward;
        this.missedProbes = 0;
        return manifest;
      }
      await this.deps.delay(250);
    }
    forward.kill();
    throw new Error(
      exited ? "the SSH tunnel closed before the host answered" : "the host did not answer",
    );
  }

  /** Bring the forward back on the SAME local port, forever, until `stop()`. The
   *  renderer's WebSocket retries on its own, so a restored forward is a restored app. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    try {
      for (let attempt = 0; !this.stopped; attempt++) {
        await this.deps.delay(
          RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)],
        );
        if (this.stopped) return;
        try {
          await this.connect();
          return;
        } catch {
          // offline / VM rebooting — keep trying
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /** ssh stays up when only the remote HOST restarts (on a new port): the forward then
   *  points at nothing. Two missed probes → drop it so reconnect re-reads the manifest. */
  async checkHealth(): Promise<void> {
    const forward = this.forward;
    if (!forward || this.reconnecting || this.stopped) return;
    if (await this.deps.probe(this._localPort)) {
      this.missedProbes = 0;
      return;
    }
    if (++this.missedProbes < 2 || this.forward !== forward) return;
    this.forward = null;
    forward.kill();
    void this.reconnect();
  }
}
