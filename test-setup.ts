/**
 * Test bootstrap: give the suite its own OPENTRADE_HOME.
 *
 * `OPENTRADE_HOME` defaults to `~/.opentrade` — the *production* home — and is captured
 * at module load (`db/client.ts`), so it has to be set before anything imports it. That
 * is why this runs as a bunfig `[test] preload` rather than a `beforeAll`.
 *
 * Without it, any module under test that logs through `hostLog` appends to the real
 * `~/.opentrade/host.log`: a `bun test` run leaves fixture lines ("host crash" recovery,
 * declined gate prompts, dropped analytics events) in the log a user or maintainer reads
 * to diagnose a live incident, indistinguishable from things the app actually did.
 *
 * Set unconditionally: an inherited OPENTRADE_HOME (a dev instance, a `dev.sh` shell)
 * would otherwise point the suite at that instance's real state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "opentrade-test-"));
process.env.OPENTRADE_HOME = home;

process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // best-effort: a leftover temp dir is harmless, and throwing here would fail the run
  }
});

/**
 * A host provisioned with `APOLLO_API_KEY` (a VM, a cloud dev container) must not
 * leak that key into unit tests: SettingsService would read it as the effective
 * Apollo key and every "empty store" expectation would change. The opt-in live
 * Apollo test reads it from `OPENRECRUIT_LIVE_APOLLO_API_KEY` instead.
 */
if (process.env.APOLLO_API_KEY) {
  process.env.OPENRECRUIT_LIVE_APOLLO_API_KEY ??= process.env.APOLLO_API_KEY;
  delete process.env.APOLLO_API_KEY;
}
