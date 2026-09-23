import { describe, expect, test } from "bun:test";
import type { HostManifest } from "../host/manifest";
import { type ForwardProcess, type PortForward, SshTunnel, type TunnelDeps } from "./tunnel";

const manifest = (trpcPort: number, terminalPort?: number): HostManifest => ({
  pid: 4242,
  faucetPort: 29000,
  trpcPort,
  terminalPort,
  token: "tok",
  startedAt: 1,
  version: "0.2.5",
});

/** A scriptable world: which remote port the host is on, and whether it answers. */
function world(
  opts: { remotePort?: number; terminalPort?: number; answers?: boolean; ports?: number[] } = {},
) {
  const state = {
    remotePort: opts.remotePort ?? 5000,
    terminalPort: opts.terminalPort,
    answers: opts.answers ?? true,
    manifestError: null as Error | null,
    forwards: [] as {
      localPort: number;
      remotePort: number;
      all: PortForward[];
      killed: boolean;
      exit(): void;
    }[],
  };
  const freePorts = [...(opts.ports ?? [61000, 61001])];
  const deps: TunnelDeps = {
    readManifest: async () => {
      if (state.manifestError) throw state.manifestError;
      return manifest(state.remotePort, state.terminalPort);
    },
    // `localPort`/`remotePort` are the first (tRPC) forward; `all` is every -L.
    openForward: (_target, forwards) => {
      let onExit = () => {};
      const { localPort, remotePort } = forwards[0];
      const record = { localPort, remotePort, all: forwards, killed: false, exit: () => onExit() };
      state.forwards.push(record);
      const proc: ForwardProcess = {
        onExit: (cb) => {
          onExit = cb;
        },
        kill: () => {
          record.killed = true;
        },
      };
      return proc;
    },
    // The forward only "works" while it targets the port the host is really on.
    probe: async () => {
      const live = state.forwards.findLast((f) => !f.killed);
      return state.answers && live?.remotePort === state.remotePort;
    },
    freePort: async () => freePorts.shift() ?? 0,
    // Yield a macrotask so a tight retry loop cannot starve the test timers.
    delay: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
  return { state, deps };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("SshTunnel", () => {
  test("forwards a fixed local port to the remote host's tRPC port", async () => {
    const { state, deps } = world({ remotePort: 46221 });
    const tunnel = new SshTunnel("me@vm", deps);

    const m = await tunnel.start();

    expect(m.token).toBe("tok");
    expect(tunnel.localPort).toBe(61000);
    expect(state.forwards).toMatchObject([{ localPort: 61000, remotePort: 46221 }]);
    tunnel.stop();
  });

  test("also forwards the host's terminal WebSocket port, in the same ssh process", async () => {
    const { state, deps } = world({ remotePort: 46221, terminalPort: 46300 });
    const tunnel = new SshTunnel("me@vm", deps);

    const m = await tunnel.start();

    expect(m.terminalPort).toBe(46300);
    expect(tunnel.terminalLocalPort).toBe(61001);
    expect(state.forwards).toHaveLength(1);
    expect(state.forwards[0].all).toEqual([
      { localPort: 61000, remotePort: 46221 },
      { localPort: 61001, remotePort: 46300 },
    ]);
    tunnel.stop();
  });

  test("a host without a terminal port gets only the tRPC forward", async () => {
    const { state, deps } = world({ remotePort: 46221 });
    const tunnel = new SshTunnel("me@vm", deps);
    await tunnel.start();

    expect(state.forwards[0].all).toEqual([{ localPort: 61000, remotePort: 46221 }]);
    tunnel.stop();
  });

  test("never reuses the tRPC local port for the terminal forward", async () => {
    const { deps } = world({ ports: [61000, 61000, 61002] });
    const tunnel = new SshTunnel("me@vm", deps);
    await tunnel.start();

    expect(tunnel.localPort).toBe(61000);
    expect(tunnel.terminalLocalPort).toBe(61002);
    tunnel.stop();
  });

  test("start rejects with the manifest error and leaves nothing running", async () => {
    const { state, deps } = world();
    state.manifestError = new Error("no OpenRecruit host is running there");

    await expect(new SshTunnel("me@vm", deps).start()).rejects.toThrow("no OpenRecruit host");
    expect(state.forwards).toEqual([]);
  });

  test("start rejects and kills the forward when the host never answers", async () => {
    const { state, deps } = world({ answers: false });

    await expect(new SshTunnel("me@vm", deps).start()).rejects.toThrow("did not answer");
    expect(state.forwards.map((f) => f.killed)).toEqual([true]);
  });

  test("when ssh exits it reconnects on the same local port", async () => {
    const { state, deps } = world();
    const tunnel = new SshTunnel("me@vm", deps);
    await tunnel.start();

    state.forwards[0].exit();
    await settle();

    expect(state.forwards).toHaveLength(2);
    expect(state.forwards[1].localPort).toBe(61000);
    tunnel.stop();
  });

  test("a restarted host (new remote ports) is picked up after two missed health checks", async () => {
    const { state, deps } = world({ remotePort: 5000, terminalPort: 6000 });
    const tunnel = new SshTunnel("me@vm", deps);
    await tunnel.start();

    state.remotePort = 5001; // host restarted; ssh itself is still up
    state.terminalPort = 6001;
    await tunnel.checkHealth();
    expect(state.forwards).toHaveLength(1); // one miss is not enough
    await tunnel.checkHealth();
    await settle();

    expect(state.forwards[0].killed).toBe(true);
    // Same local ports (baked into the renderer), re-pointed at the new remote ones.
    expect(state.forwards[1].all).toEqual([
      { localPort: 61000, remotePort: 5001 },
      { localPort: 61001, remotePort: 6001 },
    ]);
    tunnel.stop();
  });

  test("keeps retrying while the machine is unreachable, then recovers", async () => {
    const { state, deps } = world();
    const tunnel = new SshTunnel("me@vm", deps);
    await tunnel.start();

    state.manifestError = new Error("offline");
    state.forwards[0].exit();
    await settle();
    expect(state.forwards).toHaveLength(1);

    state.manifestError = null;
    await settle();
    expect(state.forwards).toHaveLength(2);
    tunnel.stop();
  });

  test("stop kills the forward and does not reconnect", async () => {
    const { state, deps } = world();
    const tunnel = new SshTunnel("me@vm", deps);
    await tunnel.start();

    tunnel.stop();
    state.forwards[0].exit();
    await settle();

    expect(state.forwards).toHaveLength(1);
    expect(state.forwards[0].killed).toBe(true);
  });
});
