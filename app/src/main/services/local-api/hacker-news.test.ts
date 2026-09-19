import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  DeterministicHackerNewsProvider,
  HACKER_NEWS_SOURCE_ID,
  RecruitingApplication,
} from "../recruiting";
import { LocalApiServer } from ".";

const JOBS_URL =
  "https://hn.algolia.com/api/v1/search_by_date?tags=job&query=robotics&hitsPerPage=20&page=0";

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
  const provider = new DeterministicHackerNewsProvider({
    [JOBS_URL]: {
      status: 200,
      json: { hits: [{ objectID: "5001", title: "Acme (YC W26) is hiring", created_at_i: 5 }] },
    },
  });
  const app = new RecruitingApplication(makeDb(), () => 10_000, { hackerNewsProvider: provider });
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Built useful systems.",
    careerInterests: "Robotics",
    idempotencyKey: "hn-api-profile-import",
  });
  const profile = app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: "hn-api-profile-confirm",
  });
  const scout = app.createScout({
    name: "HN API Scout",
    harness: "claude",
    instructionPath: "agents/hn-api",
    defaultProfileId: profile.id,
    sourceIds: [HACKER_NEWS_SOURCE_ID],
    idempotencyKey: "hn-api-scout",
  }).value;
  const run = app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "hn-api-run" }).value;
  const server = new LocalApiServer({
    port: 0,
    token: "hacker-news-test-token",
    registry: { get: () => ({ id: scout.id }) },
    arbiter: {},
    recruiting: app,
  } as never);
  return { app, scout, run, server };
}

describe("authenticated agent HackerNewsJobs route", () => {
  const { app, scout, run, server } = fixture();
  let base = "";

  beforeAll(async () => {
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  const post = (body: unknown, agent = scout.id) =>
    fetch(`${base}/hn-jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opentrade-token": server.token,
        "x-opentrade-agent": agent,
      },
      body: JSON.stringify(body),
    });

  test("reads postings for the agent's Scout and active Run", async () => {
    const response = await post({ mode: "job_stories", query: "robotics" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      sourceAttemptId: string;
      results: Array<{ canonicalUrl: string }>;
    };
    expect(result.results[0]?.canonicalUrl).toBe("https://news.ycombinator.com/item?id=5001");
    expect(app.getSourceAttempt(result.sourceAttemptId)).toMatchObject({
      runId: run.id,
      sourceId: HACKER_NEWS_SOURCE_ID,
    });
  });

  test("rejects unknown body keys and invalid input", async () => {
    const unknownKey = await post({ mode: "job_stories", url: "https://evil.example" });
    expect(unknownKey.status).toBe(400);
    const invalid = await post({ mode: "front_page" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "VALIDATION", category: "invalid_input" });
  });

  test("invokes HackerNewsJobs through the shared MCP JSON-RPC shape", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    await child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "HackerNewsJobs", arguments: { mode: "job_stories", query: "robotics" } },
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
    const message = JSON.parse(output.trim()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(message.result.isError).toBeUndefined();
    expect(message.result.content[0]?.text).toContain("news.ycombinator.com/item?id=5001");
  });
});
