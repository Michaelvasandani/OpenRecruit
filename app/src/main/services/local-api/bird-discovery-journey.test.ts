import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  BirdXProvider,
  RecruitingApplication,
  validateXReadTarget,
  type XApiRequest,
  type XApiResponse,
  type XProvider,
} from "../recruiting";
import type { BirdAccess } from "../settings";
import { probeBirdExecutable } from "../settings/bird";
import { LocalApiServer } from ".";

const MCP_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../agent-mcp/index.ts");

type Harness = "claude" | "codex";
type RpcResponse = { id?: number; result?: unknown; error?: unknown };

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

type McpClient = {
  list(): Promise<RpcResponse>;
  call(name: string, args?: Record<string, unknown>): Promise<RpcResponse>;
  close(): void;
};

/** The integration gate starts the exact dependency-free MCP process shipped to each harness. */
async function startMcp(
  server: LocalApiServer,
  agentId: string,
  harness: Harness,
): Promise<McpClient> {
  const child = Bun.spawn([process.execPath, MCP_PATH], {
    env: {
      ...process.env,
      OPENTRADE_PORT: String(server.port),
      OPENTRADE_TOKEN: server.token,
      OPENTRADE_AGENT_ID: agentId,
      OPENTRADE_HARNESS: harness,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextId = 1;

  async function nextResponse(): Promise<RpcResponse> {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) return JSON.parse(line) as RpcResponse;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("MCP server exited before replying");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  async function request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = nextId++;
    await child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (;;) {
      const response = await nextResponse();
      if (response.id === id) return response;
    }
  }

  await request("initialize", { protocolVersion: "2024-11-05" });
  return {
    list: () => request("tools/list", {}),
    call: (name, args = {}) => request("tools/call", { name, arguments: args }),
    close: () => child.kill(),
  };
}

function resultText(response: RpcResponse): string {
  const result = response.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? "";
}

function resultJson<T>(response: RpcResponse): T {
  return JSON.parse(resultText(response)) as T;
}

function resultError(response: RpcResponse): string {
  const result = response.result as { content?: Array<{ text?: string }>; isError?: boolean };
  expect(result.isError).toBe(true);
  return result.content?.[0]?.text ?? "";
}

const POST_ID = "1900000000000000053";
const BIRD_SEARCH_RESULT = {
  id: POST_ID,
  text: "OpenRecruit is hiring a staff engineer",
  created_at: "2026-08-26T15:00:00.000Z",
  author: { id: "42", username: "openrecruit", name: "OpenRecruit" },
  cookie: "bird-cookie-canary",
};
const BIRD_READ_RESULT = {
  id: POST_ID,
  url: `https://x.com/openrecruit/status/${POST_ID}`,
  text: BIRD_SEARCH_RESULT.text,
  createdAt: "2026-08-26T15:00:00.000Z",
  author: BIRD_SEARCH_RESULT.author,
  publicMetrics: { likeCount: 2, replyCount: 1, repostCount: 3, quoteCount: 0 },
  conversationId: POST_ID,
  media: [],
  cookie: "bird-cookie-canary",
};

/** Deterministic Bird-shaped responses keep the portable gate network-free. */
class JourneyBirdProvider implements XProvider {
  readonly requests: XApiRequest[] = [];

  async request(request: XApiRequest): Promise<XApiResponse> {
    this.requests.push({
      ...request,
      postIds: request.postIds ? [...request.postIds] : undefined,
      fields: [...request.fields],
      expansions: [...request.expansions],
      userFields: [...request.userFields],
    });
    if (request.operation === "search_recent") {
      return { status: 200, body: JSON.stringify([BIRD_SEARCH_RESULT]) };
    }
    if (request.operation === "read") {
      return { status: 200, body: JSON.stringify(BIRD_READ_RESULT) };
    }
    return { status: 400, body: "" };
  }
}

class StateBirdProvider implements XProvider {
  readonly requests: XApiRequest[] = [];

  async request(request: XApiRequest): Promise<XApiResponse> {
    this.requests.push({
      ...request,
      postIds: request.postIds ? [...request.postIds] : undefined,
      fields: [...request.fields],
      expansions: [...request.expansions],
      userFields: [...request.userFields],
    });
    const state = request.query?.replace(/^state:/, "");
    switch (state) {
      case "authentication":
        return { status: 503, body: "", failureCategory: "authentication" };
      case "rate":
        return { status: 429, body: "" };
      case "timeout":
        return { status: 504, body: "" };
      case "malformed":
        return { status: 200, body: "not-json" };
      case "unsupported":
        return { status: 426, body: "", failureCategory: "unsupported_version" };
      case "provider":
        return { status: 503, body: "", failureCategory: "provider_failure" };
      case "empty":
        return { status: 200, body: "[]" };
      default:
        return { status: 200, body: JSON.stringify([BIRD_SEARCH_RESULT]) };
    }
  }
}

function setupJourney(
  provider: XProvider = new JourneyBirdProvider(),
  access: BirdAccess = {
    configuredPath: "/private/bird",
    resolvedPath: "/private/bird",
    fingerprint: "bird-test-fingerprint",
    version: "0.8.0",
    accountIdentity: { id: "42", username: "candidate", displayName: "Candidate" },
  },
) {
  const app = new RecruitingApplication(makeDb(), () => Date.parse("2026-08-26T16:00:00Z"), {
    birdAccess: () => access,
    birdProvider: provider,
  });
  const profile = app.importProfile({
    name: "Candidate",
    roleTarget: "Staff engineer",
    careerInterests: "Developer tools",
    idempotencyKey: "bird-journey-profile",
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: "bird-journey-profile-confirm",
  });
  const sourceIds = {} as Record<Harness, string>;
  const scouts = Object.fromEntries(
    (["claude", "codex"] as const).map((harness) => {
      // Keep each harness's Source identity independent so the gate can assert
      // that each selected evidence reference creates one attributable Signal.
      const source = app.createXSource({
        name: `${harness} Public X`,
        provider: "bird",
        query: "OpenRecruit hiring",
        postIds: [POST_ID],
        idempotencyKey: `bird-journey-${harness}-source`,
      });
      sourceIds[harness] = source.value.id;
      const scout = app.createScout({
        name: `${harness} Bird Scout`,
        harness,
        instructionPath: `agents/${harness}-bird`,
        defaultProfileId: confirmed.id,
        sourceIds: [source.value.id],
        strategyMaterial: "Find public hiring posts.",
        policyMaterial: "Use selected public X Sources only.",
        idempotencyKey: `bird-journey-${harness}-scout`,
      }).value;
      const run = app.launchScoutRun({
        scoutId: scout.id,
        idempotencyKey: `bird-journey-${harness}-run`,
      }).value;
      return [harness, { scout, run }];
    }),
  ) as Record<Harness, { scout: { id: string }; run: { id: string } }>;
  const server = new LocalApiServer({
    port: 0,
    token: "bird-journey-token",
    registry: { get: () => undefined },
    arbiter: {},
    recruiting: app,
  } as never);
  return { app, provider, scouts, server, sourceIds };
}

type RealBirdPrerequisite = {
  enabled: boolean;
  ready: boolean;
  reason: string;
  access: BirdAccess | null;
  postId: string | null;
  query: string | null;
};

/**
 * Real Bird is deliberately opt-in. This report is kept safe (probeBirdExecutable
 * discards stdout/stderr) and gives CI/operators an actionable unmet prerequisite.
 */
async function realBirdPrerequisite(): Promise<RealBirdPrerequisite> {
  const enabled = process.env.OPENRECRUIT_RUN_REAL_BIRD === "1";
  if (!enabled) {
    return {
      enabled: false,
      ready: false,
      reason:
        "Real Bird acceptance is opt-in; set OPENRECRUIT_RUN_REAL_BIRD=1 with OPENRECRUIT_BIRD_PATH, OPENRECRUIT_BIRD_POST_ID, and OPENRECRUIT_BIRD_QUERY.",
      access: null,
      postId: null,
      query: null,
    };
  }
  const configuredPath = process.env.OPENRECRUIT_BIRD_PATH?.trim();
  const target = process.env.OPENRECRUIT_BIRD_POST_ID?.trim();
  const query = process.env.OPENRECRUIT_BIRD_QUERY?.trim();
  if (!configuredPath || !target || !query) {
    return {
      enabled,
      ready: false,
      reason:
        "Real Bird acceptance prerequisite unmet: configure OPENRECRUIT_BIRD_PATH, OPENRECRUIT_BIRD_POST_ID, and OPENRECRUIT_BIRD_QUERY.",
      access: null,
      postId: null,
      query: query || null,
    };
  }
  let postId: string;
  try {
    postId = validateXReadTarget(target).postId;
  } catch {
    return {
      enabled,
      ready: false,
      reason:
        "Real Bird acceptance prerequisite unmet: OPENRECRUIT_BIRD_POST_ID must be one numeric public post ID or canonical X post URL.",
      access: null,
      postId: null,
      query,
    };
  }
  const probe = await probeBirdExecutable(configuredPath);
  if (probe.readiness !== "ready" || !probe.resolvedPath || !probe.accountIdentity) {
    return {
      enabled,
      ready: false,
      reason: `Real Bird acceptance prerequisite unmet: ${probe.safeFailure ?? "Bird is not ready with an authenticated public X session."}`,
      access: null,
      postId,
      query,
    };
  }
  return {
    enabled,
    ready: true,
    reason:
      "Real Bird acceptance prerequisites met: Bird 0.8.0 and authenticated public X session.",
    access: {
      configuredPath: probe.configuredPath,
      resolvedPath: probe.resolvedPath,
      fingerprint: probe.fingerprint,
      version: probe.detectedVersion ?? "0.8.0",
      accountIdentity: probe.accountIdentity,
    },
    postId,
    query,
  };
}

describe("Issue #53 Bird discovery acceptance gate", () => {
  test("Codex and Claude expose an identical strict read-only X contract", async () => {
    const server = new LocalApiServer({
      port: 0,
      token: "bird-contract-token",
      registry: { get: () => undefined },
      arbiter: {},
    } as never);
    await server.start();
    const clients = {
      claude: await startMcp(server, "contract-claude", "claude"),
      codex: await startMcp(server, "contract-codex", "codex"),
    };
    try {
      const tools = {} as Record<Harness, Array<Record<string, unknown>>>;
      const allToolNames = {} as Record<Harness, string[]>;
      for (const harness of ["claude", "codex"] as const) {
        const listing = (await clients[harness].list()).result as {
          tools?: Array<Record<string, unknown>>;
        };
        allToolNames[harness] = (listing.tools ?? []).map((tool) => String(tool.name));
        tools[harness] = (listing.tools ?? []).filter((tool) =>
          ["XSearch", "XRead", "RecordSignal"].includes(String(tool.name)),
        );
      }
      expect(tools.codex).toEqual(tools.claude);
      expect(tools.claude.map((tool) => tool.name)).toEqual(["XSearch", "XRead", "RecordSignal"]);

      const xSearch = tools.claude.find((tool) => tool.name === "XSearch");
      const xRead = tools.claude.find((tool) => tool.name === "XRead");
      const recordSignal = tools.claude.find((tool) => tool.name === "RecordSignal");
      expect(xSearch?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["query"],
      });
      expect(xRead?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["target"],
      });
      expect(recordSignal?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["evidenceReference"],
      });

      const names = allToolNames.claude.map((name) => name.toLowerCase());
      expect(
        names.some((name) =>
          /tweet|reply|follow|like|bookmark|upload|private|thread|timeline|execute/.test(name),
        ),
      ).toBe(false);
    } finally {
      clients.claude.close();
      clients.codex.close();
      server.stop();
    }
  });

  test("runs equivalent bounded XSearch → XRead → RecordSignal journeys for both harnesses", async () => {
    const fixture = setupJourney();
    await fixture.server.start();
    const clients = {
      claude: await startMcp(fixture.server, fixture.scouts.claude.scout.id, "claude"),
      codex: await startMcp(fixture.server, fixture.scouts.codex.scout.id, "codex"),
    };
    const summaries: Record<Harness, unknown> = {} as Record<Harness, unknown>;
    try {
      for (const harness of ["claude", "codex"] as const) {
        const scout = fixture.scouts[harness].scout;
        const run = fixture.scouts[harness].run;
        const forgedResponse = await fetch(`http://127.0.0.1:${fixture.server.port}/x-search`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opentrade-token": fixture.server.token,
            "x-opentrade-agent": scout.id,
          },
          body: JSON.stringify({ query: "OpenRecruit hiring", command: "tweet" }),
        });
        expect(forgedResponse.status).toBe(400);
        expect(fixture.provider.requests).toHaveLength(harness === "claude" ? 0 : 2);
        const invalidLimit = resultError(
          await clients[harness].call("XSearch", { query: "OpenRecruit hiring", limit: 26 }),
        );
        expect(invalidLimit).toMatch(/between 1 and 25/i);
        expect(fixture.provider.requests).toHaveLength(harness === "claude" ? 0 : 2);

        const search = resultJson<{
          query: string;
          limit: number;
          sourceAttemptId: string;
          provider: string;
          trust: string;
          trustBoundary: unknown;
          availableCount: number;
          resultCount: number;
          results: Array<{
            evidenceReference: string;
            sourceAttemptId: string;
            providerIdentity: string;
            canonicalUrl: string;
            text: string;
            available: boolean;
            trust: string;
            provenance: { provider: string };
          }>;
        }>(await clients[harness].call("XSearch", { query: "OpenRecruit hiring" }));
        expect(search).toMatchObject({
          query: "OpenRecruit hiring",
          limit: 10,
          provider: "bird",
          trust: "untrusted_evidence",
          trustBoundary: { content: "untrusted_evidence", instructionsAndHostPolicy: "immutable" },
          availableCount: 1,
          resultCount: 1,
          results: [
            {
              sourceAttemptId: search.sourceAttemptId,
              providerIdentity: POST_ID,
              canonicalUrl: `https://x.com/openrecruit/status/${POST_ID}`,
              text: BIRD_SEARCH_RESULT.text,
              available: true,
              trust: "untrusted_evidence",
              provenance: { provider: "bird" },
            },
          ],
        });
        expect(fixture.app.listSignals({ runId: run.id })).toHaveLength(0);
        expect(fixture.app.listSourceAttempts(run.id)).toHaveLength(1);
        expect(fixture.app.listSourceAttempts(run.id)[0]).toMatchObject({
          sourceId: fixture.sourceIds[harness],
          provider: "bird",
          outcome: "succeeded_with_items",
          itemCount: 1,
        });

        const invalidTarget = resultError(
          await clients[harness].call("XRead", { target: "https://x.com/openrecruit" }),
        );
        expect(invalidTarget).toMatch(/exactly one numeric public post ID|canonical/i);
        expect(fixture.app.listSourceAttempts(run.id)).toHaveLength(1);

        const read = resultJson<{
          postId: string;
          evidenceReference: string;
          sourceAttemptId: string;
          providerIdentity: string;
          canonicalUrl: string;
          text: string;
          author: { id: string; username: string; name: string };
          engagement: {
            likeCount: number;
            replyCount: number;
            repostCount: number;
            quoteCount: number;
          };
          conversationId: string;
          replyParent: unknown;
          quotedPost: unknown;
          mediaUrls: string[];
          available: boolean;
          trust: string;
          provenance: { provider: string };
        }>(await clients[harness].call("XRead", { target: POST_ID }));
        expect(read).toMatchObject({
          postId: POST_ID,
          sourceAttemptId: expect.any(String),
          providerIdentity: POST_ID,
          canonicalUrl: `https://x.com/openrecruit/status/${POST_ID}`,
          text: BIRD_READ_RESULT.text,
          author: BIRD_READ_RESULT.author,
          engagement: BIRD_READ_RESULT.publicMetrics,
          conversationId: POST_ID,
          mediaUrls: [],
          available: true,
          trust: "untrusted_evidence",
          provenance: { provider: "bird" },
        });
        expect(fixture.app.listSourceAttempts(run.id)).toHaveLength(2);
        expect(fixture.app.listSignals({ runId: run.id })).toHaveLength(0);

        const recorded = resultJson<{ signalIds: string[] }>(
          await clients[harness].call("RecordSignal", {
            evidenceReference: read.evidenceReference,
          }),
        );
        expect(recorded.signalIds).toHaveLength(1);
        expect(fixture.app.listSignals({ runId: run.id })).toHaveLength(1);
        const signal = fixture.app.listSignals({ runId: run.id })[0];
        expect(signal).toMatchObject({
          sourceId: fixture.sourceIds[harness],
          sourceAttemptId: read.sourceAttemptId,
          runId: run.id,
          scoutId: scout.id,
          provider: "bird",
          providerIdentity: POST_ID,
          canonicalUrl: `https://x.com/openrecruit/status/${POST_ID}`,
          accessMode: "public",
          provenance: expect.objectContaining({ provider: "bird" }),
        });
        expect(JSON.stringify(fixture.app.listSourceAttempts(run.id))).not.toContain(
          "bird-cookie-canary",
        );
        expect(JSON.stringify(fixture.app.listSources())).not.toContain("/private/bird");

        // Recording is explicit and idempotent; replaying a temporary reference does not duplicate it.
        const replayed = resultJson<{ signalIds: string[] }>(
          await clients[harness].call("RecordSignal", {
            evidenceReference: read.evidenceReference,
          }),
        );
        expect(replayed.signalIds).toEqual(recorded.signalIds);
        expect(fixture.app.listSignals({ runId: run.id })).toHaveLength(1);

        await clients[harness].call("complete_run", { outcome: "completed" });
        summaries[harness] = {
          search: {
            query: search.query,
            limit: search.limit,
            provider: search.provider,
            trust: search.trust,
            results: search.results.map(
              ({ evidenceReference: _ref, sourceAttemptId: _attempt, ...item }) => item,
            ),
          },
          read: {
            postId: read.postId,
            providerIdentity: read.providerIdentity,
            canonicalUrl: read.canonicalUrl,
            text: read.text,
            author: read.author,
            engagement: read.engagement,
            mediaUrls: read.mediaUrls,
            trust: read.trust,
            provenance: read.provenance,
          },
        };
      }
      expect(summaries.codex).toEqual(summaries.claude);
    } finally {
      clients.claude.close();
      clients.codex.close();
      fixture.server.stop();
    }
  });

  test("keeps safe Bird failure and empty outcomes equivalent through both MCP clients", async () => {
    const states = [
      ["authentication", "authentication", "blocked"],
      ["rate", "rate_limited", "rate_limited"],
      ["timeout", "timed_out", "timed_out"],
      ["malformed", "malformed_content", "malformed_content"],
      ["unsupported", "unsupported_version", "unsupported"],
      ["provider", "provider_failure", "transient_failure"],
    ] as const;
    const errors = {} as Record<Harness, Record<string, string>>;
    const empties = {} as Record<Harness, unknown>;
    const providers: StateBirdProvider[] = [];
    for (const harness of ["claude", "codex"] as const) {
      errors[harness] = {};
      for (const [state, category, outcome] of states) {
        // Each failed attempt updates Source Access readiness. Isolate states so
        // one safe failure cannot mask the next provider classification.
        const provider = new StateBirdProvider();
        providers.push(provider);
        const fixture = setupJourney(provider);
        await fixture.server.start();
        const client = await startMcp(fixture.server, fixture.scouts[harness].scout.id, harness);
        try {
          const error = resultError(await client.call("XSearch", { query: `state:${state}` }));
          expect(error).toContain(category);
          errors[harness][state] = error;
          const attempt = fixture.app.listSourceAttempts(fixture.scouts[harness].run.id).at(-1);
          expect(attempt).toMatchObject({ provider: "bird", outcome, errorCategory: category });
        } finally {
          client.close();
          fixture.server.stop();
        }
      }
      const provider = new StateBirdProvider();
      providers.push(provider);
      const fixture = setupJourney(provider);
      await fixture.server.start();
      const client = await startMcp(fixture.server, fixture.scouts[harness].scout.id, harness);
      try {
        const empty = resultJson<{
          provider: string;
          results: unknown[];
          availableCount: number;
          resultCount: number;
        }>(await client.call("XSearch", { query: "state:empty" }));
        expect(empty).toMatchObject({
          provider: "bird",
          results: [],
          availableCount: 0,
          resultCount: 0,
        });
        empties[harness] = {
          provider: empty.provider,
          results: empty.results,
          availableCount: empty.availableCount,
          resultCount: empty.resultCount,
        };
      } finally {
        client.close();
        fixture.server.stop();
      }
    }
    expect(errors.codex).toEqual(errors.claude);
    expect(empties.codex).toEqual(empties.claude);
    expect(providers).toHaveLength((states.length + 1) * 2);
    expect(providers.every((provider) => provider.requests.length === 1)).toBe(true);
  });

  test("reports an explicit real-Bird prerequisite and keeps the gate opt-in", async () => {
    const report = await realBirdPrerequisite();
    if (!report.ready) {
      console.info(`[bird acceptance] ${report.reason}`);
      expect(report.reason).toMatch(/Real Bird acceptance (is opt-in|prerequisite unmet)/);
      return;
    }
    expect(report.enabled).toBe(true);
    expect(report.access?.version).toBe("0.8.0");
    expect(report.postId).toMatch(/^\d{1,30}$/);
    expect(report.query).toBeTruthy();
  });

  test("runs the configured real Bird gate using readiness, search, and read only", async () => {
    const report = await realBirdPrerequisite();
    if (!report.enabled) {
      // Portable CI must not invoke a local browser session or network provider.
      expect(report.ready).toBe(false);
      return;
    }
    if (!report.ready || !report.access || !report.postId || !report.query) {
      throw new Error(report.reason);
    }
    const fixture = setupJourney(new BirdXProvider(() => report.access), report.access);
    await fixture.server.start();
    const clients = {
      claude: await startMcp(fixture.server, fixture.scouts.claude.scout.id, "claude"),
      codex: await startMcp(fixture.server, fixture.scouts.codex.scout.id, "codex"),
    };
    try {
      const summaries: Record<Harness, unknown> = {} as Record<Harness, unknown>;
      for (const harness of ["claude", "codex"] as const) {
        const run = fixture.scouts[harness].run;
        const search = resultJson<{
          limit: number;
          provider: string;
          trust: string;
          results: Array<{
            evidenceReference: string;
            sourceAttemptId: string;
            providerIdentity: string;
            canonicalUrl: string;
            text: string;
            available: boolean;
            trust: string;
            provenance: { provider: string };
          }>;
        }>(await clients[harness].call("XSearch", { query: report.query, limit: 5 }));
        expect(search).toMatchObject({ limit: 5, provider: "bird", trust: "untrusted_evidence" });
        expect(search.results.length).toBeLessThanOrEqual(5);
        for (const result of search.results) {
          expect(result).toMatchObject({
            evidenceReference: expect.stringMatching(/^bird-evidence:/),
            sourceAttemptId: expect.any(String),
            providerIdentity: expect.any(String),
            canonicalUrl: expect.stringMatching(/^https:\/\/x\.com\//),
            text: expect.any(String),
            available: true,
            trust: "untrusted_evidence",
            provenance: { provider: "bird" },
          });
        }
        expect(fixture.app.listSignals({ runId: run.id })).toHaveLength(0);
        expect(fixture.app.listSourceAttempts(run.id)).toHaveLength(1);

        const read = resultJson<{
          postId: string;
          evidenceReference: string;
          sourceAttemptId: string;
          canonicalUrl: string;
          providerIdentity: string;
          available: boolean;
          trust: string;
          provenance: { provider: string };
        }>(await clients[harness].call("XRead", { target: report.postId }));
        expect(read).toMatchObject({
          postId: report.postId,
          providerIdentity: report.postId,
          canonicalUrl: expect.stringMatching(/^https:\/\/x\.com\//),
          evidenceReference: expect.stringMatching(/^bird-evidence:/),
          available: true,
          trust: "untrusted_evidence",
          provenance: { provider: "bird" },
        });
        expect(fixture.app.listSourceAttempts(run.id)).toHaveLength(2);
        expect(fixture.app.listSignals({ runId: run.id })).toHaveLength(0);

        const recorded = resultJson<{ signalIds: string[] }>(
          await clients[harness].call("RecordSignal", {
            evidenceReference: read.evidenceReference,
          }),
        );
        expect(recorded.signalIds).toHaveLength(1);
        expect(fixture.app.listSignals({ runId: run.id })).toHaveLength(1);
        await clients[harness].call("complete_run", { outcome: "completed" });
        summaries[harness] = {
          search: {
            provider: search.provider,
            trust: search.trust,
            // Compare contract shape only: live X ranking and result contents can change
            // between the two harness requests.
            resultFields: search.results
              .map((result) => Object.keys(result).sort())
              .sort((a, b) => a.join(",").localeCompare(b.join(","))),
          },
          read: {
            fields: Object.keys(read).sort(),
            postIdPresent: read.postId === report.postId,
            providerIdentityPresent: read.providerIdentity === report.postId,
            available: read.available,
            trust: read.trust,
            provenance: read.provenance,
          },
        };
      }
      // Ranking/order is intentionally not asserted; normalized shape and identity are equivalent.
      expect(summaries.codex).toEqual(summaries.claude);
    } finally {
      clients.claude.close();
      clients.codex.close();
      fixture.server.stop();
    }
  });
});
