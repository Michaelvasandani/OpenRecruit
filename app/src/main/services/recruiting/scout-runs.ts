import { createHash, randomUUID } from "node:crypto";
import {
  type ScoutRunPhase as ScoutRunPhaseValue,
  ScoutRunStatus,
  type ScoutRunStatus as ScoutRunStatusValue,
  ScoutRunSummary,
  type ScoutRunSummary as ScoutRunSummaryValue,
  SourceAccessSummary,
  type SourceAccessSummary as SourceAccessSummaryValue,
  SourceAttemptOutcome,
  SourceAttemptSummary,
  type SourceAttemptSummary as SourceAttemptSummaryValue,
  SourceReadiness,
  SourceSummary,
  type SourceSummary as SourceSummaryValue,
} from "@shared/recruiting";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  commandReceipts,
  domainClock,
  profiles,
  profileVersions,
  scoutRuns,
  scoutSources,
  scouts,
  sourceAccess,
  sourceAttempts,
  sources,
} from "../../db/schema";
import { bus } from "../event-bus";
import { assertSafeMaterial } from "./contract";
import { RecruitingError } from "./errors";
import {
  type FeedItem,
  type FeedProvider,
  feedUrlFromConfig,
  HttpFeedProvider,
  parseFeed,
  validateFeedUrl,
} from "./source";

export type CreateSourceCommand = {
  kind: string;
  name: string;
  config?: Record<string, unknown>;
  idempotencyKey: string;
};

export type CreateRssSourceCommand = {
  name: string;
  url: string;
  idempotencyKey: string;
};

export type CreateFeedSourceCommand = CreateRssSourceCommand & {
  kind: "rss" | "atom";
};

export type CheckSourceReadinessCommand = {
  sourceId: string;
  provider?: FeedProvider;
};

export type SetSourceDisabledCommand = {
  sourceId: string;
  disabled: boolean;
};

export type ReadSourceCommand = {
  runId: string;
  sourceId: string;
  provider?: FeedProvider;
  budget?: Partial<RunBudget>;
  retry?: { maxAttempts?: number; baseDelayMs?: number };
};

export type SourceAttemptResult = SourceAttemptSummaryValue & {
  items: FeedItem[];
};

export type SetScoutSourcesCommand = {
  scoutId: string;
  expectedRevision: number;
  sourceIds: string[];
  idempotencyKey: string;
};

export type LaunchScoutRunCommand = {
  scoutId: string;
  profileOverrideId?: string | null;
  strategyOverride?: string | null;
  policyOverride?: string | null;
  budget?: Partial<RunBudget>;
  trigger?: "manual" | "scheduled" | "source_event" | "revisit" | "explicit_request";
  idempotencyKey: string;
};

export type AdvanceScoutRunCommand = {
  runId: string;
  status: ScoutRunStatusValue;
  phase?: ScoutRunPhaseValue;
  checkpoint?: string | null;
  safeFailure?: string | null;
  expectedStatus?: ScoutRunStatusValue;
  idempotencyKey: string;
};

export type RunBudget = {
  maxItems: number;
  maxPages: number;
  maxWallClockMs: number;
  maxSpendCents: number;
};

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxItems: 100,
  maxPages: 10,
  maxWallClockMs: 5 * 60_000,
  maxSpendCents: 0,
};

const ACTIVE_RUN_STATUSES = ["queued", "preflight", "running", "finalizing"] as const;
const TERMINAL_RUN_STATUSES = ["completed", "incomplete", "failed", "cancelled"] as const;
const SAFE_SOURCE_KINDS = /^[a-z][a-z0-9_-]{0,39}$/;

type RecruitingDb = Pick<Db, "select" | "insert" | "update" | "delete">;
type SourceRow = typeof sources.$inferSelect;
type RunRow = typeof scoutRuns.$inferSelect;
type SourceAccessRow = typeof sourceAccess.$inferSelect;
type SourceAttemptRow = typeof sourceAttempts.$inferSelect;
type SourceReadinessValue = SourceAccessSummaryValue["readiness"];
type SourceAccessPatch = Partial<
  Pick<
    SourceAccessRow,
    | "safeFailure"
    | "lastCheckedAt"
    | "lastSuccessAt"
    | "nextAction"
    | "retryAt"
    | "etag"
    | "lastModified"
    | "cursor"
    | "sourceIdentity"
  >
> & {
  readiness: SourceReadinessValue;
};

/**
 * Host-owned Source and bounded Scout Run operations. Provider adapters receive
 * only the resulting safe projections and snapshots; they never receive a Db or
 * arbitrary transport capability.
 */
export class ScoutRunApplication {
  private readonly httpProvider = new HttpFeedProvider();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  createSource(command: CreateSourceCommand): {
    value: SourceSummaryValue;
    revision: number;
    replayed: boolean;
  } {
    const kind = command.kind.trim().toLowerCase();
    const name = command.name.trim();
    requireKey(command.idempotencyKey);
    if (!name || !SAFE_SOURCE_KINDS.test(kind)) {
      throw new RecruitingError("VALIDATION", "Source kind and name are required");
    }
    const config = sanitizeSourceConfig(command.config ?? {});
    if (kind === "rss" || kind === "atom") {
      const configuredUrl = config.feedUrl ?? config.url;
      if (configuredUrl !== undefined) {
        if (typeof configuredUrl !== "string") {
          throw new RecruitingError("VALIDATION", "RSS/Atom Source requires a feed URL");
        }
        config.feedUrl = validateFeedUrl(configuredUrl);
        delete config.url;
      }
    }
    const payloadHash = hashPayload({ kind, name, config });
    let notification: { id: string; revision: number; at: number } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(tx, "source", "root", "create", command.idempotencyKey);
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseReceipt<SourceSummaryValue>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const at = this.now();
      const id = randomUUID();
      tx.insert(sources)
        .values({
          id,
          kind,
          name,
          config: JSON.stringify(config),
          readiness: "not_configured",
          safeFailure: null,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      tx.insert(sourceAccess)
        .values({
          id: randomUUID(),
          sourceId: id,
          accountRef: "",
          scopeKey: "public",
          accessMode: "public",
          readiness: "not_configured",
          safeFailure: null,
          lastCheckedAt: null,
          lastSuccessAt: null,
          nextAction: "Check Source readiness before the first Run",
          retryAt: null,
          etag: null,
          lastModified: null,
          cursor: null,
          sourceIdentity: null,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      const value = toSourceSummary(
        requireSource(tx, id),
        toSourceAccessSummary(requireSourceAccess(tx, id)),
      );
      const revision = advanceRevision(tx);
      writeReceipt(
        tx,
        receiptFor("source", "root", "create", command.idempotencyKey, payloadHash, value, at),
      );
      notification = { id, revision, at };
      return { value, revision, replayed: false };
    });
    if (notification)
      emitChange(
        notification.revision,
        "source",
        [notification.id],
        "source_created",
        notification.at,
      );
    return outcome;
  }

  createRssSource(command: CreateRssSourceCommand) {
    return this.createFeedSource({ ...command, kind: "rss" });
  }

  createAtomSource(command: CreateRssSourceCommand) {
    return this.createFeedSource({ ...command, kind: "atom" });
  }

  createFeedSource(command: CreateFeedSourceCommand) {
    return this.createSource({
      kind: command.kind,
      name: command.name,
      config: { feedUrl: validateFeedUrl(command.url) },
      idempotencyKey: command.idempotencyKey,
    });
  }

  getSourceAccess(
    sourceId: string,
    accountRef = "",
    scopeKey = "public",
  ): SourceAccessSummaryValue | null {
    const row = this.db
      .select()
      .from(sourceAccess)
      .where(
        and(
          eq(sourceAccess.sourceId, sourceId),
          eq(sourceAccess.accountRef, accountRef),
          eq(sourceAccess.scopeKey, scopeKey),
        ),
      )
      .get();
    return row ? toSourceAccessSummary(row) : null;
  }

  setSourceDisabled(command: SetSourceDisabledCommand): SourceAccessSummaryValue {
    const source = requireSource(this.db, command.sourceId);
    ensureSourceAccess(this.db, source.id, this.now());
    const at = this.now();
    const readiness: SourceReadinessValue = command.disabled
      ? "candidate_disabled"
      : "not_configured";
    const safeFailure = command.disabled ? "The Candidate disabled this Source" : null;
    const nextAction = command.disabled
      ? "Enable this Source when the Candidate wants it read again"
      : "Check Source readiness before the next Run";
    const result = this.db.transaction((tx) => {
      const access = requireSourceAccess(tx, source.id);
      tx.update(sourceAccess)
        .set({ readiness, safeFailure, nextAction, retryAt: null, updatedAt: at })
        .where(eq(sourceAccess.id, access.id))
        .run();
      tx.update(sources)
        .set({ readiness, safeFailure, updatedAt: at })
        .where(eq(sources.id, source.id))
        .run();
      return toSourceAccessSummary(requireSourceAccess(tx, source.id));
    });
    emitChange(
      currentRevision(this.db),
      "source",
      [source.id],
      command.disabled ? "source_disabled" : "source_enabled",
      at,
    );
    return result;
  }

  disableSource(sourceId: string) {
    return this.setSourceDisabled({ sourceId, disabled: true });
  }

  enableSource(sourceId: string) {
    return this.setSourceDisabled({ sourceId, disabled: false });
  }

  /** Validate a feed outside SQLite transactions, then persist only safe readiness
   * metadata. Provider payloads, credentials, and transcripts are never stored. */
  async checkSourceReadiness(
    command: CheckSourceReadinessCommand,
  ): Promise<SourceAccessSummaryValue> {
    const source = requireSource(this.db, command.sourceId);
    ensureSourceAccess(this.db, source.id, this.now());
    let url: string;
    try {
      url = feedUrlFromConfig(source.config);
    } catch {
      const checkedAt = this.now();
      this.db.transaction((tx) => {
        const current = requireSourceAccess(tx, source.id);
        tx.update(sourceAccess)
          .set({
            readiness: "not_configured",
            safeFailure: "The RSS/Atom Source has no valid feed URL",
            nextAction: "Configure a valid RSS or Atom feed URL",
            lastCheckedAt: checkedAt,
            updatedAt: checkedAt,
          })
          .where(eq(sourceAccess.id, current.id))
          .run();
        tx.update(sources)
          .set({
            readiness: "not_configured",
            safeFailure: "The RSS/Atom Source has no valid feed URL",
            updatedAt: checkedAt,
          })
          .where(eq(sources.id, source.id))
          .run();
      });
      emitChange(
        currentRevision(this.db),
        "source",
        [source.id],
        "source_readiness_checked",
        checkedAt,
      );
      return toSourceAccessSummary(requireSourceAccess(this.db, source.id));
    }
    const previous = requireSourceAccess(this.db, source.id);
    let patch: SourceAccessPatch;
    try {
      const response = await (command.provider ?? this.httpProvider).fetch({
        url,
        headers: conditionalHeaders(previous),
        cursor: null,
      });
      patch = readinessPatchForResponse(response, this.now());
      if (response.status === 200 && !patch.safeFailure) {
        try {
          const feed = parseFeed(response.body);
          patch.sourceIdentity = feed.identity;
          patch.etag = response.etag ?? previous.etag;
          patch.lastModified = response.lastModified ?? previous.lastModified;
        } catch {
          patch = {
            readiness: "degraded",
            safeFailure: "Feed content could not be parsed as RSS or Atom",
            nextAction: "Verify the feed URL and its published feed format",
            retryAt: null,
          };
        }
      }
    } catch {
      patch = {
        readiness: "degraded",
        safeFailure: "The Source could not be reached",
        nextAction: "Retry the readiness check later",
        retryAt: this.now() + 60_000,
      };
    }
    const checkedAt = this.now();
    const result = this.db.transaction((tx) => {
      const current = requireSourceAccess(tx, source.id);
      const next = {
        ...patch,
        lastCheckedAt: checkedAt,
        lastSuccessAt: patch.readiness === "ready" ? checkedAt : current.lastSuccessAt,
        updatedAt: checkedAt,
        etag: patch.etag ?? current.etag,
        lastModified: patch.lastModified ?? current.lastModified,
        cursor: patch.cursor ?? current.cursor,
        sourceIdentity: patch.sourceIdentity ?? current.sourceIdentity,
      };
      tx.update(sourceAccess).set(next).where(eq(sourceAccess.id, current.id)).run();
      tx.update(sources)
        .set({ readiness: next.readiness, safeFailure: next.safeFailure, updatedAt: checkedAt })
        .where(eq(sources.id, source.id))
        .run();
      return toSourceAccessSummary(requireSourceAccess(tx, source.id));
    });
    emitChange(
      currentRevision(this.db),
      "source",
      [source.id],
      "source_readiness_checked",
      checkedAt,
    );
    return result;
  }

  async readSource(command: ReadSourceCommand): Promise<SourceAttemptResult> {
    const run = requireRun(this.db, command.runId);
    const source = requireSource(this.db, command.sourceId);
    ensureSourceAccess(this.db, source.id, this.now());
    const selectedIds =
      snapshotSourceIds(run.overrideSnapshot) ?? this.selectedSourceIds(run.scoutId);
    if (!selectedIds.includes(source.id)) {
      throw new RecruitingError(
        "VALIDATION",
        `Source ${source.id} is not selected for Run ${run.id}; named Sources are never replaced`,
      );
    }
    const budget = normalizeBudget(command.budget ?? storedBudget(run.budget));
    const requestedScope = JSON.stringify({
      maxItems: budget.maxItems,
      maxPages: budget.maxPages,
      maxWallClockMs: budget.maxWallClockMs,
      maxSpendCents: budget.maxSpendCents,
    });
    const startedAt = this.now();
    const attemptId = randomUUID();
    const access = requireSourceAccess(this.db, source.id);
    this.db.transaction((tx) => {
      tx.insert(sourceAttempts)
        .values({
          id: attemptId,
          runId: run.id,
          sourceId: source.id,
          requestedScope,
          cursor: null,
          outcome: "started",
          itemCount: 0,
          pageCount: 0,
          retryAt: null,
          safeFailure: null,
          startedAt,
          completedAt: null,
        })
        .run();
    });

    const finish = async (
      outcome: SourceAttemptOutcome,
      input: {
        items?: FeedItem[];
        cursor?: string | null;
        pageCount?: number;
        retryAt?: number | null;
        safeFailure?: string | null;
        accessPatch?: SourceAccessPatch;
      } = {},
    ): Promise<SourceAttemptResult> => {
      const completedAt = this.now();
      const items = input.items ?? [];
      const value = this.db.transaction((tx) => {
        const current = requireSourceAccess(tx, source.id);
        const accessPatch = input.accessPatch;
        if (accessPatch) {
          const next = {
            ...accessPatch,
            lastCheckedAt: completedAt,
            lastSuccessAt: accessPatch.readiness === "ready" ? completedAt : current.lastSuccessAt,
            updatedAt: completedAt,
            etag: accessPatch.etag ?? current.etag,
            lastModified: accessPatch.lastModified ?? current.lastModified,
            cursor: accessPatch.cursor ?? current.cursor,
            sourceIdentity: accessPatch.sourceIdentity ?? current.sourceIdentity,
          };
          tx.update(sourceAccess).set(next).where(eq(sourceAccess.id, current.id)).run();
          tx.update(sources)
            .set({
              readiness: next.readiness,
              safeFailure: next.safeFailure,
              updatedAt: completedAt,
            })
            .where(eq(sources.id, source.id))
            .run();
        }
        tx.update(sourceAttempts)
          .set({
            outcome,
            cursor: input.cursor === undefined ? access.cursor : input.cursor,
            itemCount: items.length,
            pageCount: input.pageCount ?? 0,
            retryAt: input.retryAt ?? null,
            safeFailure: input.safeFailure ?? null,
            completedAt,
          })
          .where(eq(sourceAttempts.id, attemptId))
          .run();
        return toSourceAttemptSummary(requireSourceAttempt(tx, attemptId), items);
      });
      emitChange(
        currentRevision(this.db),
        "source",
        [source.id],
        "source_attempt_recorded",
        completedAt,
      );
      return { ...value.summary, items: value.items };
    };

    if (access.readiness === "candidate_disabled") {
      return finish("cancelled", {
        safeFailure: "The Candidate disabled this Source",
        accessPatch: {
          readiness: "candidate_disabled",
          safeFailure: "The Candidate disabled this Source",
          nextAction: "Enable this Source before running it",
          retryAt: null,
        },
      });
    }
    if (access.readiness === "rate_limited" && access.retryAt && access.retryAt > startedAt) {
      return finish("rate_limited", {
        retryAt: access.retryAt,
        safeFailure: "The Source asked OpenRecruit to retry later",
        accessPatch: {
          readiness: "rate_limited",
          safeFailure: "The Source asked OpenRecruit to retry later",
          nextAction: "Retry after the indicated time",
          retryAt: access.retryAt,
        },
      });
    }

    if (source.kind !== "rss" && source.kind !== "atom") {
      return finish("unsupported", {
        safeFailure: "This Source adapter is not available",
        accessPatch: {
          readiness: "degraded",
          safeFailure: "This Source adapter is not available",
          nextAction: "Choose a supported RSS or Atom Source",
          retryAt: null,
        },
      });
    }
    let url: string;
    try {
      url = feedUrlFromConfig(source.config);
    } catch {
      return finish("unsupported", {
        safeFailure: "The RSS/Atom Source has no valid feed URL",
        accessPatch: {
          readiness: "not_configured",
          safeFailure: "The RSS/Atom Source has no valid feed URL",
          nextAction: "Configure a valid RSS or Atom feed URL",
          retryAt: null,
        },
      });
    }
    if (budget.maxPages < 1 || budget.maxItems < 1) {
      return finish("budget_exhausted", {
        safeFailure: "The Run item or page budget was exhausted before retrieval",
        accessPatch: {
          readiness: access.readiness as SourceReadinessValue,
          nextAction: "Increase the Run budget",
          retryAt: null,
        },
      });
    }

    const retry = {
      maxAttempts: Math.max(1, Math.min(command.retry?.maxAttempts ?? 3, 3)),
      baseDelayMs: Math.max(1, Math.min(command.retry?.baseDelayMs ?? 1_000, 60_000)),
    };
    let response: Awaited<ReturnType<FeedProvider["fetch"]>> | undefined;
    let attempts = 0;
    while (attempts < retry.maxAttempts) {
      attempts++;
      if (this.now() - startedAt > budget.maxWallClockMs) {
        return finish("timed_out", {
          safeFailure: "The Source read exceeded its wall-clock budget",
          retryAt: this.now() + retry.baseDelayMs,
          accessPatch: {
            readiness: "degraded",
            safeFailure: "The Source read timed out",
            nextAction: "Retry with a bounded Run",
            retryAt: this.now() + retry.baseDelayMs,
          },
        });
      }
      try {
        response = await (command.provider ?? this.httpProvider).fetch({
          url,
          headers: conditionalHeaders(access),
          cursor: null,
        });
      } catch {
        response = { status: 503, body: "" };
      }
      if (![408, 425, 500, 502, 503, 504].includes(response.status)) break;
      if (attempts >= retry.maxAttempts) break;
    }
    if (!response) {
      return finish("transient_failure", {
        safeFailure: "The Source could not be reached",
        retryAt: startedAt + retry.baseDelayMs,
        accessPatch: {
          readiness: "degraded",
          safeFailure: "The Source could not be reached",
          nextAction: "Retry the Source later",
          retryAt: startedAt + retry.baseDelayMs,
        },
      });
    }
    if (response.status === 304) {
      return finish("not_modified", {
        cursor: null,
        pageCount: 1,
        accessPatch: {
          readiness: "ready",
          safeFailure: null,
          nextAction: "Run the Source again when it is due",
          retryAt: null,
          etag: response.etag ?? access.etag,
          lastModified: response.lastModified ?? access.lastModified,
        },
      });
    }
    if (response.status === 401 || response.status === 407) {
      return finish("blocked", {
        safeFailure: "Source Access requires reauthentication",
        accessPatch: {
          readiness: "reauthentication_required",
          safeFailure: "Source Access requires reauthentication",
          nextAction: "Reauthenticate Source Access",
          retryAt: null,
        },
      });
    }
    if (response.status === 403) {
      return finish("blocked", {
        safeFailure: "The Source blocked this read",
        accessPatch: {
          readiness: "blocked",
          safeFailure: "The Source blocked this read",
          nextAction: "Check Source permissions or choose another Source",
          retryAt: null,
        },
      });
    }
    if (response.status === 429) {
      const retryAt = startedAt + Math.max(0, response.retryAfterMs ?? 60_000);
      return finish("rate_limited", {
        retryAt,
        safeFailure: "The Source asked OpenRecruit to retry later",
        accessPatch: {
          readiness: "rate_limited",
          safeFailure: "The Source asked OpenRecruit to retry later",
          nextAction: "Retry after the indicated time",
          retryAt,
        },
      });
    }
    if ([500, 502, 503, 504, 408, 425].includes(response.status)) {
      const retryAt = startedAt + retry.baseDelayMs;
      return finish("transient_failure", {
        retryAt,
        safeFailure: "The Source is temporarily unavailable",
        accessPatch: {
          readiness: "degraded",
          safeFailure: "The Source is temporarily unavailable",
          nextAction: "Retry the Source later",
          retryAt,
        },
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return finish("blocked", {
        safeFailure: "The Source returned an unavailable response",
        accessPatch: {
          readiness: "blocked",
          safeFailure: "The Source returned an unavailable response",
          nextAction: "Verify the feed URL",
          retryAt: null,
        },
      });
    }
    let spentCents = response.costCents ?? 0;
    if (spentCents > budget.maxSpendCents) {
      return finish("budget_exhausted", {
        pageCount: 1,
        safeFailure: "The Run spend budget was exhausted",
        accessPatch: {
          readiness: access.readiness as SourceReadinessValue,
          nextAction: "Increase the Run spend budget",
          retryAt: null,
        },
      });
    }
    let feed: ReturnType<typeof parseFeed>;
    try {
      feed = parseFeed(response.body);
    } catch {
      return finish("malformed_content", {
        pageCount: 1,
        safeFailure: "The Source returned malformed RSS or Atom content",
        accessPatch: {
          readiness: "degraded",
          safeFailure: "The Source returned malformed RSS or Atom content",
          nextAction: "Verify the feed URL and format",
          retryAt: null,
        },
      });
    }
    let pageCount = 1;
    let nextCursor = response.nextCursor ?? null;
    const allItems = [...feed.items];
    let partialFailure: string | null = null;
    let partialRetryAt: number | null = null;
    let budgetFailure = false;
    let timedOut = false;
    while (nextCursor && pageCount < budget.maxPages && allItems.length < budget.maxItems) {
      if (this.now() - startedAt > budget.maxWallClockMs) {
        partialFailure = "The Source read exceeded its wall-clock budget";
        timedOut = true;
        break;
      }
      let page: Awaited<ReturnType<FeedProvider["fetch"]>> = { status: 503, body: "" };
      let pageAttempts = 0;
      while (pageAttempts < retry.maxAttempts) {
        pageAttempts++;
        try {
          page = await (command.provider ?? this.httpProvider).fetch({
            url,
            headers: {},
            cursor: nextCursor,
          });
        } catch {
          page = { status: 503, body: "" };
        }
        if (![408, 425, 500, 502, 503, 504].includes(page.status)) break;
        if (pageAttempts >= retry.maxAttempts) break;
      }
      pageCount++;
      spentCents += page.costCents ?? 0;
      if (spentCents > budget.maxSpendCents) {
        partialFailure = "The Run spend budget was exhausted";
        budgetFailure = true;
        break;
      }
      if (page.status === 429) {
        partialFailure = "The Source asked OpenRecruit to retry later";
        break;
      }
      if (page.status < 200 || page.status >= 300) {
        partialFailure = "The Source became unavailable after partial progress";
        if ([408, 425, 500, 502, 503, 504].includes(page.status)) {
          partialRetryAt = startedAt + retry.baseDelayMs;
        }
        break;
      }
      try {
        const parsed = parseFeed(page.body);
        allItems.push(...parsed.items);
        feed = parsed;
      } catch {
        partialFailure = "The Source returned malformed content after partial progress";
        break;
      }
      nextCursor = page.nextCursor ?? null;
    }
    const boundedItems = allItems.slice(0, budget.maxItems);
    const exhausted = boundedItems.length < allItems.length || Boolean(nextCursor);
    const outcome: SourceAttemptOutcome = timedOut
      ? "timed_out"
      : budgetFailure
        ? "budget_exhausted"
        : partialFailure
          ? "partial"
          : exhausted
            ? "budget_exhausted"
            : boundedItems.length > 0
              ? "succeeded_with_items"
              : "succeeded_empty";
    const cursor = `feed:${digest(`${feed.identity}\0${boundedItems.at(-1)?.identityKey ?? nextCursor ?? ""}`)}`;
    return finish(outcome, {
      items: boundedItems,
      cursor,
      pageCount,
      safeFailure:
        partialFailure ?? (exhausted ? "The Run item or page budget was exhausted" : null),
      retryAt: partialRetryAt,
      accessPatch: {
        readiness: partialFailure ? "degraded" : "ready",
        safeFailure: partialFailure,
        nextAction: partialFailure
          ? "Retry the Source later to resume bounded progress"
          : "Run the Source again when it is due",
        retryAt: partialRetryAt,
        etag: response.etag ?? access.etag,
        lastModified: response.lastModified ?? access.lastModified,
        sourceIdentity: feed.identity,
      },
    });
  }

  private selectedSourceIds(scoutId: string): string[] {
    return this.db
      .select({ sourceId: scoutSources.sourceId })
      .from(scoutSources)
      .where(eq(scoutSources.scoutId, scoutId))
      .orderBy(asc(scoutSources.selectedAt), asc(scoutSources.sourceId))
      .all()
      .map((row) => row.sourceId);
  }

  listSourceAttempts(runId?: string): SourceAttemptSummaryValue[] {
    const rows = runId
      ? this.db
          .select()
          .from(sourceAttempts)
          .where(eq(sourceAttempts.runId, runId))
          .orderBy(desc(sourceAttempts.startedAt), desc(sourceAttempts.id))
          .all()
      : this.db
          .select()
          .from(sourceAttempts)
          .orderBy(desc(sourceAttempts.startedAt), desc(sourceAttempts.id))
          .all();
    return rows.map((row) => toSourceAttemptSummary(row).summary);
  }

  getSourceAttempt(id: string): SourceAttemptSummaryValue | null {
    const row = this.db.select().from(sourceAttempts).where(eq(sourceAttempts.id, id)).get();
    return row ? toSourceAttemptSummary(row).summary : null;
  }

  listSources(): SourceSummaryValue[] {
    return this.db
      .select()
      .from(sources)
      .orderBy(asc(sources.createdAt), asc(sources.id))
      .all()
      .map((row) => toSourceSummary(row, this.getSourceAccess(row.id)));
  }

  getSource(id: string): SourceSummaryValue | null {
    const row = this.db.select().from(sources).where(eq(sources.id, id)).get();
    return row ? toSourceSummary(row, this.getSourceAccess(row.id)) : null;
  }

  setScoutSources(command: SetScoutSourcesCommand): {
    value: string[];
    revision: number;
    replayed: boolean;
  } {
    requireKey(command.idempotencyKey);
    const sourceIds = [...new Set(command.sourceIds.map((id) => id.trim()).filter(Boolean))].sort();
    const payloadHash = hashPayload({
      scoutId: command.scoutId,
      expectedRevision: command.expectedRevision,
      sourceIds,
    });
    let notification: { revision: number; at: number } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "scout",
        command.scoutId,
        "set_sources",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseReceipt<string[]>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const scout = requireScout(tx, command.scoutId);
      assertScoutRevision(scout, command.expectedRevision);
      assertSourceIdsExist(tx, sourceIds);
      const at = this.now();
      tx.delete(scoutSources).where(eq(scoutSources.scoutId, command.scoutId)).run();
      for (const sourceId of sourceIds) {
        tx.insert(scoutSources)
          .values({ scoutId: command.scoutId, sourceId, selectedAt: at })
          .run();
      }
      tx.update(scouts)
        .set({ revision: scout.revision + 1 })
        .where(eq(scouts.id, command.scoutId))
        .run();
      const revision = advanceRevision(tx);
      writeReceipt(
        tx,
        receiptFor(
          "scout",
          command.scoutId,
          "set_sources",
          command.idempotencyKey,
          payloadHash,
          sourceIds,
          at,
        ),
      );
      notification = { revision, at };
      return { value: sourceIds, revision, replayed: false };
    });
    if (notification)
      emitChange(
        notification.revision,
        "scout",
        [command.scoutId],
        "scout_sources_changed",
        notification.at,
      );
    return outcome;
  }

  listScoutRuns(scoutId?: string): ScoutRunSummaryValue[] {
    const rows = scoutId
      ? this.db
          .select()
          .from(scoutRuns)
          .where(eq(scoutRuns.scoutId, scoutId))
          .orderBy(desc(scoutRuns.createdAt), desc(scoutRuns.id))
          .all()
      : this.db
          .select()
          .from(scoutRuns)
          .orderBy(desc(scoutRuns.createdAt), desc(scoutRuns.id))
          .all();
    return rows.map((row) => this.toRunSummary(this.db, row));
  }

  getScoutRun(id: string): ScoutRunSummaryValue | null {
    const row = this.db.select().from(scoutRuns).where(eq(scoutRuns.id, id)).get();
    return row ? this.toRunSummary(this.db, row) : null;
  }

  launchScoutRun(command: LaunchScoutRunCommand): {
    value: ScoutRunSummaryValue;
    revision: number;
    replayed: boolean;
  } {
    requireKey(command.idempotencyKey);
    const trigger = command.trigger ?? "manual";
    const budget = normalizeBudget(command.budget);
    const payloadHash = hashPayload({
      scoutId: command.scoutId,
      profileOverrideId: command.profileOverrideId ?? null,
      strategyOverride: command.strategyOverride ?? null,
      policyOverride: command.policyOverride ?? null,
      budget,
      trigger,
    });
    let notification: { revision: number; at: number; id: string } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "scout",
        command.scoutId,
        "launch_run",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseReceipt<ScoutRunSummaryValue>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const scout = requireScout(tx, command.scoutId);
      if (scout.lifecycleState !== "active")
        throw new RecruitingError("CONFLICT", "Archived Scouts cannot launch Runs");
      const active = tx
        .select({ id: scoutRuns.id })
        .from(scoutRuns)
        .where(
          and(eq(scoutRuns.scoutId, scout.id), inArray(scoutRuns.status, [...ACTIVE_RUN_STATUSES])),
        )
        .get();
      if (active) {
        throw new RecruitingError(
          "CONFLICT",
          `Scout ${scout.id} already has an active Run (${active.id})`,
        );
      }
      const selectedSources = tx
        .select({ sourceId: scoutSources.sourceId })
        .from(scoutSources)
        .where(eq(scoutSources.scoutId, scout.id))
        .orderBy(asc(scoutSources.selectedAt), asc(scoutSources.sourceId))
        .all()
        .map((row) => row.sourceId);
      if (selectedSources.length === 0) {
        throw new RecruitingError(
          "VALIDATION",
          "Select at least one explicit Source before launching a Scout Run",
        );
      }
      assertSourceIdsExist(tx, selectedSources);
      const profileId = command.profileOverrideId?.trim() || scout.defaultProfileId;
      if (!profileId) {
        throw new RecruitingError(
          "VALIDATION",
          "Select a default confirmed Candidate Profile before launching a Scout Run",
        );
      }
      const profile = requireConfirmedProfile(tx, profileId);
      const version = tx
        .select()
        .from(profileVersions)
        .where(eq(profileVersions.id, profile.currentVersionId as string))
        .get();
      if (!version || version.confirmedAt === null) {
        throw new RecruitingError(
          "VALIDATION",
          `Candidate Profile ${profileId} has no current confirmed Profile Version; confirm it again`,
        );
      }
      const strategy = command.strategyOverride?.trim() || scout.strategyMaterial || "";
      const policy = command.policyOverride?.trim() || scout.policyMaterial || "";
      assertSafeMaterial(strategy, "Discovery Strategy");
      assertSafeMaterial(policy, "Scout Policy");
      const at = this.now();
      const id = randomUUID();
      const profileSnapshot = JSON.stringify({
        id: version.id,
        profileId: version.profileId,
        name: profile.name,
        roleTarget: profile.roleTarget,
        versionNo: version.versionNo,
        markdown: version.markdownSnapshot,
        structured: parseJson(version.structuredSnapshot),
        provenance: parseJson(version.provenance),
        contentHash: version.contentHash,
        confirmedAt: version.confirmedAt,
        immutable: true,
      });
      const overrideSnapshot = JSON.stringify({
        profileOverrideId: command.profileOverrideId?.trim() || null,
        strategyMaterial: command.strategyOverride?.trim() || null,
        policyMaterial: command.policyOverride?.trim() || null,
        sourceIds: selectedSources,
      });
      tx.insert(scoutRuns)
        .values({
          id,
          scoutId: scout.id,
          trigger,
          status: "preflight",
          phase: "preflight",
          budget: JSON.stringify(budget),
          profileVersionId: version.id,
          profileSnapshot,
          strategySnapshot: JSON.stringify({ material: strategy }),
          policySnapshot: JSON.stringify({ material: policy }),
          overrideSnapshot,
          checkpoint: JSON.stringify({ phase: "preflight", completed: true }),
          safeFailure: null,
          startedAt: null,
          completedAt: null,
          createdAt: at,
        })
        .run();
      const value = this.toRunSummary(tx, requireRun(tx, id));
      const revision = advanceRevision(tx);
      writeReceipt(
        tx,
        receiptFor("scout", scout.id, "launch_run", command.idempotencyKey, payloadHash, value, at),
      );
      notification = { revision, at, id };
      return { value, revision, replayed: false };
    });
    if (notification)
      emitChange(
        notification.revision,
        "run",
        [notification.id],
        "run_preflighted",
        notification.at,
      );
    return outcome;
  }

  advanceScoutRun(command: AdvanceScoutRunCommand): {
    value: ScoutRunSummaryValue;
    revision: number;
    replayed: boolean;
  } {
    requireKey(command.idempotencyKey);
    const payloadHash = hashPayload({
      runId: command.runId,
      status: command.status,
      phase: command.phase ?? null,
      checkpoint: command.checkpoint ?? null,
      safeFailure: command.safeFailure ?? null,
      expectedStatus: command.expectedStatus ?? null,
    });
    let notification: { revision: number; at: number } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(tx, "run", command.runId, "advance", command.idempotencyKey);
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseReceipt<ScoutRunSummaryValue>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const row = requireRun(tx, command.runId);
      ScoutRunStatus.parse(command.status);
      const current = ScoutRunStatus.parse(row.status);
      if (command.expectedStatus && current !== command.expectedStatus) {
        throw new RecruitingError(
          "CONFLICT",
          `Run ${row.id} is ${current}; expected ${command.expectedStatus}`,
        );
      }
      if (!isValidTransition(current, command.status)) {
        throw new RecruitingError(
          "CONFLICT",
          `Run ${row.id} cannot transition from ${current} to ${command.status}`,
        );
      }
      const at = this.now();
      const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(command.status);
      tx.update(scoutRuns)
        .set({
          status: command.status,
          phase: command.phase ?? phaseForStatus(command.status),
          checkpoint: command.checkpoint === undefined ? row.checkpoint : command.checkpoint,
          safeFailure: command.safeFailure === undefined ? row.safeFailure : command.safeFailure,
          startedAt: row.startedAt ?? (command.status === "running" ? at : null),
          completedAt: terminal ? at : row.completedAt,
        })
        .where(eq(scoutRuns.id, row.id))
        .run();
      const value = this.toRunSummary(tx, requireRun(tx, row.id));
      const revision = advanceRevision(tx);
      writeReceipt(
        tx,
        receiptFor("run", row.id, "advance", command.idempotencyKey, payloadHash, value, at),
      );
      notification = { revision, at };
      return { value, revision, replayed: false };
    });
    if (notification)
      emitChange(notification.revision, "run", [command.runId], "run_changed", notification.at);
    return outcome;
  }

  private toRunSummary(db: RecruitingDb, row: RunRow): ScoutRunSummaryValue {
    const currentSourceIds = db
      .select({ sourceId: scoutSources.sourceId })
      .from(scoutSources)
      .where(eq(scoutSources.scoutId, row.scoutId))
      .orderBy(asc(scoutSources.selectedAt), asc(scoutSources.sourceId))
      .all()
      .map((item) => item.sourceId);
    const sourceIds = snapshotSourceIds(row.overrideSnapshot) ?? currentSourceIds;
    return ScoutRunSummary.parse({
      id: row.id,
      scoutId: row.scoutId,
      trigger: row.trigger,
      status: row.status,
      phase: row.phase,
      budget: row.budget,
      profileVersionId: row.profileVersionId,
      profileSnapshot: row.profileSnapshot,
      strategySnapshot: row.strategySnapshot,
      policySnapshot: row.policySnapshot,
      overrideSnapshot: row.overrideSnapshot,
      sourceIds,
      checkpoint: row.checkpoint,
      safeFailure: row.safeFailure,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    });
  }
}

function snapshotSourceIds(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { sourceIds?: unknown };
    return Array.isArray(parsed.sourceIds)
      ? parsed.sourceIds.filter((id): id is string => typeof id === "string")
      : null;
  } catch {
    return null;
  }
}

function toSourceSummary(
  row: SourceRow,
  access: SourceAccessSummaryValue | null = null,
): SourceSummaryValue {
  return SourceSummary.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    readiness: SourceReadiness.safeParse(row.readiness).success ? row.readiness : "not_configured",
    safeFailure: row.safeFailure,
    safeReason: row.safeFailure,
    lastCheckedAt: access?.lastCheckedAt ?? null,
    lastSuccessAt: access?.lastSuccessAt ?? null,
    nextAction: access?.nextAction ?? null,
    retryAt: access?.retryAt ?? null,
    access,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toSourceAccessSummary(row: SourceAccessRow): SourceAccessSummaryValue {
  return SourceAccessSummary.parse({
    id: row.id,
    sourceId: row.sourceId,
    accountRef: row.accountRef,
    scopeKey: row.scopeKey,
    accessMode: "public",
    readiness: SourceReadiness.safeParse(row.readiness).success ? row.readiness : "not_configured",
    safeFailure: row.safeFailure,
    safeReason: row.safeFailure,
    lastCheckedAt: row.lastCheckedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastSuccessfulCheckAt: row.lastSuccessAt,
    nextAction: row.nextAction,
    retryAt: row.retryAt,
  });
}

function sanitizeSourceConfig(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(value) as Record<string, unknown>;
}

function sanitizeObject(value: unknown, key?: string): unknown {
  if (
    key &&
    /(token|secret|password|cookie|credential|authorization|bearer|private.?key)/i.test(key)
  ) {
    return undefined;
  }
  if (typeof value === "string") {
    return /(bearer\s+|sk-[a-z0-9]|-----begin)/i.test(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const safe = sanitizeObject(childValue, childKey);
      if (safe !== undefined) result[childKey] = safe;
    }
    return result;
  }
  return value;
}

function normalizeBudget(value: Partial<RunBudget> | undefined): RunBudget {
  const input = value ?? {};
  const result: RunBudget = {
    maxItems: input.maxItems ?? DEFAULT_RUN_BUDGET.maxItems,
    maxPages: input.maxPages ?? DEFAULT_RUN_BUDGET.maxPages,
    maxWallClockMs: input.maxWallClockMs ?? DEFAULT_RUN_BUDGET.maxWallClockMs,
    maxSpendCents: input.maxSpendCents ?? DEFAULT_RUN_BUDGET.maxSpendCents,
  };
  for (const [key, item] of Object.entries(result)) {
    if (!Number.isInteger(item) || item <= 0 || item > 10_000_000) {
      if (key === "maxSpendCents" && item === 0) continue;
      throw new RecruitingError(
        "VALIDATION",
        `Run budget ${key} must be a bounded positive integer`,
      );
    }
  }
  if (result.maxWallClockMs < 1000)
    throw new RecruitingError("VALIDATION", "Run wall-clock budget must be at least one second");
  return result;
}

function storedBudget(value: string): Partial<RunBudget> | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<RunBudget>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function requireConfirmedProfile(db: RecruitingDb, id: string) {
  const row = db.select().from(profiles).where(eq(profiles.id, id)).get();
  if (!row)
    throw new RecruitingError(
      "VALIDATION",
      `Candidate Profile ${id} was not found; select another confirmed Profile`,
    );
  if (row.state !== "confirmed" || !row.currentVersionId) {
    throw new RecruitingError(
      "VALIDATION",
      `Candidate Profile ${id} is not a confirmed Candidate Profile; confirm it before launching a Scout Run`,
    );
  }
  return row;
}

function requireScout(db: RecruitingDb, id: string) {
  const row = db.select().from(scouts).where(eq(scouts.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Scout ${id} was not found`);
  return row;
}

function assertScoutRevision(row: { id: string; revision: number }, expected: number): void {
  if (row.revision !== expected)
    throw new RecruitingError(
      "CONFLICT",
      `Scout ${row.id} is at revision ${row.revision}; expected ${expected}`,
    );
}

function requireSource(db: RecruitingDb, id: string): SourceRow {
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Source ${id} was not found`);
  return row;
}

function requireSourceAccess(db: RecruitingDb, sourceId: string): SourceAccessRow {
  const row = db
    .select()
    .from(sourceAccess)
    .where(
      and(
        eq(sourceAccess.sourceId, sourceId),
        eq(sourceAccess.accountRef, ""),
        eq(sourceAccess.scopeKey, "public"),
      ),
    )
    .get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Source Access for ${sourceId} was not found`);
  return row;
}

function ensureSourceAccess(db: RecruitingDb, sourceId: string, at: number): SourceAccessRow {
  const existing = db
    .select()
    .from(sourceAccess)
    .where(
      and(
        eq(sourceAccess.sourceId, sourceId),
        eq(sourceAccess.accountRef, ""),
        eq(sourceAccess.scopeKey, "public"),
      ),
    )
    .get();
  if (existing) return existing;
  db.insert(sourceAccess)
    .values({
      id: randomUUID(),
      sourceId,
      accountRef: "",
      scopeKey: "public",
      accessMode: "public",
      readiness: "not_configured",
      safeFailure: null,
      lastCheckedAt: null,
      lastSuccessAt: null,
      nextAction: "Check Source readiness before the first Run",
      retryAt: null,
      etag: null,
      lastModified: null,
      cursor: null,
      sourceIdentity: null,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return requireSourceAccess(db, sourceId);
}

function requireSourceAttempt(db: RecruitingDb, id: string): SourceAttemptRow {
  const row = db.select().from(sourceAttempts).where(eq(sourceAttempts.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Source Attempt ${id} was not found`);
  return row;
}

function toSourceAttemptSummary(
  row: SourceAttemptRow,
  items: FeedItem[] = [],
): { summary: SourceAttemptSummaryValue; items: FeedItem[] } {
  return {
    summary: SourceAttemptSummary.parse({
      id: row.id,
      runId: row.runId,
      sourceId: row.sourceId,
      requestedScope: row.requestedScope,
      cursor: row.cursor,
      outcome: SourceAttemptOutcome.safeParse(row.outcome).success
        ? row.outcome
        : "transient_failure",
      itemCount: row.itemCount,
      pageCount: row.pageCount,
      retryAt: row.retryAt,
      safeFailure: row.safeFailure,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }),
    items,
  };
}

function conditionalHeaders(access: SourceAccessRow): Record<string, string> {
  return {
    ...(access.etag ? { "if-none-match": access.etag } : {}),
    ...(access.lastModified ? { "if-modified-since": access.lastModified } : {}),
  };
}

function readinessPatchForResponse(
  response: { status: number; retryAfterMs?: number | null },
  at: number,
): SourceAccessPatch {
  if (response.status === 200 || response.status === 304) {
    return {
      readiness: "ready",
      safeFailure: null,
      nextAction: "Run the Source again when it is due",
      retryAt: null,
    };
  }
  if (response.status === 401 || response.status === 407) {
    return {
      readiness: "reauthentication_required",
      safeFailure: "Source Access requires reauthentication",
      nextAction: "Reauthenticate Source Access",
      retryAt: null,
    };
  }
  if (response.status === 403) {
    return {
      readiness: "blocked",
      safeFailure: "The Source blocked this read",
      nextAction: "Check Source permissions or choose another Source",
      retryAt: null,
    };
  }
  if (response.status === 429) {
    const retryAt = at + Math.max(0, response.retryAfterMs ?? 60_000);
    return {
      readiness: "rate_limited",
      safeFailure: "The Source asked OpenRecruit to retry later",
      nextAction: "Retry after the indicated time",
      retryAt,
    };
  }
  if (response.status >= 500 || response.status === 408 || response.status === 425) {
    return {
      readiness: "degraded",
      safeFailure: "The Source is temporarily unavailable",
      nextAction: "Retry the readiness check later",
      retryAt: at + 60_000,
    };
  }
  return {
    readiness: "blocked",
    safeFailure: "The Source returned an unavailable response",
    nextAction: "Verify the feed URL",
    retryAt: null,
  };
}

function assertSourceIdsExist(db: RecruitingDb, ids: string[]): void {
  const existing = new Set(
    db
      .select({ id: sources.id })
      .from(sources)
      .where(inArray(sources.id, ids))
      .all()
      .map((row) => row.id),
  );
  const missing = ids.find((id) => !existing.has(id));
  if (missing)
    throw new RecruitingError(
      "VALIDATION",
      `Source ${missing} was not found; choose an explicit configured Source`,
    );
}

function requireRun(db: RecruitingDb, id: string): RunRow {
  const row = db.select().from(scoutRuns).where(eq(scoutRuns.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Scout Run ${id} was not found`);
  return row;
}

function isValidTransition(from: ScoutRunStatusValue, to: ScoutRunStatusValue): boolean {
  if (from === to) return true;
  if (from === "queued") return to === "preflight" || to === "cancelled" || to === "failed";
  if (from === "preflight") return to === "running" || to === "cancelled" || to === "failed";
  if (from === "running")
    return to === "finalizing" || to === "incomplete" || to === "failed" || to === "cancelled";
  if (from === "finalizing")
    return to === "completed" || to === "incomplete" || to === "failed" || to === "cancelled";
  return false;
}

function phaseForStatus(status: ScoutRunStatusValue): ScoutRunPhaseValue {
  if (status === "preflight" || status === "queued") return "preflight";
  if (status === "finalizing" || (TERMINAL_RUN_STATUSES as readonly string[]).includes(status))
    return "finalization";
  return "discovery";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function currentRevision(db: RecruitingDb): number {
  return db.select().from(domainClock).where(eq(domainClock.id, 1)).get()?.revision ?? 0;
}

function advanceRevision(db: RecruitingDb): number {
  db.update(domainClock)
    .set({ revision: sql`${domainClock.revision} + 1` })
    .where(eq(domainClock.id, 1))
    .run();
  return currentRevision(db);
}

function emitChange(
  revision: number,
  kind: "scout" | "run" | "source",
  ids: string[],
  reason: string,
  at: number,
): void {
  bus.emitEvent("recruiting:changed", { revision, kind, ids, reason, at });
}

type ReceiptLookup = { result: string | null; payloadHash: string };
function findReceipt(
  db: RecruitingDb,
  scopeKind: string,
  scopeId: string,
  commandKind: string,
  idempotencyKey: string,
): ReceiptLookup | undefined {
  return db
    .select({ result: commandReceipts.result, payloadHash: commandReceipts.payloadHash })
    .from(commandReceipts)
    .where(
      and(
        eq(commandReceipts.scopeKind, scopeKind),
        eq(commandReceipts.scopeId, scopeId),
        eq(commandReceipts.commandKind, commandKind),
        eq(commandReceipts.idempotencyKey, idempotencyKey),
      ),
    )
    .get();
}

function assertReceiptPayload(receipt: ReceiptLookup, payloadHash: string): void {
  if (receipt.payloadHash !== payloadHash)
    throw new RecruitingError(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used with a different command payload",
    );
}

function parseReceipt<T>(result: string | null): T {
  if (!result) throw new RecruitingError("VALIDATION", "Command receipt has no result");
  return JSON.parse(result) as T;
}

function receiptFor(
  scopeKind: string,
  scopeId: string,
  commandKind: string,
  idempotencyKey: string,
  payloadHash: string,
  value: unknown,
  at: number,
): Omit<typeof commandReceipts.$inferInsert, "id"> {
  return {
    scopeKind,
    scopeId,
    commandKind,
    idempotencyKey,
    payloadHash,
    status: "succeeded",
    result: JSON.stringify(value),
    errorCode: null,
    createdAt: at,
    completedAt: at,
  };
}

function writeReceipt(
  db: RecruitingDb,
  receipt: Omit<typeof commandReceipts.$inferInsert, "id">,
): void {
  db.insert(commandReceipts)
    .values({ id: randomUUID(), ...receipt })
    .run();
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function requireKey(value: string): void {
  if (!value.trim()) throw new RecruitingError("VALIDATION", "Idempotency key is required");
}
