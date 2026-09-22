import type { ConnectionTestResult } from "@shared/connection";
import { useEffect, useState } from "react";
import { useConnectionStatus } from "../../lib/connection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SegmentedControl } from "./SegmentedControl";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

/**
 * Settings → Connection: which machine runs the backend host. Local is this Mac;
 * remote is a machine reached over SSH (a VM under systemd, see deploy/), where the
 * host — and so every Scout, schedule and Signal — lives instead, running whether or
 * not this Mac is on. Applying a change relaunches the app against the new host.
 */
export function ConnectionPanel() {
  const status = useConnectionStatus();
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [target, setTarget] = useState("");
  const [test, setTest] = useState<ConnectionTestResult | { pending: true } | null>(null);

  // Seed the form from the live config once it arrives.
  useEffect(() => {
    if (!status) return;
    setMode(status.config.mode);
    if (status.config.mode === "remote") setTarget(status.config.sshTarget);
  }, [status]);

  if (!status) return null;
  const bridge = window.__opentradeConnection;
  const current = status.config;
  const trimmed = target.trim();
  const dirty =
    mode !== current.mode ||
    (mode === "remote" && current.mode === "remote" ? trimmed !== current.sshTarget : false);
  const tested = test && "ok" in test && test.ok ? test : null;
  const versionMismatch =
    status.hostVersion !== undefined && status.hostVersion !== status.appVersion;

  const runTest = async () => {
    setTest({ pending: true });
    setTest((await bridge?.test(trimmed)) ?? { ok: false, error: "unavailable" });
  };
  const apply = () =>
    void bridge?.apply(
      mode === "local" ? { mode: "local" } : { mode: "remote", sshTarget: trimmed },
    );

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Backend"
        description="Scouts, schedules and everything they find live on the machine that runs the backend. A remote machine keeps running them while this Mac is off."
      >
        <SettingsRow
          label="Run the backend on"
          hint={
            current.mode === "remote"
              ? `Currently connected to ${current.sshTarget} through an SSH tunnel.`
              : "Currently running on this Mac."
          }
        >
          <SegmentedControl
            options={[
              { value: "local", label: "This Mac" },
              { value: "remote", label: "Remote machine" },
            ]}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setTest(null);
            }}
          />
        </SettingsRow>
        {mode === "remote" && (
          <SettingsRow
            label="SSH destination"
            hint="host, user@host, or an alias from ~/.ssh/config. Key-based login only: the app cannot answer password prompts. Connect once from a terminal first so the host key is known."
          >
            <div className="flex max-w-sm flex-col items-end gap-2">
              <div className="flex gap-2">
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="me@scout-vm"
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setTest(null);
                  }}
                  className="w-56"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!trimmed || (test !== null && "pending" in test)}
                  onClick={() => void runTest()}
                >
                  Test
                </Button>
              </div>
              {test && (
                <p className="text-xs text-muted-foreground">
                  {"pending" in test
                    ? "Connecting…"
                    : test.ok
                      ? `Reached an OpenRecruit host (version ${test.hostVersion}).`
                      : test.error}
                </p>
              )}
            </div>
          </SettingsRow>
        )}
        <SettingsRow
          label="Apply and relaunch"
          hint={
            mode === "remote" && !tested
              ? "Test the connection before applying."
              : "OpenRecruit restarts and connects to the selected backend."
          }
        >
          <Button type="button" disabled={!dirty || (mode === "remote" && !tested)} onClick={apply}>
            Apply
          </Button>
        </SettingsRow>
      </SettingsSection>
      {current.mode === "remote" && (
        <SettingsSection title="Remote host">
          <SettingsRow
            label="Host version"
            hint={
              versionMismatch
                ? `The remote host runs ${status.hostVersion} but this app is ${status.appVersion}. Redeploy the host (deploy/deploy.sh) so they match.`
                : "Matches this app."
            }
          >
            <span className="text-sm text-muted-foreground">{status.hostVersion ?? "unknown"}</span>
          </SettingsRow>
          <SettingsRow
            label="Interactive terminals"
            hint="Not available on a remote backend yet. Scheduled Scout runs are unaffected."
          >
            <span className="text-sm text-muted-foreground">Unavailable</span>
          </SettingsRow>
        </SettingsSection>
      )}
    </div>
  );
}
