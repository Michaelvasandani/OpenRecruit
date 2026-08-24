import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { hostLog } from "../../host/log";
import { AnalyticsService, type CaptureClient } from "../analytics";
import { claudeHarness } from "../harness/claude";
import { createCodexHarness } from "../harness/codex";
import { codexHomeFor } from "../harness/codex-app-server";
import {
  DeterministicWebFetchProvider,
  RecruitingApplication,
  WEB_SEARCH_SOURCE_ID,
  type WebFetchProvider,
  type WebSearchProvider,
  WebSearchProviderError,
  type WebSearchProviderRequest,
  type WebSearchProviderResponse,
} from "../recruiting";
import { SettingsService } from "../settings";
import { buildAgentEnv } from "../terminal/env";
import { LocalApiServer } from ".";

const MCP_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../agent-mcp/index.ts");
const HOST_KEY = "fc-issue-44-host-only-key";

class CaptureProbe implements CaptureClient {
  readonly events: unknown[] = [];

  capture(message: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void {
    this.events.push(message);
  }

  async shutdown(): Promise<void> {}
}

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

class JourneySearchProvider implements WebSearchProvider {
  readonly requests: WebSearchProviderRequest[] = [];

  async search(request: WebSearchProviderRequest): Promise<WebSearchProviderResponse> {
    this.requests.push({ ...request, includeDomains: [...request.includeDomains] });
    if (request.query === "state:missing") {
      throw new WebSearchProviderError("not_configured", "provider detail must stay host-only");
    }
    if (request.query === "state:invalid") {
      throw new WebSearchProviderError("authentication", "provider detail must stay host-only");
    }
    if (request.query === "state:rate-limited") {
      throw new WebSearchProviderError(
        "rate_limited",
        "provider detail must stay host-only",
        null,
        2,
        1,
        10_001,
      );
    }
    if (request.query === "state:transient") {
      throw new WebSearchProviderError(
        "transient_failure",
        "provider detail must stay host-only",
        null,
        null,
        1,
        10_001,
      );
    }
    if (request.query === "state:empty")
      return { requestId: "safe-empty", creditsUsed: 2, results: [] };
    if (request.query === '"Forward Deployed Engineer"') {
      return {
        requestId: "safe-ashby",
        creditsUsed: 2,
        results: [
          {
            title: "Forward Deployed Engineer",
            url: "https://jobs.ashbyhq.com/acme/forward-deployed-engineer",
            description: "Ashby evidence",
          },
          {
            title: "Should be filtered",
            url: "https://example.com/unrelated",
            description: "This result must not escape the restriction",
          },
        ],
      };
    }
    return {
      requestId: "safe-natural",
      creditsUsed: 2,
      results: [
        {
          title: "Resilient developer tools role",
          url: "https://example.com/natural-role",
          description: "Natural-language search evidence",
        },
      ],
    };
  }
}

type McpClient = {
  list(): Promise<RpcResponse>;
  call(name: string, args?: Record<string, unknown>): Promise<RpcResponse>;
  close(): void;
};

async function startMcp(
  server: LocalApiServer,
  agentId: string,
  harness: Harness,
): Promise<McpClient> {
  const child = Bun.spawn([process.execPath, MCP_PATH], {
    env: {
      ...process.env,
      // The provider key intentionally does not appear here. The host callback owns it.
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
    list() {
      return request("tools/list", {});
    },
    async call(name, args = {}) {
      return request("tools/call", { name, arguments: args });
    },
    close() {
      child.kill();
    },
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
  const result = response.result as
    | { content?: Array<{ text?: string }>; isError?: boolean }
    | undefined;
  expect(result?.isError).toBe(true);
  return result?.content?.[0]?.text ?? "";
}

function fixture() {
  const provider = new JourneySearchProvider();
  const fetchProvider: WebFetchProvider = new DeterministicWebFetchProvider({
    "https://jobs.ashbyhq.com/acme/forward-deployed-engineer": {
      title: "Forward Deployed Engineer",
      content: "Selected bounded job-page evidence.",
    },
  });
  const app = new RecruitingApplication(makeDb(), () => 10_000, {
    provider,
    webFetchProvider: fetchProvider,
    webSearchApiKey: () => HOST_KEY,
    webFetchResolveHostname: async () => ["93.184.216.34"],
  });
  const draft = app.importProfile({
    name: "Candidate",
    roleTarget: "Engineer",
    cvText: "Candidate-authored profile material",
    careerInterests: "Developer tools",
    idempotencyKey: "journey-profile-import",
  });
  const profile = app.confirmProfile({
    profileId: draft.id,
    expectedRevision: draft.revision,
    idempotencyKey: "journey-profile-confirm",
  });
  const scouts = Object.fromEntries(
    (["claude", "codex"] as const).map((harness) => {
      const scout = app.createScout({
        name: `${harness} Journey Scout`,
        harness,
        instructionPath: `agents/${harness}-journey`,
        defaultProfileId: profile.id,
        sourceIds: [WEB_SEARCH_SOURCE_ID],
        strategyMaterial: "Find public engineering roles.",
        policyMaterial: "Use selected public Sources only.",
        idempotencyKey: `journey-${harness}-scout`,
      }).value;
      const run = app.launchScoutRun({
        scoutId: scout.id,
        idempotencyKey: `journey-${harness}-run`,
      }).value;
      return [harness, { scout, run }];
    }),
  ) as Record<Harness, { scout: { id: string }; run: { id: string } }>;
  const server = new LocalApiServer({
    port: 0,
    token: "issue-44-token",
    registry: { get: () => undefined },
    arbiter: {},
    recruiting: app,
  } as never);
  return { app, provider, fetchProvider, scouts, server };
}

describe("Issue #44 agent-facing web discovery journey", () => {
  test("Codex and Claude expose equivalent MCP tools, journey outputs, and permissions", async () => {
    const fixtureValue = fixture();
    await fixtureValue.server.start();
    const { app, provider, fetchProvider, scouts, server } = fixtureValue;
    const clients = {
      claude: await startMcp(server, scouts.claude.scout.id, "claude"),
      codex: await startMcp(server, scouts.codex.scout.id, "codex"),
    };
    try {
      const lists = await Promise.all(
        (["claude", "codex"] as const).map(async (harness) => {
          const response = await clients[harness].list();
          const result = response.result as {
            tools?: Array<{ name: string; inputSchema: unknown }>;
          };
          return result.tools?.filter(
            (tool) => tool.name === "WebSearch" || tool.name === "WebFetch",
          );
        }),
      );
      expect(lists[0]).toEqual(lists[1]);
      expect(lists[0]?.map((tool) => tool.name)).toEqual(["WebSearch", "WebFetch"]);

      for (const harness of ["claude", "codex"] as const) {
        const natural = resultJson<{
          results: Array<{ canonicalUrl: string }>;
          provenance: unknown;
        }>(await clients[harness].call("WebSearch", { query: "Find public engineering roles" }));
        expect(natural.results.map((result) => result.canonicalUrl)).toEqual([
          "https://example.com/natural-role",
        ]);
        expect(natural.provenance).toBeDefined();

        const ashby = resultJson<{
          appliedDomainRestrictions: string[];
          results: Array<{ canonicalUrl: string }>;
        }>(
          await clients[harness].call("WebSearch", {
            query: 'site:jobs.ashbyhq.com "Forward Deployed Engineer"',
          }),
        );
        expect(ashby.appliedDomainRestrictions).toEqual(["jobs.ashbyhq.com"]);
        expect(ashby.results.map((result) => result.canonicalUrl)).toEqual([
          "https://jobs.ashbyhq.com/acme/forward-deployed-engineer",
        ]);

        const fetched = resultJson<{ outcomes: Array<{ content?: string; trust?: string }> }>(
          await clients[harness].call("WebFetch", {
            urls: ["https://jobs.ashbyhq.com/acme/forward-deployed-engineer"],
          }),
        );
        expect(fetched.outcomes).toMatchObject([
          { content: "Selected bounded job-page evidence.", trust: "untrusted_evidence" },
        ]);
      }

      const providerRequestsBeforeDisabled = provider.requests.length;
      const fetchRequestsBeforeDisabled = (fetchProvider as DeterministicWebFetchProvider).requests
        .length;
      app.disableSource(WEB_SEARCH_SOURCE_ID);
      for (const harness of ["claude", "codex"] as const) {
        const client = await startMcp(server, scouts[harness].scout.id, harness);
        try {
          const searchError = resultError(
            await client.call("WebSearch", { query: "Find public engineering roles" }),
          );
          const fetchError = resultError(
            await client.call("WebFetch", {
              urls: ["https://jobs.ashbyhq.com/acme/forward-deployed-engineer"],
            }),
          );
          expect(searchError).toContain("disabled_source_access");
          expect(fetchError).toContain("disabled_source_access");
        } finally {
          client.close();
        }
      }
      expect(provider.requests).toHaveLength(providerRequestsBeforeDisabled);
      expect((fetchProvider as DeterministicWebFetchProvider).requests).toHaveLength(
        fetchRequestsBeforeDisabled,
      );
      expect(app.listSourceAttempts()).toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: scouts.claude.run.id })]),
      );
    } finally {
      clients.claude.close();
      clients.codex.close();
      server.stop();
    }
  });

  test("keeps missing, invalid, rate-limited, transient, empty, and partial states distinct", async () => {
    const fixtureValue = fixture();
    await fixtureValue.server.start();
    const { app, provider, fetchProvider, scouts, server } = fixtureValue;
    const client = await startMcp(server, scouts.claude.scout.id, "claude");
    try {
      const states = [
        ["missing", "missing_configuration"],
        ["invalid", "invalid_authentication"],
        ["rate-limited", "rate_limited"],
        ["transient", "exhausted_transient_failure"],
      ] as const;
      const categories = new Map<string, string>();
      for (const [state, category] of states) {
        const error = resultError(await client.call("WebSearch", { query: `state:${state}` }));
        expect(error).toContain(category);
        categories.set(state, error);
      }
      expect(new Set(categories.values()).size).toBe(states.length);

      const empty = resultJson<{ results: unknown[] }>(
        await client.call("WebSearch", { query: "state:empty" }),
      );
      expect(empty.results).toEqual([]);
      const partial = resultJson<{
        outcomes: Array<{ content?: string; error?: { category: string } }>;
      }>(
        await client.call("WebFetch", {
          urls: [
            "https://jobs.ashbyhq.com/acme/forward-deployed-engineer",
            "https://example.com/missing",
          ],
        }),
      );
      expect(partial.outcomes).toEqual([
        expect.objectContaining({ content: "Selected bounded job-page evidence." }),
        expect.objectContaining({ error: expect.objectContaining({ category: "not_found" }) }),
      ]);
      expect(provider.requests.map((request) => request.query)).toEqual(
        expect.arrayContaining([
          "state:missing",
          "state:invalid",
          "state:rate-limited",
          "state:transient",
          "state:empty",
        ]),
      );
      expect((fetchProvider as DeterministicWebFetchProvider).requests).toHaveLength(2);
      expect(app.listSourceAttempts().map((attempt) => attempt.outcome)).toEqual(
        expect.arrayContaining(["succeeded_empty", "partial", "rate_limited", "transient_failure"]),
      );
    } finally {
      client.close();
      server.stop();
    }
  });

  test("keeps the host key and provider payloads out of MCP output and Source Attempts", async () => {
    const fixtureValue = fixture();
    await fixtureValue.server.start();
    const { app, scouts, server } = fixtureValue;
    const clients = {
      claude: await startMcp(server, scouts.claude.scout.id, "claude"),
      codex: await startMcp(server, scouts.codex.scout.id, "codex"),
    };
    try {
      const responses = await Promise.all(
        (["claude", "codex"] as const).map(async (harness) => [
          await clients[harness].call("WebSearch", { query: "Find public engineering roles" }),
          await clients[harness].call("WebFetch", {
            urls: ["https://jobs.ashbyhq.com/acme/forward-deployed-engineer"],
          }),
        ]),
      );
      const persisted = JSON.stringify(app.listSourceAttempts());
      expect(JSON.stringify(responses)).not.toContain(HOST_KEY);
      expect(persisted).not.toContain(HOST_KEY);
      expect(persisted).not.toContain("Selected bounded job-page evidence");
      expect(JSON.stringify(app.listSources())).not.toContain(HOST_KEY);

      const agentEnv = buildAgentEnv("issue-44-agent", { FIRECRAWL_API_KEY: HOST_KEY });
      expect(agentEnv.FIRECRAWL_API_KEY).toBeUndefined();
      expect(JSON.stringify(app.listScouts())).not.toContain(HOST_KEY);

      const configDir = mkdtempSync(join(tmpdir(), "openrecruit-issue-44-config-"));
      const codexHome = codexHomeFor(basename(configDir));
      try {
        claudeHarness.writeConfig?.(configDir, "claude-issue-44");
        createCodexHarness({} as never).writeConfig?.(configDir, "codex-issue-44");
        const generated = [
          readFileSync(join(configDir, ".claude", "settings.json"), "utf8"),
          readFileSync(join(codexHome, "config.toml"), "utf8"),
          readFileSync(join(codexHome, "hooks.json"), "utf8"),
        ].join("\n");
        expect(generated).not.toContain(HOST_KEY);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
        rmSync(codexHome, { recursive: true, force: true });
      }

      const capture = new CaptureProbe();
      const telemetry = new AnalyticsService();
      telemetry.start({ settings: new SettingsService(makeDb()), client: capture });
      try {
        expect(JSON.stringify(capture.events)).not.toContain(HOST_KEY);
      } finally {
        await telemetry.shutdown();
      }

      const log = existsSync(hostLog.file) ? readFileSync(hostLog.file, "utf8") : "";
      expect(log).not.toContain(HOST_KEY);
    } finally {
      clients.claude.close();
      clients.codex.close();
      server.stop();
    }
  });
});
