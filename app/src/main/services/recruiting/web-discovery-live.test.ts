import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { SettingsService } from "../settings";
import {
  FirecrawlWebFetchProvider,
  FirecrawlWebSearchProvider,
  RecruitingApplication,
  WEB_SEARCH_SOURCE_ID,
} from ".";

const LIVE_ENABLED = process.env.OPENTRADE_LIVE_FIRECRAWL === "1";
const liveDescribe = describe.skipIf(!LIVE_ENABLED || !process.env.FIRECRAWL_API_KEY?.trim());

function makeDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(SCHEMA_DDL);
  const migration: MigrationDb = {
    exec: (sql) => void sqlite.exec(sql),
    rows: (sql) => sqlite.query(sql).all(),
  };
  migrate(migration, { fresh: true });
  return drizzle(sqlite) as unknown as Db;
}

liveDescribe("opt-in Candidate-key-gated Firecrawl smoke", () => {
  test("returns attributable natural and restricted Ashby evidence, then bounded fetch content", async () => {
    const key = process.env.FIRECRAWL_API_KEY?.trim() ?? "";
    const db = makeDb();
    const settings = new SettingsService(db);
    settings.setFirecrawlApiKey(key);
    const app = new RecruitingApplication(db, Date.now, {
      provider: new FirecrawlWebSearchProvider(() => key),
      webFetchProvider: new FirecrawlWebFetchProvider(() => key),
      webSearchApiKey: () => key,
      webSearchSettings: () => settings.get().firecrawl,
    });
    const draft = app.importProfile({
      name: "Live smoke Candidate",
      roleTarget: "Engineer",
      cvText: "Synthetic smoke-test profile",
      careerInterests: "Developer tools",
      idempotencyKey: "live-smoke-profile-import",
    });
    const profile = app.confirmProfile({
      profileId: draft.id,
      expectedRevision: draft.revision,
      idempotencyKey: "live-smoke-profile-confirm",
    });
    const scout = app.createScout({
      name: "Live smoke Scout",
      harness: "claude",
      instructionPath: "agents/live-smoke",
      defaultProfileId: profile.id,
      sourceIds: [WEB_SEARCH_SOURCE_ID],
      idempotencyKey: "live-smoke-scout",
    }).value;
    app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "live-smoke-run" });

    const natural = await app.webSearch({
      scoutId: scout.id,
      query: "software engineering jobs at developer tools startups",
      limit: 3,
    });
    expect(natural.results.length).toBeGreaterThan(0);
    expect(natural.provenance.provider).toBe("firecrawl");

    const ashby = await app.webSearch({
      scoutId: scout.id,
      query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
      limit: 5,
    });
    expect(ashby.results.length).toBeGreaterThan(0);
    expect(
      ashby.results.every((result) => {
        const url = new URL(result.canonicalUrl);
        const text = `${result.title} ${result.excerpt}`.toLowerCase();
        return (
          (url.hostname === "jobs.ashbyhq.com" || url.hostname.endsWith(".jobs.ashbyhq.com")) &&
          text.includes("forward deployed engineer")
        );
      }),
    ).toBe(true);

    const selected = ashby.results[0]?.canonicalUrl;
    if (!selected) throw new Error("smoke search returned no selected Ashby URL");
    const fetched = await app.webFetch({
      scoutId: scout.id,
      urls: [selected],
      contentLimit: 12_000,
    });
    const first = fetched.outcomes[0];
    expect(first && "content" in first).toBe(true);
    if (!first || !("content" in first)) return;
    expect(first.content.length).toBeLessThanOrEqual(12_000);

    // Never include the credential in assertion messages or serialized output.
    const safeOutput = JSON.stringify({ natural, ashby, fetched });
    expect(safeOutput.includes(key)).toBe(false);
  });
});
