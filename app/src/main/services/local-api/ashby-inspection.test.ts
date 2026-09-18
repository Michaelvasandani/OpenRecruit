import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { RecruitingApplication } from "../recruiting";
import { LocalApiServer } from ".";

const JOB_ID = "eeeb9757-78e0-4776-889e-507a013e1fcf";

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

function fixture() {
  const app = new RecruitingApplication(makeDb(), () => 10_000, {
    ashbyProvider: {
      async fetchBoard() {
        return {
          status: 200,
          body: {
            jobs: [
              {
                id: JOB_ID,
                title: "Forward Deployed Engineer",
                location: "San Francisco, CA",
                secondaryLocations: [],
                isRemote: false,
                publishedAt: "2026-09-16T00:15:28.633Z",
                isListed: true,
                jobUrl: `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`,
                applyUrl: `https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}/application`,
                descriptionPlain: "Requires 0-2 years of software engineering experience.",
                descriptionHtml: "<p>Requires 0-2 years.</p>",
              },
            ],
          },
        };
      },
    },
  });
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Built useful systems.",
    careerInterests: "AI engineering",
    idempotencyKey: "ashby-api-profile-import",
  });
  const profile = app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: "ashby-api-profile-confirm",
  });
  const scout = app.createScout({
    name: "Ashby API Scout",
    harness: "codex",
    instructionPath: "agents/ashby-api",
    defaultProfileId: profile.id,
    sourceIds: ["source-ashby"],
    idempotencyKey: "ashby-api-scout",
  }).value;
  app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "ashby-api-run" });
  const server = new LocalApiServer({
    port: 0,
    token: "ashby-test-token",
    registry: { get: () => ({ id: scout.id }) },
    arbiter: {},
    recruiting: app,
  } as never);
  return { app, scout, server };
}

describe("authenticated Ashby inspection route", () => {
  const { scout, server } = fixture();
  let base = "";

  beforeAll(async () => {
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  test("derives the Scout identity and returns verified postings", async () => {
    const response = await fetch(`${base}/ashby/inspect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opentrade-token": server.token,
        "x-opentrade-agent": scout.id,
      },
      body: JSON.stringify({
        urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
        policy: { listedOnly: true, maximumExplicitRequiredYears: 2 },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: "ashby",
      results: [{ posting: { providerJobId: JOB_ID }, policy: { decision: "include" } }],
    });
  });

  test("exposes AshbyInspectJobs through the shared MCP server", async () => {
    const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "../../..", "agent-mcp/index.ts");
    const child = Bun.spawn([process.execPath, mcpPath], {
      env: {
        ...process.env,
        OPENTRADE_PORT: String(server.port),
        OPENTRADE_TOKEN: server.token,
        OPENTRADE_AGENT_ID: scout.id,
        OPENTRADE_HARNESS: "codex",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "AshbyInspectJobs",
          arguments: {
            urls: [`https://jobs.ashbyhq.com/Roadrunner/${JOB_ID}`],
            includeDescription: true,
          },
        },
      })}\n`,
    );
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    child.kill();
    const response = JSON.parse(output.trim()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };

    expect(response.result?.isError).not.toBe(true);
    expect(response.result?.content?.[0]?.text).toContain(JOB_ID);
    expect(response.result?.content?.[0]?.text).toContain("descriptionPlain");
  });
});
