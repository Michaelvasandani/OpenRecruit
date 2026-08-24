import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { SettingsService } from "../settings";
import { RecruitingApplication, WEB_SEARCH_SOURCE_ID } from ".";

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

function makeApp() {
  const db = makeDb();
  const settings = new SettingsService(db);
  const app = new RecruitingApplication(db, () => 1_000, {
    webSearchSettings: () => settings.get().firecrawl,
  });
  return { app, settings };
}

function confirmedProfile(app: RecruitingApplication): string {
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Built useful systems.",
    careerInterests: "Developer tools",
    idempotencyKey: "profile-import",
  });
  return app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: "profile-confirm",
  }).id;
}

describe("canonical Web Search Source Access", () => {
  test("exposes one canonical Web Search Source and leaves existing Scouts disabled", () => {
    const { app } = makeApp();
    expect(() =>
      app.createSource({
        kind: "web_search",
        name: "Duplicate Web Search",
        idempotencyKey: "source-duplicate-web",
      }),
    ).toThrow(/canonical Source/i);
    const scout = app.createScout({
      name: "Existing Scout",
      harness: "claude",
      instructionPath: "agents/existing",
      idempotencyKey: "scout-existing",
    });

    const source = app.listSources().find((candidate) => candidate.id === WEB_SEARCH_SOURCE_ID);
    expect(source).toMatchObject({
      id: WEB_SEARCH_SOURCE_ID,
      kind: "web_search",
      name: "Web Search",
    });
    expect(source?.access).not.toBeNull();
    expect(
      app.listSources().filter((candidate) => candidate.id === WEB_SEARCH_SOURCE_ID),
    ).toHaveLength(1);
    expect(scout.value.sourceIds).not.toContain(WEB_SEARCH_SOURCE_ID);
  });

  test("defaults a new Scout to Web Search only when Firecrawl is configured", () => {
    const { app, settings } = makeApp();
    const unconfigured = app.createScout({
      name: "Unconfigured Scout",
      harness: "claude",
      instructionPath: "agents/unconfigured",
      idempotencyKey: "scout-unconfigured",
    });
    expect(unconfigured.value.sourceIds).toEqual([]);

    settings.setFirecrawlApiKey("fc-test-secret");
    const profileId = confirmedProfile(app);

    const scout = app.createScout({
      name: "Configured Scout",
      harness: "codex",
      instructionPath: "agents/configured",
      defaultProfileId: profileId,
      idempotencyKey: "scout-configured",
    });

    expect(scout.value.sourceIds).toEqual([WEB_SEARCH_SOURCE_ID]);
    expect(() =>
      app.createScout({
        name: "Configured Scout",
        harness: "codex",
        instructionPath: "agents/configured",
        defaultProfileId: profileId,
        sourceIds: [],
        idempotencyKey: "scout-configured",
      }),
    ).toThrow(/payload/i);
  });

  test("treats explicit Source selection as authoritative, including opt-out", () => {
    const { app, settings } = makeApp();
    settings.setFirecrawlApiKey("fc-test-secret");
    const profileId = confirmedProfile(app);
    const rss = app.createSource({
      kind: "rss",
      name: "Candidate feed",
      idempotencyKey: "source-rss",
    });
    const explicitOther = app.createScout({
      name: "Explicit RSS Scout",
      harness: "claude",
      instructionPath: "agents/explicit-rss",
      defaultProfileId: profileId,
      sourceIds: [rss.value.id],
      idempotencyKey: "scout-explicit-rss",
    });
    expect(explicitOther.value.sourceIds).toEqual([rss.value.id]);

    const optedOut = app.createScout({
      name: "Opted-out Scout",
      harness: "claude",
      instructionPath: "agents/opted-out",
      defaultProfileId: profileId,
      sourceIds: [],
      idempotencyKey: "scout-opted-out",
    });

    expect(optedOut.value.sourceIds).toEqual([]);
    const selected = app.setScoutSources({
      scoutId: optedOut.value.id,
      expectedRevision: optedOut.value.revision,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "scout-enable-web",
    });
    expect(selected.value).toEqual([WEB_SEARCH_SOURCE_ID]);
    expect(app.getScout(optedOut.value.id)?.sourceIds).toEqual([WEB_SEARCH_SOURCE_ID]);
    const nextRun = app.launchScoutRun({
      scoutId: optedOut.value.id,
      idempotencyKey: "run-after-web-enable",
    });
    expect(nextRun.value.sourceIds).toEqual([WEB_SEARCH_SOURCE_ID]);
  });

  test("projects Web Search readiness and selection without credential material", () => {
    const { app, settings } = makeApp();
    settings.setFirecrawlApiKey("fc-test-secret");
    const source = app.listSources().find((candidate) => candidate.id === WEB_SEARCH_SOURCE_ID);
    expect(source).toMatchObject({
      id: WEB_SEARCH_SOURCE_ID,
      kind: "web_search",
      readiness: "ready",
      access: { readiness: "ready" },
    });
    expect(JSON.stringify(source)).not.toContain("fc-test-secret");

    settings.clearFirecrawlApiKey();
    expect(
      app.listSources().find((candidate) => candidate.id === WEB_SEARCH_SOURCE_ID),
    ).toMatchObject({
      readiness: "not_configured",
      access: { readiness: "not_configured" },
    });
  });
});
