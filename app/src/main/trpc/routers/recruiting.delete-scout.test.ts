import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import * as schema from "../../db/schema";
import { AgentRegistry } from "../../services/agents/registry";
import { RecruitingApplication } from "../../services/recruiting";
import type { Context } from "../trpc";
import { appRouter } from ".";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(SCHEMA_DDL);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

async function setup() {
  const db = memDb();
  const registry = new AgentRegistry(db);
  const recruiting = new RecruitingApplication(db, () => 10_000, {
    webSearchSettings: () => ({ configured: true, readiness: "ready", safeFailure: null }),
  });
  const draft = recruiting.importProfile({
    name: "Primary Profile",
    roleTarget: "Product Engineer",
    cvText: "Built recruiting systems.",
    careerInterests: "Developer tools",
    idempotencyKey: "delete-scout-profile-import",
  });
  const profile = recruiting.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: "delete-scout-profile-confirm",
  });
  const teardown: string[] = [];
  const caller = appRouter.createCaller({
    registry,
    recruiting,
    terminal: { kill: (id: string) => teardown.push(`kill:${id}`) },
    wake: { stop: (id: string) => teardown.push(`stop:${id}`) },
    scheduler: {
      createCron: () => {},
      removeAgent: (id: string) => teardown.push(`unschedule:${id}`),
    },
  } as unknown as Context);
  const agent = await caller.agents.create({
    name: "Doomed Scout",
    harness: "claude",
    defaultProfileId: profile.id,
  });
  const scoutId = recruiting.resolveScoutForAgent(agent.id) ?? "";
  return { registry, recruiting, caller, agent, scoutId, teardown };
}

describe("recruiting.deleteScout", () => {
  test("archives the Scout and retires its harness and schedules", async () => {
    const { registry, recruiting, caller, agent, scoutId, teardown } = await setup();

    await caller.recruiting.deleteScout({ scoutId });

    expect(recruiting.listScouts().map((s) => s.id)).not.toContain(scoutId);
    expect(recruiting.getScout(scoutId)?.lifecycleState).toBe("archived");
    expect(registry.list().map((a) => a.id)).not.toContain(agent.id);
    expect(teardown).toEqual([`kill:${agent.id}`, `stop:${agent.id}`, `unschedule:${agent.id}`]);
  });

  test("cancels the active Run before archiving", async () => {
    const { recruiting, caller, scoutId } = await setup();
    const run = recruiting.launchScoutRun({ scoutId, idempotencyKey: "delete-scout-run" }).value;

    await caller.recruiting.deleteScout({ scoutId });

    expect(recruiting.getScoutRun(run.id)?.status).toBe("cancelled");
    expect(recruiting.getScout(scoutId)?.lifecycleState).toBe("archived");
  });

  test("is a no-op for a Scout that is already deleted", async () => {
    const { caller, scoutId } = await setup();
    await caller.recruiting.deleteScout({ scoutId });
    await caller.recruiting.deleteScout({ scoutId });
  });

  test("rejects an unknown Scout", async () => {
    const { caller } = await setup();
    await expect(caller.recruiting.deleteScout({ scoutId: "nope" })).rejects.toThrow();
  });
});
