import { errorCodeOf } from "@shared/analytics";

/** "The network is not there right now" — DNS, connect/reset/timeout, unreachable, undici's own. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Is this failure a transient network outage — what a laptop produces around
 * sleep/wake, a Wi‑Fi handoff, a VPN flap — as opposed to a bug, a protocol error, or
 * the server rejecting us? True for a code in the set above (on the error or, as undici
 * does it, on its `cause`) and for a bare `TypeError: fetch failed` whose cause we don't
 * recognize (still transport-level, never app logic; nothing in our bundle produces that
 * message). Anything else — a mapping TypeError from our code, an `McpError`, an HTTP
 * error class — is not transient and stays an `app_error`.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const code = errorCodeOf(err);
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return err instanceof TypeError && err.message === "fetch failed";
}
