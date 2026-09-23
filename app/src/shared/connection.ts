import { z } from "zod";

/**
 * Where the desktop app's backend host lives. "local" is the default: the launcher
 * adopts-or-spawns a host on this machine. "remote" points the same window at a host
 * running on another machine (a VM under systemd — see deploy/), reached through an
 * SSH port-forward the launcher owns, so the remote host keeps binding loopback only.
 *
 * This is LAUNCHER state, not host state: it has to be known before any host is
 * reachable, so it lives in `connection.json` beside the local manifest and rides
 * `ipcRenderer` (like shared/shell.ts) rather than tRPC.
 */

/**
 * An ssh destination: `host`, `user@host`, or a `~/.ssh/config` alias. Deliberately
 * narrow — the value becomes an `ssh` argv entry, and anything starting with `-`
 * would be parsed as an option (`-oProxyCommand=…` is arbitrary command execution).
 * Ports, jump hosts and identity files belong in `~/.ssh/config` behind an alias.
 */
const SSH_TARGET = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export const sshTargetSchema = z
  .string()
  .trim()
  .min(1, "Enter an SSH destination")
  .max(255)
  .regex(SSH_TARGET, "Use host, user@host, or an alias from ~/.ssh/config");

export const connectionConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local") }),
  z.object({ mode: z.literal("remote"), sshTarget: sshTargetSchema }),
]);
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;

export const LOCAL_CONNECTION: ConnectionConfig = { mode: "local" };

/** What the launcher tells the renderer about the connection it booted with. */
export interface ConnectionStatus {
  config: ConnectionConfig;
  /** Why the remote host could not be reached at boot (remote mode only). */
  error?: string;
  /** Version the connected remote host reports; the tRPC contract is only
   *  guaranteed to match when it equals `appVersion`. */
  hostVersion?: string;
  appVersion: string;
}

export type ConnectionTestResult = { ok: true; hostVersion: string } | { ok: false; error: string };

export const CONNECTION_IPC = {
  /** invoke → ConnectionStatus */
  status: "connection:status",
  /** invoke(sshTarget) → ConnectionTestResult: can we reach a running host there? */
  test: "connection:test",
  /** invoke(ConnectionConfig) → persists it and relaunches the app to apply it. */
  apply: "connection:apply",
} as const;
