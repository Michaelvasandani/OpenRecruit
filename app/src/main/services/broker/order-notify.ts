import type { OrderStatus } from "@shared/broker";
import type { HostNotification } from "@shared/notify";

/**
 * RH lifecycle states that are *absorbing* — an order never leaves them. Matched
 * case-insensitively; an unknown state simply never notifies (fail-quiet). Kept in
 * one place so extending the list is a one-line change.
 */
const TERMINAL_STATES = new Set([
  "filled",
  "rejected",
  "cancelled",
  "canceled",
  "failed",
  "expired",
  "voided",
]);

export function isTerminal(state: string | null): boolean {
  return state !== null && TERMINAL_STATES.has(state.toLowerCase());
}

/**
 * True when `next` has just *entered* a terminal state — i.e. an order-execution
 * notification is due. `prev === undefined` means the order appeared already
 * terminal between polls (genuinely new, worth notifying); a `prev` that was
 * already terminal is suppressed (terminal states are absorbing, so this also
 * dedupes across polls and suppresses the startup full-sweep, which seeds every
 * pre-existing terminal order before the recent-window diff runs).
 */
export function terminalTransition(prev: OrderStatus | undefined, next: OrderStatus): boolean {
  return isTerminal(next.state) && !(prev !== undefined && isTerminal(prev.state));
}

/** Human verb for a terminal state (drives both the title and body). */
function verbFor(state: string | null): string {
  switch ((state ?? "").toLowerCase()) {
    case "filled":
      return "filled";
    case "rejected":
      return "rejected";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "expired":
      return "expired";
    case "voided":
      return "voided";
    default:
      return "failed";
  }
}

/** "2 AAPL" / "$100 AAPL" / "AAPL" — quantity clause of the body. */
function quantityClause(o: OrderStatus): string {
  const shares = o.cumulativeQuantity ?? o.quantity;
  const sym = o.symbol ?? "";
  if (shares != null && shares > 0) return `${trimNum(shares)} ${sym}`.trim();
  if (o.dollarAmount != null && o.dollarAmount > 0)
    return `$${trimNum(o.dollarAmount)} ${sym}`.trim();
  return sym || "order";
}

/** Drop trailing zeros from a fractional quantity/price without losing precision. */
function trimNum(n: number): string {
  return Number(n.toFixed(6)).toString();
}

/**
 * Format an order-execution notification. Body reads like
 * `"BUY 2 AAPL — filled at $182.34"`; price is included only for fills (via
 * `avgPrice`). Title is `"<agent> — Order filled"`.
 */
export function orderNotification(
  o: OrderStatus,
  agentName: string | null,
  agentId?: string,
): HostNotification {
  const verb = verbFor(o.state);
  const side = o.side ? o.side.toUpperCase() : "ORDER";
  const priced = verb === "filled" && o.avgPrice != null ? ` at $${trimNum(o.avgPrice)}` : "";
  return {
    kind: "order",
    title: `${agentName ?? "agent"} — Order ${verb}`,
    body: `${side} ${quantityClause(o)} — ${verb}${priced}`,
    agentId,
  };
}
