import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { LocalApiServer } from "../local-api";
import { executeBirdSearch } from "../settings/bird";
import { BirdXProvider, DeterministicXProvider, RecruitingApplication, type XProvider } from ".";

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

function fixture(provider: XProvider, resolvedPath = "/private/bird") {
  const app = new RecruitingApplication(makeDb(), () => Date.parse("2026-08-23T16:00:00Z"), {
    birdAccess: () => ({
      configuredPath: resolvedPath,
      resolvedPath,
      fingerprint: "fingerprint",
      version: "0.8.0",
      accountIdentity: { id: "42", username: "candidate", displayName: "Candidate" },
    }),
    birdProvider: provider,
  });
  const profile = app.importProfile({
    name: "Candidate",
    roleTarget: "Staff engineer",
    careerInterests: "Developer tools",
    idempotencyKey: "x-search-profile",
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: "x-search-profile-confirm",
  });
  const source = app.createXSource({
    name: "Bird X",
    provider: "bird",
    query: "hiring",
    postIds: ["1900000000000000001"],
    idempotencyKey: "x-search-source",
  });
  const scout = app.createScout({
    name: "Bird Scout",
    harness: "codex",
    instructionPath: "agents/bird",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: "x-search-scout",
  });
  const run = app.launchScoutRun({ scoutId: scout.value.id, idempotencyKey: "x-search-run" });
  return { app, scout: scout.value, run: run.value };
}

const birdResponse = {
  status: 200,
  body: JSON.stringify([
    {
      id: "1900000000000000001",
      text: "We are hiring a staff engineer",
      created_at: "2026-08-23T15:00:00.000Z",
      author: { id: "42", username: "openrecruit", name: "OpenRecruit" },
    },
  ]),
};

describe("Bird XSearch", () => {
  test("does not allow a Bird Source to be created without current consent", () => {
    const app = new RecruitingApplication(makeDb(), () => Date.parse("2026-08-23T16:00:00Z"), {
      birdAccess: () => null,
    });
    expect(() =>
      app.createXSource({
        name: "Bird X",
        provider: "bird",
        query: "hiring",
        idempotencyKey: "x-search-no-consent",
      }),
    ).toThrow(/current Bird consent/i);
  });

  test("executes only the fixed search command with bounded output and stripped X tokens", async () => {
    const executable = join(tmpdir(), `openrecruit-bird-search-${crypto.randomUUID()}`);
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf \'[{"id":"1900000000000000002","text":"%s %s %s %s %s %s","author":{"username":"bird"}}]\' "$1" "$2" "$3" "$4" "$5" "$CT0"',
    );
    chmodSync(executable, 0o755);
    const previous = process.env.CT0;
    process.env.CT0 = "secret-cookie";
    try {
      const result = await executeBirdSearch(executable, "hiring", 3);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("search hiring -n 3 --json");
      expect(result.stdout).not.toContain("secret-cookie");
      expect(result.stdout).toContain("hiring");
      expect(result.stdout).not.toContain("--all");
      expect(result.stdout).not.toContain("--json-full");
      expect(
        await new BirdXProvider(() => ({
          configuredPath: executable,
          resolvedPath: executable,
          fingerprint: "fingerprint",
          version: "0.8.0",
          accountIdentity: { id: "42", username: "candidate", displayName: "Candidate" },
        })).request({
          operation: "search_recent",
          query: "hiring",
          maxResults: 3,
          fields: [],
          expansions: [],
          userFields: [],
        }),
      ).toMatchObject({ status: 200 });
    } finally {
      if (previous === undefined) delete process.env.CT0;
      else process.env.CT0 = previous;
    }
  });

  test("runs the configured Bird executable into temporary normalized evidence", async () => {
    const executable = join(tmpdir(), `openrecruit-bird-live-${crypto.randomUUID()}`);
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf \'%s\' \'[{"id":"1900000000000000003","text":"Live Bird result","authorId":"42","author":{"username":"bird","name":"Bird"},"createdAt":"2026-08-23T15:00:00.000Z"}]\'',
    );
    chmodSync(executable, 0o755);
    const access = () => ({
      configuredPath: executable,
      resolvedPath: executable,
      fingerprint: "fingerprint",
      version: "0.8.0",
      accountIdentity: { id: "42", username: "candidate", displayName: "Candidate" },
    });
    const provider = new BirdXProvider(access);
    const { app, scout, run } = fixture(provider, executable);

    const result = await app.xSearch({ scoutId: scout.id, query: "live", limit: 1 });

    expect(result.availableCount).toBe(1);
    expect(result.resultCount).toBe(1);
    expect(result.results[0]).toMatchObject({
      providerIdentity: "1900000000000000003",
      canonicalUrl: "https://x.com/bird/status/1900000000000000003",
      text: "Live Bird result",
      author: { id: "42", username: "bird", name: "Bird" },
      provenance: { provider: "bird" },
      trust: "untrusted_evidence",
    });
    const attempt = app.getSourceAttempt(result.sourceAttemptId);
    expect(attempt).toMatchObject({
      runId: run.id,
      sourceId: run.sourceIds[0],
      provider: "bird",
      outcome: "succeeded_with_items",
      itemCount: 1,
    });
    expect(JSON.parse(attempt?.requestedScope ?? "{}")).toMatchObject({
      operation: "bird_x_search",
      query: "live",
      provider: "bird",
      attemptCount: 1,
      retryDisposition: "not_retried",
      returnedIdentities: ["1900000000000000003"],
    });
    expect(app.listSignals()).toHaveLength(0);
    expect(app.listLeads()).toHaveLength(0);
  });

  test("returns bounded untrusted evidence with host references without creating Signals", async () => {
    const provider = new DeterministicXProvider({ search: birdResponse });
    const { app, scout, run } = fixture(provider);

    const result = await app.xSearch({ scoutId: scout.id, query: "staff engineer", limit: 1 });

    // Assert identity fields before Bun's asymmetric matcher, which mutates
    // nested `expect.any` values in this runtime.
    expect(typeof result.sourceAttemptId).toBe("string");
    expect(typeof result.results[0]?.sourceAttemptId).toBe("string");
    expect(result.results[0]?.sourceAttemptId).toBe(result.sourceAttemptId);
    expect(typeof result.results[0]?.evidenceReference).toBe("string");
    expect(app.listSignals()).toHaveLength(0);
    expect(app.listLeads()).toHaveLength(0);
    expect(app.getSourceAttempt(result.sourceAttemptId)).toMatchObject({
      runId: run.id,
      sourceId: run.sourceIds[0],
      provider: "bird",
      outcome: "succeeded_with_items",
      itemCount: 1,
    });
    app.recordXEvidenceForScout({
      scoutId: scout.id,
      sourceAttemptId: result.sourceAttemptId,
      evidenceReferences: [result.results[0]?.evidenceReference ?? ""],
    });
    expect(app.listSignals()).toHaveLength(1);
    expect(app.listLeads()).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      operation: "search_recent",
      query: "staff engineer",
      maxResults: 1,
    });
    expect(result).toMatchObject({
      query: "staff engineer",
      limit: 1,
      provider: "bird",
      trust: "untrusted_evidence",
      sourceAttemptId: expect.any(String),
      availableCount: 1,
      results: [
        {
          providerIdentity: "1900000000000000001",
          canonicalUrl: "https://x.com/openrecruit/status/1900000000000000001",
          text: "We are hiring a staff engineer",
          author: { id: "42", username: "openrecruit", name: "OpenRecruit" },
          trust: "untrusted_evidence",
          evidenceReference: expect.any(String),
          sourceAttemptId: expect.any(String),
        },
      ],
    });
  });

  test("rejects invalid limits and does not invoke Bird", async () => {
    const provider = new DeterministicXProvider({ search: birdResponse });
    const { app, scout } = fixture(provider);
    await expect(app.xSearch({ scoutId: scout.id, query: "hiring", limit: 26 })).rejects.toThrow(
      /between 1 and 25/i,
    );
    await expect(app.xSearch({ scoutId: scout.id, query: "   " })).rejects.toThrow(/required/i);
    expect(provider.requests).toHaveLength(0);
  });

  test("routes through authenticated localhost and advertises the same MCP XSearch tool", async () => {
    const provider = new DeterministicXProvider({ search: birdResponse });
    const { app, scout } = fixture(provider);
    const server = new LocalApiServer({
      port: 0,
      token: "x-search-test-token",
      registry: { get: () => ({ id: scout.id }) },
      arbiter: {},
      recruiting: app,
    } as never);
    await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/x-search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opentrade-token": server.token,
          "x-opentrade-agent": scout.id,
        },
        body: JSON.stringify({ query: "hiring", limit: 1 }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as { provider: string }).toMatchObject({ provider: "bird" });

      const mcpPath = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../..",
        "agent-mcp/index.ts",
      );
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
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
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
      const listing = JSON.parse(output.trim()) as {
        result?: {
          tools?: Array<{
            name: string;
            inputSchema: Record<string, unknown>;
            outputSchema?: Record<string, unknown>;
          }>;
        };
      };
      const xSearch = listing.result?.tools?.find((tool) => tool.name === "XSearch");
      expect(xSearch?.inputSchema).toMatchObject({
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
        },
        required: ["query"],
      });
      expect(xSearch?.outputSchema?.type).toBe("object");
      expect(xSearch?.outputSchema?.required).toEqual(
        expect.arrayContaining(["sourceAttemptId", "results", "trust", "trustBoundary"]),
      );
    } finally {
      server.stop();
    }
  });
});
