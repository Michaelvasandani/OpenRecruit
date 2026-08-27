import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import { LocalApiServer } from "../local-api";
import {
  BirdXProvider,
  DeterministicXProvider,
  normalizeBirdReadResponse,
  RecruitingApplication,
  validateXReadTarget,
  type XApiRequest,
  type XApiResponse,
  type XProvider,
} from ".";

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

class ReadProvider implements XProvider {
  readonly requests: XApiRequest[] = [];

  constructor(private readonly response: XApiResponse) {}

  async request(request: XApiRequest): Promise<XApiResponse> {
    this.requests.push(request);
    return this.response;
  }
}

function fixture(provider: XProvider) {
  const app = new RecruitingApplication(makeDb(), () => Date.parse("2026-08-23T16:00:00Z"), {
    birdAccess: () => ({
      configuredPath: "/private/bird",
      resolvedPath: "/private/bird",
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
    idempotencyKey: "x-read-profile",
  });
  const confirmed = app.confirmProfile({
    profileId: profile.id,
    expectedRevision: profile.revision,
    idempotencyKey: "x-read-profile-confirm",
  });
  const source = app.createXSource({
    name: "Bird X",
    provider: "bird",
    query: "hiring",
    idempotencyKey: "x-read-source",
  });
  const scout = app.createScout({
    name: "Bird Scout",
    harness: "codex",
    instructionPath: "agents/bird",
    defaultProfileId: confirmed.id,
    sourceIds: [source.value.id],
    idempotencyKey: "x-read-scout",
  });
  const run = app.launchScoutRun({ scoutId: scout.value.id, idempotencyKey: "x-read-run" });
  return { app, scout: scout.value, run: run.value };
}

const postId = "1900000000000000042";
const responseBody = {
  id: postId,
  url: `https://x.com/bird/status/${postId}`,
  text: "We are hiring a staff engineer",
  createdAt: "2026-08-23T15:00:00.000Z",
  author: { id: "42", username: "bird", name: "Bird" },
  publicMetrics: {
    likeCount: 4,
    replyCount: 2,
    retweetCount: 3,
    quoteCount: 1,
    viewCount: 99,
  },
  conversationId: "1900000000000000001",
  inReplyToStatusId: "1900000000000000002",
  quotedPost: {
    id: "1900000000000000003",
    text: "Quoted post",
    author: { id: "7", username: "quoted", name: "Quoted" },
    quotedPost: { id: "1900000000000000004", text: "must not be followed" },
  },
  media: [
    { url: "https://cdn.example.test/image.jpg" },
    { url: "data:text/plain,secret" },
    { url: "javascript:alert(1)" },
  ],
};

describe("Bird XRead", () => {
  test("accepts one ID or canonical X post URL and rejects other target shapes", () => {
    expect(validateXReadTarget(postId)).toEqual({
      postId,
      canonicalUrl: `https://x.com/i/web/status/${postId}`,
    });
    expect(validateXReadTarget(`https://x.com/bird/status/${postId}`)).toEqual({
      postId,
      canonicalUrl: `https://x.com/bird/status/${postId}`,
    });
    for (const target of [
      "https://x.com/bird",
      "https://x.com/i/lists/42",
      "ftp://x.com/bird/status/42",
      "https://x.com/bird/status/not-a-number",
      "https://x.com/bird/status/42?foo=bar",
      "https://x.com/bird/status/42/extra",
      "42 43",
      "https://example.com/bird/status/42",
    ]) {
      expect(() => validateXReadTarget(target)).toThrow();
    }
    expect(() => validateXReadTarget([postId] as unknown as string)).toThrow();
  });

  test("normalizes one post without following parent, quote, or media", () => {
    const normalized = normalizeBirdReadResponse(JSON.stringify(responseBody), postId);
    expect(normalized.item).toMatchObject({
      providerIdentity: postId,
      canonicalUrl: `https://x.com/bird/status/${postId}`,
      content: "We are hiring a staff engineer",
    });
    expect(normalized.item.metadata?.xRead).toMatchObject({
      postId,
      engagement: { likeCount: 4, replyCount: 2, repostCount: 3, quoteCount: 1, viewCount: 99 },
      conversationId: "1900000000000000001",
      replyParent: { postId: "1900000000000000002" },
      quotedPost: {
        postId: "1900000000000000003",
        text: "Quoted post",
      },
      mediaUrls: ["https://cdn.example.test/image.jpg"],
    });
    const quoted = (normalized.item.metadata?.xRead as { quotedPost?: { quotedPost?: unknown } })
      .quotedPost;
    expect(quoted && "quotedPost" in quoted).toBe(false);
  });

  test("executes one fixed read and defers Signal creation until evidence is recorded", async () => {
    const provider = new ReadProvider({ status: 200, body: JSON.stringify(responseBody) });
    const { app, scout, run } = fixture(provider);
    const result = await app.xRead({ scoutId: scout.id, target: postId });
    expect(result).toMatchObject({
      postId,
      providerIdentity: postId,
      canonicalUrl: `https://x.com/bird/status/${postId}`,
      text: "We are hiring a staff engineer",
      author: { id: "42", username: "bird", name: "Bird" },
      conversationId: "1900000000000000001",
      replyParent: { postId: "1900000000000000002" },
      quotedPost: { postId: "1900000000000000003" },
      mediaUrls: ["https://cdn.example.test/image.jpg"],
      available: true,
      trust: "untrusted_evidence",
      provenance: { provider: "bird" },
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ operation: "read", postIds: [postId] });
    expect(provider.requests[0]?.query).toBeUndefined();
    expect(provider.requests[0]?.maxResults).toBeUndefined();
    const attempt = app.getSourceAttempt(result.sourceAttemptId);
    expect(attempt).toMatchObject({
      runId: run.id,
      sourceId: run.sourceIds[0],
      provider: "bird",
      outcome: "succeeded_with_items",
      itemCount: 1,
    });
    expect(JSON.parse(attempt?.requestedScope ?? "{}")).toMatchObject({
      operation: "bird_x_read",
      requestedPostId: postId,
      returnedIdentities: [postId],
      attemptCount: 1,
      retryDisposition: "not_retried",
    });
    expect(app.listSignals()).toHaveLength(0);
    expect(app.listLeads()).toHaveLength(0);
    app.recordXEvidenceForScout({
      scoutId: scout.id,
      sourceAttemptId: result.sourceAttemptId,
      evidenceReferences: [result.evidenceReference],
    });
    expect(app.listSignals()).toHaveLength(1);
    expect(app.listLeads()).toHaveLength(1);
  });

  test("keeps provider failure outcomes distinguishable and never retries Bird", async () => {
    const provider = new DeterministicXProvider({
      read: { status: 503, body: "", failureCategory: "provider_failure" },
    });
    const { app, scout } = fixture(provider);
    await expect(app.xRead({ scoutId: scout.id, target: postId })).rejects.toThrow(
      /could not complete|temporarily unavailable/i,
    );
    expect(provider.requests).toHaveLength(1);
    const attempts = app.listSourceAttempts();
    expect(attempts[0]).toMatchObject({
      outcome: "transient_failure",
      errorCategory: "provider_failure",
    });
  });

  test("records a cancelled Source Attempt without invoking Bird", async () => {
    const provider = new ReadProvider({ status: 200, body: JSON.stringify(responseBody) });
    const { app, scout } = fixture(provider);
    const controller = new AbortController();
    controller.abort();
    await expect(
      app.xRead({ scoutId: scout.id, target: postId, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
    expect(provider.requests).toHaveLength(0);
    expect(app.listSourceAttempts()[0]).toMatchObject({
      outcome: "cancelled",
      errorCategory: "cancelled",
    });
  });

  test("keeps unavailable, authentication, rate-limit, timeout, unsupported, and malformed outcomes distinct", async () => {
    const cases = [
      {
        response: { status: 200, body: JSON.stringify({ error: { message: "not found" } }) },
        outcome: "rejected",
        errorCategory: "deleted_or_unavailable",
      },
      {
        response: { status: 503, body: "", failureCategory: "authentication" as const },
        outcome: "blocked",
        errorCategory: "authentication",
      },
      {
        response: { status: 429, body: "" },
        outcome: "rate_limited",
        errorCategory: "rate_limited",
      },
      {
        response: { status: 504, body: "" },
        outcome: "timed_out",
        errorCategory: "timed_out",
      },
      {
        response: { status: 426, body: "", failureCategory: "unsupported_version" as const },
        outcome: "unsupported",
        errorCategory: "unsupported_version",
      },
      {
        response: { status: 200, body: "not-json" },
        outcome: "malformed_content",
        errorCategory: "malformed_content",
      },
      {
        response: { status: 200, body: "null" },
        outcome: "malformed_content",
        errorCategory: "malformed_content",
      },
    ] as const;
    for (const testCase of cases) {
      const provider = new DeterministicXProvider({ read: testCase.response });
      const { app, scout } = fixture(provider);
      await expect(app.xRead({ scoutId: scout.id, target: postId })).rejects.toThrow();
      expect(app.listSourceAttempts()[0]).toMatchObject({
        outcome: testCase.outcome,
        errorCategory: testCase.errorCategory,
      });
    }
  });

  test("routes through the authenticated host boundary and rejects arbitrary Bird arguments", async () => {
    const provider = new ReadProvider({ status: 200, body: JSON.stringify(responseBody) });
    const { app, scout } = fixture(provider);
    const server = new LocalApiServer({
      port: 0,
      token: "x-read-test-token",
      registry: { get: () => ({ id: scout.id }) },
      arbiter: {},
      recruiting: app,
    } as never);
    await server.start();
    try {
      const headers = {
        "content-type": "application/json",
        "x-opentrade-token": server.token,
        "x-opentrade-agent": scout.id,
      };
      const response = await fetch(`http://127.0.0.1:${server.port}/x-read`, {
        method: "POST",
        headers,
        body: JSON.stringify({ target: `https://x.com/bird/status/${postId}` }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as { postId: string }).toMatchObject({ postId });
      const rejected = await fetch(`http://127.0.0.1:${server.port}/x-read`, {
        method: "POST",
        headers,
        body: JSON.stringify({ target: postId, args: ["--all"] }),
      });
      expect(rejected.status).toBe(400);
      expect(provider.requests).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("real Bird adapter passes only read ID and json flag", async () => {
    const executable = join(tmpdir(), `openrecruit-bird-read-${crypto.randomUUID()}`);
    writeFileSync(executable, "#!/bin/sh\nprintf '%s' \"$1|$2|$3|$CT0\"");
    chmodSync(executable, 0o755);
    const previous = process.env.CT0;
    process.env.CT0 = "secret-cookie";
    try {
      const result = await new BirdXProvider(() => ({
        configuredPath: executable,
        resolvedPath: executable,
        fingerprint: "fingerprint",
        version: "0.8.0",
        accountIdentity: { id: "42", username: "candidate", displayName: "Candidate" },
      })).request({
        operation: "read",
        postIds: [postId],
        fields: [],
        expansions: [],
        userFields: [],
      });
      expect(result).toMatchObject({ status: 200 });
      expect(result.body).toBe(`read|${postId}|--json|`);
    } finally {
      if (previous === undefined) delete process.env.CT0;
      else process.env.CT0 = previous;
    }
  });
});
