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
  test("persists the guided Scout setup as structured recruiting configuration", async () => {
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
      idempotencyKey: "guided-scout-profile-import",
    });
    const profile = recruiting.confirmProfile({
      profileId: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: "guided-scout-profile-confirm",
    });
    const caller = appRouter.createCaller({ registry, recruiting } as Context);

    const agent = await caller.agents.create({
      name: "Developer Tools Scout",
      template: "dca",
      harness: "claude",
      defaultProfileId: profile.id,
      scoutSetup: {
        targetRoles: ["Product Engineer", "Developer Experience Engineer"],
        discoveryAngles: ["direct_openings", "early_stage"],
        locations: ["Remote — US"],
        sourceIds: [WEB_SEARCH_SOURCE_ID],
        listingLookbackDays: 30,
        signalLookbackDays: 7,
        verificationHours: 24,
        effort: "balanced",
        focus: "precision",
        includeInferredOpportunities: true,
        revisitCadence: "weekly",
        runCadence: "manual",
        runTime: "09:00",
        additionalGuidance: "Prefer developer-tool companies.",
      },
    });

    const scout = recruiting.getScout(recruiting.resolveScoutForAgent(agent.id) ?? "");
    expect(scout).toMatchObject({
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      defaultProfileId: profile.id,
    });
    expect(scout?.strategyMaterial).toContain("Developer Experience Engineer");
    expect(scout?.strategyMaterial).toContain("early-stage companies");
    expect(scout?.policyMaterial).toContain("30 days");
    expect(scout?.policyMaterial).toContain("24 hours");
    expect(scout?.policyMaterial).toContain("Never message, post, reply, apply");
  });

  test("creates a durable wake schedule for a recurring guided Scout", async () => {
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
      name: "Scheduled Profile",
      roleTarget: "AI Engineer",
      cvText: "Built AI systems.",
      careerInterests: "Applied AI",
      idempotencyKey: "scheduled-scout-profile-import",
    });
    const profile = recruiting.confirmProfile({
      profileId: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: "scheduled-scout-profile-confirm",
    });
    const created: Array<{
      agentId: string;
      input: { cron: string; prompt: string; recurring: boolean };
    }> = [];
    const scheduler = {
      createCron: (agentId: string, input: (typeof created)[number]["input"]) => {
        created.push({ agentId, input });
      },
    };
    const caller = appRouter.createCaller({ registry, recruiting, scheduler } as Context);

    const agent = await caller.agents.create({
      name: "Daily AI Scout",
      harness: "claude",
      defaultProfileId: profile.id,
      scoutSetup: {
        targetRoles: ["AI Engineer"],
        discoveryAngles: ["direct_openings"],
        locations: [],
        sourceIds: [WEB_SEARCH_SOURCE_ID],
        listingLookbackDays: 30,
        signalLookbackDays: 7,
        verificationHours: 24,
        effort: "balanced",
        focus: "balanced",
        includeInferredOpportunities: false,
        revisitCadence: "never",
        runCadence: "daily",
        runTime: "09:30",
        additionalGuidance: "",
      },
    });

    expect(created).toEqual([
      {
        agentId: agent.id,
        input: {
          cron: "30 9 * * *",
          prompt: expect.stringContaining("selected Sources"),
          recurring: true,
        },
      },
    ]);
  });

  test("rolls back the Scout and harness when durable scheduling fails", async () => {
    const db = memDb();
    const registry = new AgentRegistry(db);
    const recruiting = new RecruitingApplication(db, () => 10_000, {
      webSearchSettings: () => ({ configured: true, readiness: "ready", safeFailure: null }),
    });
    const draft = recruiting.importProfile({
      name: "Rollback Profile",
      roleTarget: "AI Engineer",
      cvText: "Built AI systems.",
      careerInterests: "Applied AI",
      idempotencyKey: "rollback-scout-profile-import",
    });
    const profile = recruiting.confirmProfile({
      profileId: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: "rollback-scout-profile-confirm",
    });
    const scheduler = {
      createCron: () => {
        throw new Error("scheduler unavailable");
      },
    };
    const caller = appRouter.createCaller({ registry, recruiting, scheduler } as Context);

    await expect(
      caller.agents.create({
        name: "Rollback Scout",
        harness: "claude",
        defaultProfileId: profile.id,
        scoutSetup: {
          ...createGuidedSetup(),
          sourceIds: [WEB_SEARCH_SOURCE_ID],
          runCadence: "daily",
        },
      }),
    ).rejects.toThrow("scheduler unavailable");

    expect(registry.list()).toHaveLength(0);
    expect(recruiting.listScouts()).toHaveLength(0);
  });

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

function createGuidedSetup() {
  return {
    targetRoles: ["AI Engineer"],
    discoveryAngles: ["direct_openings"] as const,
    locations: [],
    sourceIds: [] as string[],
    listingLookbackDays: 30,
    signalLookbackDays: 7,
    verificationHours: 24,
    effort: "balanced" as const,
    focus: "balanced" as const,
    includeInferredOpportunities: false,
    revisitCadence: "never" as const,
    runCadence: "manual" as const,
    runTime: "09:00",
    additionalGuidance: "",
  };
}
