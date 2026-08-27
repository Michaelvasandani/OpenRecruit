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

function fixture(
  provider: XProvider,
  resolvedPath = "/private/bird",
  now = () => Date.parse("2026-08-23T16:00:00Z"),
) {
  const app = new RecruitingApplication(makeDb(), now, {
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
  test("RecordSignal accepts one host reference and persists exact host evidence", async () => {
    const provider = new ReadProvider({ status: 200, body: JSON.stringify(responseBody) });
    const { app, scout, run } = fixture(provider);
    const read = await app.xRead({ scoutId: scout.id, target: postId });

    const recorded = app.recordSignalForScout({
      scoutId: scout.id,
      evidenceReference: read.evidenceReference,
    });
    expect(recorded.signalIds).toHaveLength(1);
    expect(app.listSignals()[0]?.evidence).toMatchObject({
      content: responseBody.text,
      canonicalUrl: responseBody.url,
      providerIdentity: postId,
      author: responseBody.author,
    });
    expect(app.listSignals()[0]?.runId).toBe(run.id);

    // Replaying the same host reference is idempotent, not a duplicate Signal.
    const replayed = app.recordSignalForScout({
      scoutId: scout.id,
      evidenceReference: read.evidenceReference,
    });
    expect(replayed.signalIds).toEqual(recorded.signalIds);
    expect(app.listSignals()).toHaveLength(1);
  });

  test("RecordSignal rejects cross-Scout, expired, and terminal-Run references", async () => {
    let now = Date.parse("2026-08-23T16:00:00Z");
    const provider = new ReadProvider({ status: 200, body: JSON.stringify(responseBody) });
    const app = new RecruitingApplication(makeDb(), () => now, {
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
      idempotencyKey: "record-signal-profile",
    });
    const confirmed = app.confirmProfile({
      profileId: profile.id,
      expectedRevision: profile.revision,
      idempotencyKey: "record-signal-profile-confirm",
    });
    const source = app.createXSource({
      name: "Bird X",
      provider: "bird",
      query: "hiring",
      idempotencyKey: "record-signal-source",
    });
    const first = app.createScout({
      name: "First Scout",
      harness: "codex",
      instructionPath: "agents/first",
      defaultProfileId: confirmed.id,
      sourceIds: [source.value.id],
      idempotencyKey: "record-signal-scout-1",
    });
    const second = app.createScout({
      name: "Second Scout",
      harness: "claude",
      instructionPath: "agents/second",
      defaultProfileId: confirmed.id,
      sourceIds: [source.value.id],
      idempotencyKey: "record-signal-scout-2",
    });
    const firstRun = app.launchScoutRun({
      scoutId: first.value.id,
      idempotencyKey: "record-signal-run-1",
    });
    const secondRun = app.launchScoutRun({
      scoutId: second.value.id,
      idempotencyKey: "record-signal-run-2",
    });
    const read = await app.xRead({ scoutId: first.value.id, target: postId });
    expect(() =>
      app.recordSignalForScout({
        scoutId: second.value.id,
        evidenceReference: read.evidenceReference,
      }),
    ).toThrow();
    now += 15 * 60_000 + 1;
    expect(() =>
      app.recordSignalForScout({
        scoutId: first.value.id,
        evidenceReference: read.evidenceReference,
      }),
    ).toThrow(/expired|available|reference/i);

    now = Date.parse("2026-08-23T16:00:00Z");
    const fresh = await app.xRead({ scoutId: first.value.id, target: postId });
    app.completeRunForScout({ scoutId: first.value.id, outcome: "completed" });
    expect(() =>
      app.recordSignalForScout({
        scoutId: first.value.id,
        evidenceReference: fresh.evidenceReference,
      }),
    ).toThrow(/terminal|cannot record|active/i);
    expect(app.listSignals({ runId: firstRun.value.id })).toHaveLength(0);
    expect(app.listSignals({ runId: secondRun.value.id })).toHaveLength(0);
  });

  test("RecordSignal is idempotent for the same public post despite URL formatting changes", async () => {
    const provider = new DeterministicXProvider({
      read: [
        { status: 200, body: JSON.stringify(responseBody) },
        {
          status: 200,
          body: JSON.stringify({
            ...responseBody,
            url: `https://x.com/renamed/status/${postId}`,
          }),
        },
      ],
    });
    const { app, scout } = fixture(provider);
    const first = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: first.evidenceReference });
    const second = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: second.evidenceReference });
    expect(app.listSignals()).toHaveLength(1);
  });

  test("RecordSignal creates a new observation for materially changed post content", async () => {
    const provider = new DeterministicXProvider({
      read: [
        { status: 200, body: JSON.stringify(responseBody) },
        {
          status: 200,
          body: JSON.stringify({ ...responseBody, text: "A different hiring update" }),
        },
      ],
    });
    const { app, scout } = fixture(provider);
    const first = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: first.evidenceReference });
    const second = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: second.evidenceReference });
    expect(app.listSignals()).toHaveLength(2);
    expect(
      app.listSignals().some((signal) => signal.evidence.content === "A different hiring update"),
    ).toBe(true);
  });

  test("revalidates stale Bird evidence, refreshes unchanged metadata, and records the Attempt", async () => {
    let now = Date.parse("2026-08-23T16:00:00Z");
    const provider = new DeterministicXProvider({
      read: [
        { status: 200, body: JSON.stringify(responseBody) },
        { status: 200, body: JSON.stringify(responseBody) },
      ],
    });
    const { app, scout } = fixture(provider, "/private/bird", () => now);
    const first = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: first.evidenceReference });
    const original = app.listSignals()[0];
    if (!original) throw new Error("expected recorded Signal");
    now += 24 * 60 * 60 * 1_000 + 1;
    expect(app.listSignals()[0]?.freshness).toBe("stale");
    expect(app.listSignals()[0]?.evidence.content).toBe("");
    expect(app.listLeads()[0]?.summary).toBeNull();
    app.completeRunForScout({ scoutId: scout.id, outcome: "completed" });
    const revalidationRun = app.launchScoutRun({
      scoutId: scout.id,
      idempotencyKey: "x-read-revalidation-run",
    }).value;

    const refreshed = await app.revalidateXSignal({
      runId: revalidationRun.id,
      signalId: original.id,
    });

    expect(refreshed.outcome).toBe("succeeded_with_items");
    expect(provider.requests.at(-1)?.operation).toBe("read");
    expect(app.listSignals()).toHaveLength(1);
    const current = app.listSignals()[0];
    expect(current?.id).toBe(original.id);
    expect(current?.observedAt).toBe(now);
    expect(current?.retentionUntil).toBe(now + 24 * 60 * 60 * 1_000);
    expect(JSON.parse(refreshed.requestedScope)).toMatchObject({
      revalidation: true,
      requestedPostId: postId,
    });
  });

  test("material revalidation appends immutable evidence and links the superseding Signal", async () => {
    let now = Date.parse("2026-08-23T16:00:00Z");
    const provider = new DeterministicXProvider({
      read: [
        { status: 200, body: JSON.stringify(responseBody) },
        {
          status: 200,
          body: JSON.stringify({ ...responseBody, text: "A materially edited post" }),
        },
      ],
    });
    const { app, scout } = fixture(provider, "/private/bird", () => now);
    const first = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: first.evidenceReference });
    const original = app.listSignals()[0];
    if (!original) throw new Error("expected recorded Signal");
    now += 24 * 60 * 60 * 1_000 + 1;
    app.completeRunForScout({ scoutId: scout.id, outcome: "completed" });
    const revalidationRun = app.launchScoutRun({
      scoutId: scout.id,
      idempotencyKey: "x-read-material-revalidation-run",
    }).value;

    await app.revalidateXSignal({ runId: revalidationRun.id, signalId: original.id });

    const signals = app.listSignals();
    expect(signals).toHaveLength(2);
    expect(signals.find((signal) => signal.id !== original.id)?.supersededSignalId).toBe(
      original.id,
    );
    expect(signals.some((signal) => signal.evidence.content === "A materially edited post")).toBe(
      true,
    );
  });

  test("purges proven-unavailable Bird evidence into a safe tombstone and preserves transient failures", async () => {
    let now = Date.parse("2026-08-23T16:00:00Z");
    const provider = new DeterministicXProvider({
      read: [
        { status: 200, body: JSON.stringify(responseBody) },
        { status: 503, body: "", failureCategory: "provider_failure" },
        { status: 200, body: JSON.stringify({ error: "not found" }) },
        { status: 200, body: JSON.stringify(responseBody) },
        { status: 200, body: JSON.stringify(responseBody) },
      ],
    });
    const { app, scout } = fixture(provider, "/private/bird", () => now);
    const first = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: first.evidenceReference });
    const original = app.listSignals()[0];
    if (!original) throw new Error("expected recorded Signal");
    now += 24 * 60 * 60 * 1_000 + 1;
    app.completeRunForScout({ scoutId: scout.id, outcome: "completed" });
    const revalidationRun = app.launchScoutRun({
      scoutId: scout.id,
      idempotencyKey: "x-read-unavailable-revalidation-run",
    }).value;

    const transient = await app.revalidateXSignal({
      runId: revalidationRun.id,
      signalId: original.id,
    });
    expect(transient.outcome).toBe("transient_failure");
    expect(app.listSignals()).toHaveLength(1);

    const unavailable = await app.revalidateXSignal({
      runId: revalidationRun.id,
      signalId: original.id,
    });
    expect(unavailable.outcome).toBe("rejected");
    expect(app.listSignals()).toHaveLength(0);
    const tombstone = app.inspectEvidence({
      scope: { kind: "item", sourceItemId: original.sourceItemId },
    });
    expect(tombstone.items).toHaveLength(0);

    // An ordinary refresh cannot resurrect an unchanged deleted post.
    await app.readSource({
      runId: revalidationRun.id,
      sourceId: revalidationRun.sourceIds[0] as string,
      readPostId: postId,
      persistItems: true,
    });
    expect(app.listSignals()).toHaveLength(0);

    // An explicit Candidate revalidation can observe the same identity again.
    await app.revalidateXSignal({ runId: revalidationRun.id, sourceItemId: original.sourceItemId });
    expect(app.listSignals()).toHaveLength(1);
  });

  test("an authorized XRead purges a proven-unavailable Signal without persisting success", async () => {
    const provider = new DeterministicXProvider({
      read: [
        { status: 200, body: JSON.stringify(responseBody) },
        { status: 404, body: "" },
      ],
    });
    const { app, scout } = fixture(provider);
    const first = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: first.evidenceReference });
    const signal = app.listSignals()[0];
    if (!signal) throw new Error("expected recorded Signal");

    await expect(app.xRead({ scoutId: scout.id, target: postId })).rejects.toThrow(
      /deleted|unavailable/i,
    );
    expect(app.listSignals()).toHaveLength(0);
    expect(
      app.inspectEvidence({ scope: { kind: "item", sourceItemId: signal.sourceItemId } }).items,
    ).toHaveLength(0);
  });

  test("preserves a Lead supported by another Signal when one X post is unavailable", async () => {
    const secondPost = {
      ...responseBody,
      id: "1900000000000000043",
      text: "A second independently supporting post",
    };
    const provider = new DeterministicXProvider({
      read: [
        { status: 200, body: JSON.stringify(responseBody) },
        { status: 200, body: JSON.stringify(secondPost) },
        { status: 200, body: JSON.stringify({ error: "not found" }) },
      ],
    });
    const { app, scout, run } = fixture(provider);
    const firstRead = await app.xRead({ scoutId: scout.id, target: postId });
    app.recordSignalForScout({ scoutId: scout.id, evidenceReference: firstRead.evidenceReference });
    const secondRead = await app.xRead({ scoutId: scout.id, target: secondPost.id });
    app.recordSignalForScout({
      scoutId: scout.id,
      evidenceReference: secondRead.evidenceReference,
    });
    const first = app.listSignals().find((signal) => signal.providerIdentity === postId);
    const second = app.listSignals().find((signal) => signal.providerIdentity === secondPost.id);
    const lead = app.listLeads().find((candidate) => candidate.signalIds.includes(first?.id ?? ""));
    if (!first || !second || !lead) throw new Error("expected independently supported evidence");
    app.linkSignalToLead({
      leadId: lead.id,
      signalId: second.id,
      expectedRevision: lead.revision,
      idempotencyKey: "x-read-independent-support",
    });
    expect(app.getLead(lead.id)?.signalIds).toEqual(expect.arrayContaining([first.id, second.id]));
    const evaluation = app.createFitEvaluation({
      leadId: lead.id,
      profileVersionId: run.profileVersionId as string,
      runId: run.id,
      hardConstraints: [
        {
          key: "role",
          result: "unknown",
          explanation: "Pending review",
          signalIds: [first.id],
        },
      ],
      preferences: [],
      evidence: [{ signalId: first.id, claim: "Public role evidence", kind: "fact" }],
      idempotencyKey: "x-read-independent-fit",
    });
    const investigation = app.createInvestigation({
      leadId: lead.id,
      question: "Is the role still available?",
      idempotencyKey: "x-read-independent-investigation",
    });
    const attempt = app.recordInvestigationAttempt({
      investigationId: investigation.value.id,
      scoutId: scout.id,
      runId: run.id,
      profileVersionId: run.profileVersionId as string,
      evidence: [{ signalId: first.id, claim: "The role is public", kind: "fact" }],
      conclusion: "The role is available.",
      outcome: "succeeded",
      idempotencyKey: "x-read-independent-attempt",
    });
    const decision = app.recordCandidateDecision({
      leadId: lead.id,
      kind: "review_outcome",
      evidenceSignalIds: [first.id],
      detail: { note: "Reviewed" },
      expectedRevision: app.getLead(lead.id)?.revision ?? 0,
      idempotencyKey: "x-read-independent-decision",
    });
    const opportunity = app.promoteLead({
      leadId: lead.id,
      expectedRevision: app.getLead(lead.id)?.revision,
      idempotencyKey: "x-read-independent-opportunity",
    });

    await app.revalidateXSignal({ runId: run.id, signalId: first.id });

    expect(app.listSignals().map((signal) => signal.id)).toEqual([second.id]);
    expect(app.getLead(lead.id)?.signalIds).toEqual([second.id]);
    expect(app.getLead(lead.id)?.summary).toBe(secondPost.text);
    expect(app.getFitEvaluation(evaluation.id)).toMatchObject({
      freshness: "stale",
      staleReason: "evidence_deleted",
      evidence: [],
    });
    expect(app.getInvestigationAttempt(attempt.value.id)).toMatchObject({
      freshness: "stale",
      outcome: "unknown",
      evidence: [],
    });
    expect(app.getCandidateDecision(decision.value.id)?.detail.evidenceSignalIds).toEqual([]);
    expect(app.getOpportunity(opportunity.value.id)?.state).toBe("active");
  });

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
      const read = (await response.json()) as { postId: string; evidenceReference: string };
      expect(read).toMatchObject({ postId });
      const injection = await fetch(
        `http://127.0.0.1:${server.port}/recruiting/run/record-signal`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ evidenceReference: read.evidenceReference, text: "forged" }),
        },
      );
      expect(injection.status).toBe(400);
      const recorded = await fetch(`http://127.0.0.1:${server.port}/recruiting/run/record-signal`, {
        method: "POST",
        headers,
        body: JSON.stringify({ evidenceReference: read.evidenceReference }),
      });
      expect(recorded.status).toBe(200);
      expect(app.listSignals()).toHaveLength(1);
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
