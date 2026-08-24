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
import { resolveTemplatesDir } from "../agents/paths";
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

type ComparableOutcome = {
  provenance?: {
    provider?: unknown;
    requestId?: unknown;
    sourceId?: unknown;
    runId?: unknown;
    scoutId?: unknown;
  };
  [key: string]: unknown;
};

function comparableOutcomes(outcomes: ComparableOutcome[]): unknown[] {
  return outcomes.map(({ provenance, ...outcome }) => ({
    ...outcome,
    ...(provenance
      ? {
          provenance: {
            provider: provenance.provider,
            requestId: provenance.requestId,
            sourceId: provenance.sourceId,
          },
        }
      : {}),
  }));
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

      const journeySummaries = {} as Record<
        Harness,
        {
          natural: unknown;
          ashby: unknown;
          fetched: unknown;
        }
      >;
      for (const harness of ["claude", "codex"] as const) {
        const natural = resultJson<{
          results: Array<{ canonicalUrl: string }>;
          provenance: { provider: string };
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

        const selectedUrl = ashby.results[0]?.canonicalUrl;
        expect(selectedUrl).toBeDefined();
        const fetched = resultJson<{
          outcomes: Array<{
            canonicalUrl?: string;
            content?: string;
            trust?: string;
          }>;
        }>(
          await clients[harness].call("WebFetch", {
            urls: [selectedUrl],
          }),
        );
        expect(fetched.outcomes).toMatchObject([
          { content: "Selected bounded job-page evidence.", trust: "untrusted_evidence" },
        ]);
        journeySummaries[harness] = {
          natural: {
            results: natural.results,
            provider: natural.provenance.provider,
          },
          ashby: {
            restrictions: ashby.appliedDomainRestrictions,
            results: ashby.results,
          },
          fetched: comparableOutcomes(fetched.outcomes),
        };
      }
      expect(journeySummaries.codex).toEqual(journeySummaries.claude);

      const providerRequestsBeforeDisabled = provider.requests.length;
      const fetchRequestsBeforeDisabled = (fetchProvider as DeterministicWebFetchProvider).requests
        .length;
      app.disableSource(WEB_SEARCH_SOURCE_ID);
      const disabledErrors = {} as Record<Harness, { search: string; fetch: string }>;
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
          disabledErrors[harness] = { search: searchError, fetch: fetchError };
        } finally {
          client.close();
        }
      }
      expect(disabledErrors.codex).toEqual(disabledErrors.claude);
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
    const clients = {
      claude: await startMcp(server, scouts.claude.scout.id, "claude"),
      codex: await startMcp(server, scouts.codex.scout.id, "codex"),
    };
    try {
      const states = [
        ["missing", "missing_configuration"],
        ["invalid", "invalid_authentication"],
        ["rate-limited", "rate_limited"],
        ["transient", "exhausted_transient_failure"],
      ] as const;
      const failureSummaries = {} as Record<
        Harness,
        { errors: Record<string, string>; empty: unknown[]; partial: unknown[] }
      >;
      for (const harness of ["claude", "codex"] as const) {
        const errors: Record<string, string> = {};
        for (const [state, category] of states) {
          const error = resultError(
            await clients[harness].call("WebSearch", { query: `state:${state}` }),
          );
          expect(error).toContain(category);
          errors[state] = error;
        }
        expect(new Set(Object.values(errors)).size).toBe(states.length);

        const empty = resultJson<{ results: unknown[] }>(
          await clients[harness].call("WebSearch", { query: "state:empty" }),
        );
        expect(empty.results).toEqual([]);
        const partial = resultJson<{
          outcomes: Array<{ content?: string; error?: { category: string } }>;
        }>(
          await clients[harness].call("WebFetch", {
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
        failureSummaries[harness] = {
          errors,
          empty: empty.results,
          partial: comparableOutcomes(partial.outcomes),
        };
      }
      expect(failureSummaries.codex).toEqual(failureSummaries.claude);
      expect(provider.requests.map((request) => request.query)).toEqual(
        expect.arrayContaining([
          "state:missing",
          "state:invalid",
          "state:rate-limited",
          "state:transient",
          "state:empty",
        ]),
      );
      expect((fetchProvider as DeterministicWebFetchProvider).requests).toHaveLength(4);
      expect(app.listSourceAttempts().map((attempt) => attempt.outcome)).toEqual(
        expect.arrayContaining(["succeeded_empty", "partial", "rate_limited", "transient_failure"]),
      );
    } finally {
      clients.claude.close();
      clients.codex.close();
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
    const capture = new CaptureProbe();
    const telemetry = new AnalyticsService();
    telemetry.start({ settings: new SettingsService(makeDb()), client: capture });
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

      const telemetryPayload = JSON.stringify(capture.events);
      for (const canary of [
        HOST_KEY,
        "Find public engineering roles",
        "https://example.com/natural-role",
        "Resilient developer tools role",
        "Natural-language search evidence",
        "https://jobs.ashbyhq.com/acme/forward-deployed-engineer",
        "Selected bounded job-page evidence.",
      ]) {
        expect(telemetryPayload).not.toContain(canary);
      }

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

        const templatesDir = resolveTemplatesDir();
        const promptSources = [
          join(templatesDir, "CLAUDE.prefix.md"),
          join(templatesDir, "AGENTS.prefix.codex.md"),
          join(templatesDir, "default", "kickoff.md"),
        ]
          .map((path) => readFileSync(path, "utf8"))
          .join("\n");
        expect(promptSources).not.toContain(HOST_KEY);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
        rmSync(codexHome, { recursive: true, force: true });
      }

      const log = existsSync(hostLog.file) ? readFileSync(hostLog.file, "utf8") : "";
      expect(log).not.toContain(HOST_KEY);
    } finally {
      await telemetry.shutdown();
      clients.claude.close();
      clients.codex.close();
      server.stop();
    }
  });
});
