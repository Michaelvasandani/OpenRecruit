import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  BIRD_COOKIE_ACCESS_WARNING,
  BIRD_INVALID_SIGNATURE_WARNING,
  type BirdAccountIdentity,
  type BirdReadiness,
} from "@shared/settings";

export const BIRD_SUPPORTED_VERSION = "0.8.0";
export const BIRD_PROCESS_TIMEOUT_MS = 20_000;
export const BIRD_OUTPUT_LIMIT_BYTES = 2_000_000;

const BIRD_WORKING_DIRECTORY = process.env.OPENTRADE_HOME?.trim() || join(homedir(), ".opentrade");
const STRIPPED_ENV_KEYS = new Set(["AUTH_TOKEN", "CT0", "TWITTER_AUTH_TOKEN", "TWITTER_CT0"]);

export type BirdExecutableIdentity = {
  configuredPath: string;
  resolvedPath: string;
  fingerprint: string;
};

export type BirdProbeResult = BirdExecutableIdentity & {
  readiness: BirdReadiness;
  safeFailure: string | null;
  detectedVersion: string | null;
  accountIdentity: BirdAccountIdentity | null;
};

/** Internal result from a single allowlisted process call. Its output never
 * leaves this module; callers only inspect it to derive safe metadata. */
type BirdCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputExceededLimit: boolean;
  timedOut: boolean;
  spawnError: boolean;
};

/** Resolve and fingerprint a configured executable without invoking Bird. */
export function inspectBirdExecutable(configuredPath: string): BirdExecutableIdentity {
  const normalized = normalizeBirdPath(configuredPath);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(normalized);
  } catch {
    throw new BirdProbeError("not_executable", "The configured Bird path does not exist");
  }
  if (!stat.isFile()) {
    throw new BirdProbeError(
      "not_executable",
      "The configured Bird path is not an executable file",
    );
  }
  try {
    accessSync(normalized, fsConstants.X_OK);
  } catch {
    throw new BirdProbeError("not_executable", "The configured Bird path is not executable");
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(normalized);
  } catch {
    throw new BirdProbeError(
      "not_executable",
      "The configured Bird executable could not be resolved",
    );
  }
  let fingerprint: string;
  try {
    fingerprint = createHash("sha256").update(readExecutableBytes(resolvedPath)).digest("hex");
  } catch {
    throw new BirdProbeError("degraded", "The Bird executable could not be fingerprinted");
  }
  return { configuredPath: normalized, resolvedPath, fingerprint };
}

/**
 * Run the read-only Bird setup contract. This function intentionally contains
 * no search/read/write route: setup invokes only `--version`, `check`, and
 * `whoami`, directly and without a shell.
 */
export async function probeBirdExecutable(configuredPath: string): Promise<BirdProbeResult> {
  let executable: BirdExecutableIdentity;
  try {
    executable = inspectBirdExecutable(configuredPath);
  } catch (error) {
    if (error instanceof BirdProbeError) {
      return {
        configuredPath: safePath(configuredPath),
        resolvedPath: "",
        fingerprint: "",
        readiness: error.readiness,
        safeFailure: error.safeFailure,
        detectedVersion: null,
        accountIdentity: null,
      };
    }
    return failedProbe(configuredPath, "The Bird executable could not be inspected");
  }

  const versionResult = await runBirdCommand(executable.resolvedPath, ["--version"]);
  const detectedVersion = parseBirdVersion(versionResult.stdout);
  if (versionResult.outputExceededLimit) {
    return {
      ...executable,
      ...unsupportedResult("Bird version output exceeded the bounded limit"),
    };
  }
  if (versionResult.timedOut) {
    return { ...executable, ...unsupportedResult("Bird version check timed out") };
  }
  if (versionResult.spawnError || versionResult.exitCode !== 0 || !detectedVersion) {
    return {
      ...executable,
      ...unsupportedResult("Bird version could not be detected safely"),
      detectedVersion,
    };
  }
  if (detectedVersion !== BIRD_SUPPORTED_VERSION) {
    return {
      ...executable,
      readiness: "unsupported",
      safeFailure: `Bird ${detectedVersion} is unsupported; OpenRecruit requires Bird ${BIRD_SUPPORTED_VERSION}`,
      detectedVersion,
      accountIdentity: null,
    };
  }

  const checkResult = await runBirdCommand(executable.resolvedPath, ["check"]);
  if (checkResult.outputExceededLimit) {
    return {
      ...executable,
      readiness: "degraded",
      safeFailure: "Bird readiness output exceeded the bounded limit",
      detectedVersion,
      accountIdentity: null,
    };
  }
  if (checkResult.timedOut) {
    return {
      ...executable,
      readiness: "degraded",
      safeFailure: "Bird readiness check timed out",
      detectedVersion,
      accountIdentity: null,
    };
  }
  if (checkResult.spawnError || checkResult.exitCode !== 0) {
    return {
      ...executable,
      readiness: readinessForFailure(checkResult.stdout, checkResult.stderr),
      safeFailure: safeFailureForCheck(checkResult.stdout, checkResult.stderr),
      detectedVersion,
      accountIdentity: null,
    };
  }

  const whoamiResult = await runBirdCommand(executable.resolvedPath, ["whoami"]);
  if (whoamiResult.outputExceededLimit) {
    return {
      ...executable,
      readiness: "degraded",
      safeFailure: "Bird account output exceeded the bounded limit",
      detectedVersion,
      accountIdentity: null,
    };
  }
  if (whoamiResult.timedOut) {
    return {
      ...executable,
      readiness: "degraded",
      safeFailure: "Bird account check timed out",
      detectedVersion,
      accountIdentity: null,
    };
  }
  if (whoamiResult.spawnError || whoamiResult.exitCode !== 0) {
    return {
      ...executable,
      readiness: readinessForFailure(whoamiResult.stdout, whoamiResult.stderr),
      safeFailure: safeFailureForWhoami(whoamiResult.stdout, whoamiResult.stderr),
      detectedVersion,
      accountIdentity: null,
    };
  }

  const accountIdentity = parseBirdAccountIdentity(whoamiResult.stdout);
  if (!accountIdentity || (!accountIdentity.id && !accountIdentity.username)) {
    return {
      ...executable,
      readiness: "reauthentication_required",
      safeFailure: "Bird did not report an authenticated public X account",
      detectedVersion,
      accountIdentity: null,
    };
  }
  return {
    ...executable,
    readiness: "ready",
    safeFailure: null,
    detectedVersion,
    accountIdentity,
  };
}

export class BirdProbeError extends Error {
  constructor(
    readonly readiness: Extract<BirdReadiness, "invalid_path" | "not_executable" | "degraded">,
    readonly safeFailure: string,
  ) {
    super(safeFailure);
    this.name = "BirdProbeError";
  }
}

function normalizeBirdPath(value: string): string {
  const normalized = value.trim();
  const control = [...normalized].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!normalized || normalized.length > 4_096 || control || !isAbsolute(normalized)) {
    throw new BirdProbeError("invalid_path", "Bird executable path must be an absolute path");
  }
  return normalized;
}

function safePath(value: string): string {
  try {
    return normalizeBirdPath(value);
  } catch {
    return value.trim().slice(0, 4_096);
  }
}

function readExecutableBytes(path: string): Buffer {
  // `readFileSync` is kept behind this tiny helper so executable inspection is
  // the only place where the binary is read; no bytes cross the settings seam.
  // eslint/biome accepts the node import below without enabling a shell route.
  return readFileSync(path);
}

async function runBirdCommand(
  executable: string,
  args: readonly ["--version"] | readonly ["check"] | readonly ["whoami"],
): Promise<BirdCommandResult> {
  mkdirSync(BIRD_WORKING_DIRECTORY, { recursive: true });
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputExceededLimit = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, [...args], {
      cwd: BIRD_WORKING_DIRECTORY,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      resolveOnce({
        exitCode: null,
        stdout: "",
        stderr: "",
        outputExceededLimit,
        timedOut,
        spawnError: false,
      });
    }, BIRD_PROCESS_TIMEOUT_MS);

    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = String(chunk);
      const nextLength =
        Buffer.byteLength(stdout, "utf8") +
        Buffer.byteLength(stderr, "utf8") +
        Buffer.byteLength(text, "utf8");
      if (nextLength > BIRD_OUTPUT_LIMIT_BYTES) {
        outputExceededLimit = true;
        child.kill("SIGTERM");
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", () => {
      resolveOnce({
        exitCode: null,
        stdout: "",
        stderr: "",
        outputExceededLimit,
        timedOut,
        spawnError: true,
      });
    });
    child.once("close", (code) => {
      resolveOnce({
        exitCode: code,
        stdout,
        stderr,
        outputExceededLimit,
        timedOut,
        spawnError: false,
      });
    });

    function resolveOnce(result: BirdCommandResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
  });
}

function parseBirdVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function parseBirdAccountIdentity(output: string): BirdAccountIdentity | null {
  const parsed = parseJson(output);
  const fromJson = parsed ? findIdentity(parsed, 0) : null;
  if (fromJson) return fromJson;

  const id = output.match(/(?:^|\b)(?:id|user[_ -]?id)\s*[:=]\s*([0-9]{1,64})/i)?.[1] ?? null;
  const username =
    output.match(/(?:username|handle|screen[_ -]?name)\s*[:=]\s*@?([A-Za-z0-9_]{1,30})/i)?.[1] ??
    output.match(/(^|\s)@([A-Za-z0-9_]{1,30})\b/)?.[2] ??
    null;
  const displayName =
    output.match(/(?:display[_ -]?name|name)\s*[:=]\s*([^\n\r]{1,160})/i)?.[1]?.trim() ?? null;
  return id || username || displayName ? { id, username, displayName } : null;
}

function findIdentity(value: unknown, depth: number): BirdAccountIdentity | null {
  if (depth > 4 || !value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id ?? record.user_id ?? record.userId, 64);
  const username =
    stringValue(record.username ?? record.handle ?? record.screen_name, 30)?.replace(/^@/, "") ??
    null;
  const displayName = stringValue(record.display_name ?? record.displayName ?? record.name, 160);
  if (id || username || displayName) return { id, username, displayName };
  for (const nested of Object.values(record)) {
    const found = findIdentity(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function stringValue(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasAuthFailure(...outputs: string[]): boolean {
  return /(?:not\s+auth|auth(?:entication|orization)?\s+(?:failed|required)|login|cookie|session|credential|sign[ -]?in)/i.test(
    outputs.join(" "),
  );
}

function readinessForFailure(stdout: string, stderr: string): BirdReadiness {
  return hasAuthFailure(stdout, stderr) ? "reauthentication_required" : "degraded";
}

function safeFailureForCheck(stdout: string, stderr: string): string {
  return hasAuthFailure(stdout, stderr)
    ? "Bird could not access an authenticated X browser session"
    : "Bird readiness check failed";
}

function safeFailureForWhoami(stdout: string, stderr: string): string {
  return hasAuthFailure(stdout, stderr)
    ? "Bird could not identify the authenticated public X account"
    : "Bird account identity check failed";
}

function unsupportedResult(
  safeFailure: string,
): Pick<BirdProbeResult, "readiness" | "safeFailure" | "detectedVersion" | "accountIdentity"> {
  return {
    readiness: "unsupported",
    safeFailure,
    detectedVersion: null,
    accountIdentity: null,
  };
}

function failedProbe(configuredPath: string, safeFailure: string): BirdProbeResult {
  return {
    configuredPath: safePath(configuredPath),
    resolvedPath: "",
    fingerprint: "",
    readiness: "degraded",
    safeFailure,
    detectedVersion: null,
    accountIdentity: null,
  };
}

export const BIRD_WARNINGS = {
  invalidSignature: BIRD_INVALID_SIGNATURE_WARNING,
  cookieAccess: BIRD_COOKIE_ACCESS_WARNING,
} as const;
