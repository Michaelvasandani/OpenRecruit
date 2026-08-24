import { expect, test } from "bun:test";
import { Agent, AgentStatus, CreateAgentInput } from "./agent";
import * as analytics from "./analytics";

test("agent contracts exclude inherited approval state", () => {
  expect(AgentStatus.safeParse("awaiting-approval").success).toBe(false);
  expect(Agent.shape).not.toHaveProperty("approvalMode");
  expect(CreateAgentInput.shape).not.toHaveProperty("approvalMode");
  expect(
    CreateAgentInput.safeParse({
      name: "Scout",
      template: "default",
      harness: "claude",
      approvalMode: "auto",
    }).success,
  ).toBe(false);
  expect(
    Agent.safeParse({
      id: "a",
      slug: "scout",
      name: "Scout",
      template: "default",
      harness: "claude",
      approvalMode: "auto",
      lastSessionId: null,
      status: "idle",
      executionState: "offline",
      headlessTurnsUsed: 0,
      turnLimitEnabled: true,
      lastActiveAt: null,
      createdAt: 0,
      archivedAt: null,
    }).success,
  ).toBe(false);
});

test("analytics contracts exclude inherited order, broker, and approval surfaces", () => {
  for (const event of [
    "order_gate_prompted",
    "order_gate_decided",
    "order_submit_resolved",
    "broker_connect_started",
    "broker_connected",
    "broker_connect_failed",
    "broker_offline",
    "broker_online",
  ]) {
    expect(analytics.TELEMETRY_EVENTS).not.toHaveProperty(event);
  }
  expect(analytics.ErrorSubsystem.safeParse("broker").success).toBe(false);
  expect(analytics.ErrorSubsystem.safeParse("approvals").success).toBe(false);
  for (const helper of ["assetTypeOf", "sideOf", "orderTypeOf", "orderKindOf"]) {
    expect(analytics).not.toHaveProperty(helper);
  }
});
