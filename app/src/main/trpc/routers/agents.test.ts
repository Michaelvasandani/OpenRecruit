import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import * as schema from "../../db/schema";
import { AgentRegistry } from "../../services/agents/registry";
import { RecruitingApplication, WEB_SEARCH_SOURCE_ID } from "../../services/recruiting";
import type { Context } from "../trpc";
import { appRouter } from ".";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(SCHEMA_DDL);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

describe("agents.create New Scout flow", () => {
  test("creates and binds the recruiting Scout with its Profile and Web Search Source", async () => {
    const db = memDb();
    const registry = new AgentRegistry(db);
    const recruiting = new RecruitingApplication(db, () => 10_000, {
      webSearchSettings: () => ({
        configured: true,
        readiness: "ready",
        safeFailure: null,
      }),
    });
    const draft = recruiting.importProfile({
      name: "Primary Profile",
      roleTarget: "Product Engineer",
      cvText: "Built recruiting systems.",
      careerInterests: "Developer tools",
      idempotencyKey: "new-scout-profile-import",
    });
    const profile = recruiting.confirmProfile({
      profileId: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: "new-scout-profile-confirm",
    });
    const caller = appRouter.createCaller({ registry, recruiting } as Context);

    const agent = await caller.agents.create({
      name: "Web Scout",
      template: "default",
      harness: "claude",
      defaultProfileId: profile.id,
    });

    const scoutId = recruiting.resolveScoutForAgent(agent.id);
    expect(scoutId).not.toBeNull();
    expect(recruiting.getScout(scoutId ?? "")).toMatchObject({
      name: "Web Scout",
      harness: "claude",
      defaultProfileId: profile.id,
      legacyAgentId: agent.id,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
    });
  });

  test("does not leave an orphaned harness when recruiting Scout creation fails", async () => {
    const db = memDb();
    const registry = new AgentRegistry(db);
    const recruiting = new RecruitingApplication(db, () => 10_000, {
      webSearchSettings: () => ({
        configured: true,
        readiness: "ready",
        safeFailure: null,
      }),
    });
    const caller = appRouter.createCaller({ registry, recruiting } as Context);

    await expect(
      caller.agents.create({
        name: "Missing Profile Scout",
        template: "default",
        harness: "claude",
      }),
    ).rejects.toThrow(/default confirmed Candidate Profile/);

    expect(registry.list()).toHaveLength(0);
    expect(recruiting.listScouts()).toHaveLength(0);
  });
});
