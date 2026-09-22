import { describe, expect, test } from "bun:test";
import type { HostManifest } from "../host/manifest";
import { type ForwardProcess, SshTunnel, type TunnelDeps } from "./tunnel";

const manifest = (trpcPort: number): HostManifest => ({
  pid: 4242,
  faucetPort: 29000,
  trpcPort,
  token: "tok",
  startedAt: 1,
  version: "0.2.5",
});

/** A scriptable world: which remote port the host is on, and whether it answers. */
function world(opts: { remotePort?: number; answers?: boolean } = {}) {
  const state = {
    remotePort: opts.remotePort ?? 5000,
    answers: opts.answers ?? true,
    manifestError: null as Error | null,
    forwards: [] as { localPort: number; remotePort: number; killed: boolean; exit(): void }[],
  };
  const deps: TunnelDeps = {
    readManifest: async () => {
      if (state.manifestError) throw state.manifestError;
      return manifest(state.remotePort);
    },
    openForward: (_target, localPort, remotePort) => {
      let onExit = () => {};
      const record = { localPort, remotePort, killed: false, exit: () => onExit() };
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
    freePort: async () => 61000,
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

  test("a restarted host (new remote port) is picked up after two missed health checks", async () => {
    const { state, deps } = world({ remotePort: 5000 });
    const tunnel = new SshTunnel("me@vm", deps);
    await tunnel.start();

    state.remotePort = 5001; // host restarted; ssh itself is still up
    await tunnel.checkHealth();
    expect(state.forwards).toHaveLength(1); // one miss is not enough
    await tunnel.checkHealth();
    await settle();

    expect(state.forwards[0].killed).toBe(true);
    expect(state.forwards[1]).toMatchObject({ localPort: 61000, remotePort: 5001 });
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
