import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { RecruitingApplication, RecruitingError } from ".";

function makeDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(SCHEMA_DDL);
  const migration: MigrationDb = {
    exec: (sql) => void sqlite.exec(sql),
    rows: (sql) => sqlite.query(sql).all(),
  };
  migrate(migration, { fresh: true });
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function confirmedProfile(app: RecruitingApplication, suffix = "one") {
  const draft = app.importProfile({
    name: `Candidate ${suffix}`,
    roleTarget: "Staff engineer",
    cvText: "Experience\nBuilt resilient systems",
    careerInterests: "Developer tools",
    idempotencyKey: `profile-import-${suffix}`,
  });
  return app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: `profile-confirm-${suffix}`,
  });
}

describe("Recruiting Scout configuration and manual Runs", () => {
  test("persists editable strategy/policy material and an explicit Source set", () => {
    const app = new RecruitingApplication(makeDb(), () => 1000);
    const profile = confirmedProfile(app);
    const source = app.createSource({
      kind: "rss",
      name: "Engineering feeds",
      idempotencyKey: "source-create-1",
    });
    const scout = app.createScout({
      name: "RSS Scout",
      harness: "claude",
      instructionPath: "agents/rss",
      strategyMaterial: "Find remote staff engineering roles.",
      policyMaterial: "Read public sources only; never contact anyone.",
      defaultProfileId: profile.id,
      sourceIds: [source.value.id],
      idempotencyKey: "scout-create-1",
    });

    expect(scout.value.strategyMaterial).toContain("remote");
    expect(scout.value.policyMaterial).toContain("never contact");
    expect(scout.value.sourceIds).toEqual([source.value.id]);

    const edited = app.updateScout({
      scoutId: scout.value.id,
      expectedRevision: scout.value.revision,
      strategyMaterial: "Find local product engineering roles.",
      policyMaterial: "Only use explicitly selected public sources.",
      sourceIds: [],
      idempotencyKey: "scout-update-1",
    });
    expect(edited.value.strategyMaterial).toContain("local");
    expect(edited.value.sourceIds).toEqual([]);
  });

  test("blocks a manual Run unless its selected Profile is confirmed and current", () => {
    const app = new RecruitingApplication(makeDb(), () => 2000);
    const source = app.createSource({
      kind: "rss",
      name: "Engineering feeds",
      idempotencyKey: "source-create-2",
    });
    const scout = app.createScout({
      name: "Draft Scout",
      harness: "codex",
      instructionPath: "agents/draft",
      idempotencyKey: "scout-create-2",
    });
    const draft = app.importProfile({
      name: "Draft Candidate",
      roleTarget: "Engineer",
      careerInterests: "Tools",
      idempotencyKey: "profile-import-draft",
    });
    expect(() =>
      app.createScout({
        name: "Draft Scout",
        harness: "codex",
        instructionPath: "agents/draft",
        defaultProfileId: draft.id,
        sourceIds: [source.value.id],
        idempotencyKey: "scout-create-draft",
      }),
    ).toThrow(/confirmed Candidate Profile/i);
    app.setScoutSources({
      scoutId: scout.value.id,
      expectedRevision: scout.value.revision,
      sourceIds: [source.value.id],
      idempotencyKey: "scout-sources-draft",
    });

    expect(() =>
      app.launchScoutRun({ scoutId: scout.value.id, idempotencyKey: "run-draft" }),
    ).toThrow(/confirmed Candidate Profile/i);
  });

  test("preflight pins the complete Profile Version and effective materials", () => {
    const app = new RecruitingApplication(makeDb(), () => 3000);
    const defaultProfile = confirmedProfile(app, "default");
    const overrideProfile = confirmedProfile(app, "override");
    const source = app.createSource({
      kind: "rss",
      name: "Engineering feeds",
      idempotencyKey: "source-create-3",
    });
    const scout = app.createScout({
      name: "Pinned Scout",
      harness: "claude",
      instructionPath: "agents/pinned",
      strategyMaterial: "Original strategy",
      policyMaterial: "Original policy",
      defaultProfileId: defaultProfile.id,
      sourceIds: [source.value.id],
      idempotencyKey: "scout-create-4",
    });

    const run = app.launchScoutRun({
      scoutId: scout.value.id,
      profileOverrideId: overrideProfile.id,
      strategyOverride: "One-run strategy",
      policyOverride: "One-run policy",
      idempotencyKey: "run-pinned",
    });
    expect(run.value.status).toBe("preflight");
    expect(run.value.profileVersionId).toBe(overrideProfile.currentVersion?.id);
    expect(run.value.profileSnapshot).toContain("Candidate override");
    expect(run.value.strategySnapshot).toContain("One-run strategy");
    expect(run.value.policySnapshot).toContain("One-run policy");
    expect(run.value.overrideSnapshot).toContain(`"profileOverrideId":"${overrideProfile.id}"`);
    expect(run.value.sourceIds).toEqual([source.value.id]);

    const edited = app.updateScout({
      scoutId: scout.value.id,
      expectedRevision: scout.value.revision,
      strategyMaterial: "Changed strategy",
      policyMaterial: "Changed policy",
      idempotencyKey: "scout-update-2",
    });
    expect(app.getScoutRun(run.value.id)?.strategySnapshot).toContain("One-run strategy");
    expect(app.getScoutRun(run.value.id)?.policySnapshot).toContain("One-run policy");
    expect(edited.value.strategyMaterial).toContain("Changed strategy");
    const changedSources = app.createSource({
      kind: "rss",
      name: "Second feed",
      idempotencyKey: "source-create-3b",
    });
    app.setScoutSources({
      scoutId: scout.value.id,
      expectedRevision: edited.value.revision,
      sourceIds: [changedSources.value.id],
      idempotencyKey: "scout-sources-3b",
    });
    expect(app.getScoutRun(run.value.id)?.sourceIds).toEqual([source.value.id]);
  });

  test("allows different Scouts to run concurrently but only one active Run per Scout", () => {
    const app = new RecruitingApplication(makeDb(), () => 4000);
    const profile = confirmedProfile(app, "concurrency");
    const source = app.createSource({
      kind: "rss",
      name: "Engineering feeds",
      idempotencyKey: "source-create-4",
    });
    const makeScout = (name: string, key: string) =>
      app.createScout({
        name,
        harness: "claude",
        instructionPath: `agents/${name.toLowerCase()}`,
        defaultProfileId: profile.id,
        sourceIds: [source.value.id],
        idempotencyKey: key,
      });
    const first = makeScout("First", "scout-create-5");
    const second = makeScout("Second", "scout-create-6");

    app.launchScoutRun({ scoutId: first.value.id, idempotencyKey: "run-first" });
    expect(() =>
      app.launchScoutRun({ scoutId: first.value.id, idempotencyKey: "run-first-2" }),
    ).toThrow(RecruitingError);
    expect(() =>
      app.launchScoutRun({ scoutId: second.value.id, idempotencyKey: "run-second" }),
    ).not.toThrow();
  });
});
