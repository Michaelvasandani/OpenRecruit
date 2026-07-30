import { describe, expect, test } from "bun:test";
import type { OrderStatus } from "@shared/broker";
import { isTerminal, orderNotification, terminalTransition } from "./order-notify";

const order = (over: Partial<OrderStatus> & { id: string }): OrderStatus => ({
  symbol: "AAPL",
  side: "buy",
  type: "market",
  state: "confirmed",
  quantity: 2,
  cumulativeQuantity: null,
  avgPrice: null,
  limitPrice: null,
  fees: null,
  dollarAmount: null,
  createdAt: null,
  lastTransactionAt: null,
  ...over,
});

describe("isTerminal", () => {
  test("terminal states (any casing)", () => {
    for (const s of [
      "filled",
      "REJECTED",
      "Cancelled",
      "canceled",
      "failed",
      "expired",
      "voided",
    ]) {
      expect(isTerminal(s)).toBe(true);
    }
  });
  test("non-terminal / unknown states", () => {
    for (const s of ["confirmed", "queued", "partially_filled", "new", "weird", null]) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe("terminalTransition", () => {
  test("in-flight → terminal notifies", () => {
    expect(
      terminalTransition(
        order({ id: "1", state: "confirmed" }),
        order({ id: "1", state: "filled" }),
      ),
    ).toBe(true);
  });
  test("terminal → terminal is suppressed (absorbing, dedupes)", () => {
    expect(
      terminalTransition(order({ id: "1", state: "filled" }), order({ id: "1", state: "filled" })),
    ).toBe(false);
  });
  test("prev undefined + terminal notifies (appeared already-terminal between polls)", () => {
    expect(terminalTransition(undefined, order({ id: "1", state: "filled" }))).toBe(true);
  });
  test("prev undefined + non-terminal does not notify", () => {
    expect(terminalTransition(undefined, order({ id: "1", state: "queued" }))).toBe(false);
  });
  test("in-flight → in-flight does not notify", () => {
    expect(
      terminalTransition(
        order({ id: "1", state: "queued" }),
        order({ id: "1", state: "confirmed" }),
      ),
    ).toBe(false);
  });
});

describe("orderNotification", () => {
  test("filled order carries the fill price", () => {
    const n = orderNotification(
      order({ id: "1", side: "buy", cumulativeQuantity: 2, avgPrice: 182.34, state: "filled" }),
      "Momentum Bot",
      "agent-1",
    );
    expect(n.kind).toBe("order");
    expect(n.title).toBe("Order filled — Momentum Bot");
    expect(n.body).toBe("BUY 2 AAPL — filled at $182.34");
    expect(n.agentId).toBe("agent-1");
  });
  test("rejected order has no price", () => {
    const n = orderNotification(
      order({ id: "1", side: "sell", state: "rejected", avgPrice: null }),
      "Bot",
    );
    expect(n.body).toBe("SELL 2 AAPL — rejected");
  });
  test("dollar-based order uses the notional", () => {
    const n = orderNotification(
      order({
        id: "1",
        side: "buy",
        quantity: null,
        cumulativeQuantity: null,
        dollarAmount: 100,
        state: "filled",
        avgPrice: 50,
      }),
      null,
    );
    expect(n.body).toBe("BUY $100 AAPL — filled at $50");
    expect(n.title).toBe("Order filled — agent");
  });
  test("null fields fall back gracefully", () => {
    const n = orderNotification(
      order({
        id: "1",
        side: null,
        symbol: null,
        quantity: null,
        cumulativeQuantity: null,
        state: "cancelled",
      }),
      null,
    );
    expect(n.body).toBe("ORDER order — cancelled");
  });
  test("fractional fills trim trailing zeros", () => {
    const n = orderNotification(
      order({
        id: "1",
        side: "buy",
        cumulativeQuantity: 0.880592,
        avgPrice: 85.18,
        state: "filled",
      }),
      "Bot",
    );
    expect(n.body).toBe("BUY 0.880592 AAPL — filled at $85.18");
  });
});
