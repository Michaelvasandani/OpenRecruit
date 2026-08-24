import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  DeterministicWebFetchProvider,
  DeterministicWebSearchProvider,
  RecruitingApplication,
  WEB_SEARCH_SOURCE_ID,
} from "../recruiting";
import { LocalApiServer } from ".";

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
  const provider = new DeterministicWebSearchProvider({
    query: [{ title: "Result", url: "https://example.com/job", description: "Evidence" }],
  });
  const fetchProvider = new DeterministicWebFetchProvider({
    "https://example.com/job": { title: "Result", content: "Selected page evidence" },
  });
  const app = new RecruitingApplication(makeDb(), () => 10_000, {
    provider,
    webFetchProvider: fetchProvider,
  });
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Built useful systems.",
    careerInterests: "Developer tools",
    idempotencyKey: "api-profile-import",
  });
  const profile = app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: "api-profile-confirm",
  });
  const scout = app.createScout({
    name: "API Scout",
    harness: "claude",
    instructionPath: "agents/api",
    defaultProfileId: profile.id,
    sourceIds: [WEB_SEARCH_SOURCE_ID],
    idempotencyKey: "api-scout",
  }).value;
  const run = app.launchScoutRun({ scoutId: scout.id, idempotencyKey: "api-run" }).value;
  const server = new LocalApiServer({
    port: 0,
    token: "web-search-test-token",
    registry: { get: () => ({ id: scout.id }) },
    arbiter: {},
    recruiting: app,
  } as never);
  return { app, provider, fetchProvider, scout, run, server };
}

describe("authenticated agent WebSearch route", () => {
  const { app, provider, fetchProvider, scout, run, server } = fixture();
  let base = "";

  beforeAll(async () => {
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  test("routes the same contract used by the shared MCP", async () => {
    const response = await fetch(`${base}/web-search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opentrade-token": server.token,
        "x-opentrade-agent": scout.id,
      },
      body: JSON.stringify({ query: "query" }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      sourceAttemptId: string;
      results: Array<{ canonicalUrl: string }>;
    };
    expect(result.results[0]?.canonicalUrl).toBe("https://example.com/job");
    expect(app.getSourceAttempt(result.sourceAttemptId)).toMatchObject({ runId: run.id });
  });

  test("invokes WebSearch through the shared MCP JSON-RPC shape", async () => {
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
        params: { name: "WebSearch", arguments: { query: "query" } },
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
    const messages = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number; result?: unknown });
    const response = messages.find((message) => message.id === 1);
    expect(response?.result).toMatchObject({
      content: [{ type: "text" }],
    });
    expect(JSON.stringify(response)).toContain("https://example.com/job");
  });

  test("rejects missing authentication and invalid limits before provider access", async () => {
    const requestsBeforeInvalid = provider.requests.length;
    const unauthenticated = await fetch(`${base}/web-search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query" }),
    });
    expect(unauthenticated.status).toBe(401);

    const invalid = await fetch(`${base}/web-search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opentrade-token": server.token,
        "x-opentrade-agent": scout.id,
      },
      body: JSON.stringify({ query: "query", limit: 26 }),
    });
    expect(invalid.status).toBe(400);
    expect(provider.requests).toHaveLength(requestsBeforeInvalid);
  });

  test("routes selected pages through WebFetch and rejects private URLs before its provider", async () => {
    const response = await fetch(`${base}/web-fetch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opentrade-token": server.token,
        "x-opentrade-agent": scout.id,
      },
      body: JSON.stringify({ urls: ["https://example.com/job"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcomes: [
        {
          canonicalUrl: "https://example.com/job",
          content: "Selected page evidence",
          trust: "untrusted_evidence",
        },
      ],
    });

    const requestsBeforeInvalid = fetchProvider.requests.length;
    const invalid = await fetch(`${base}/web-fetch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opentrade-token": server.token,
        "x-opentrade-agent": scout.id,
      },
      body: JSON.stringify({ urls: ["http://127.0.0.1/private"] }),
    });
    expect(invalid.status).toBe(400);
    expect(fetchProvider.requests).toHaveLength(requestsBeforeInvalid);
  });

  test("exposes WebFetch through the same shared MCP JSON-RPC server", async () => {
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
        id: 2,
        method: "tools/call",
        params: { name: "WebFetch", arguments: { urls: ["https://example.com/job"] } },
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
    const messages = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number; result?: unknown });
    const response = messages.find((message) => message.id === 2);
    expect(response?.result).toMatchObject({ content: [{ type: "text" }] });
    expect(JSON.stringify(response)).toContain("Selected page evidence");
    expect(JSON.stringify(response)).toContain("untrusted_evidence");
  });
});
