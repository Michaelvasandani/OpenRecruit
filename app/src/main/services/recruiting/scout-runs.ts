import { createHash, randomUUID } from "node:crypto";
import {
  type LeadConflict as LeadConflictValue,
  LeadContext,
  type LeadContext as LeadContextValue,
  LeadSummary,
  type LeadSummary as LeadSummaryValue,
  type ScoutRunPhase as ScoutRunPhaseValue,
  ScoutRunStatus,
  type ScoutRunStatus as ScoutRunStatusValue,
  ScoutRunSummary,
  type ScoutRunSummary as ScoutRunSummaryValue,
  SignalSummary,
  type SignalSummary as SignalSummaryValue,
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
  leadAliases,
  leadSignalLinks,
  leads,
  profiles,
  profileVersions,
  scoutRuns,
  scoutSources,
  scouts,
  signalAttributions,
  signals,
  sourceAccess,
  sourceAttempts,
  sourceItems,
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
import {
  HttpXProvider,
  type NormalizedXPage,
  normalizeXResponse,
  XApiError,
  type XApiResponse,
  type XProvider,
  xConfigFromSource,
  xRequestForLookup,
  xRequestForSearch,
} from "./x";

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

export type CreateXSourceCommand = {
  name: string;
  query?: string;
  postIds?: string[];
  windowHours?: number;
  maxPages?: number;
  maxItems?: number;
  maxSpendCents?: number;
  maxRequestsPerRun?: number;
  /** Accepted for setup convenience but intentionally never persisted. */
  bearerToken?: string;
  idempotencyKey: string;
};

export type CreateFeedSourceCommand = CreateRssSourceCommand & {
  kind: "rss" | "atom";
};

export type CheckSourceReadinessCommand = {
  sourceId: string;
  provider?: FeedProvider | XProvider;
};

export type SetSourceDisabledCommand = {
  sourceId: string;
  disabled: boolean;
};

export type ReadSourceCommand = {
  runId: string;
  sourceId: string;
  provider?: FeedProvider | XProvider;
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

export type LinkSignalToLeadCommand = {
  leadId: string;
  signalId: string;
  relation?: "supporting" | "conflict";
  expectedRevision?: number;
  idempotencyKey: string;
};

export type MergeLeadsCommand = {
  targetLeadId: string;
  sourceLeadId: string;
  expectedRevision?: number;
  expectedSourceRevision?: number;
  idempotencyKey: string;
};

type LeadCommandResult<T> = {
  value: T;
  revision: number;
  replayed: boolean;
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

type SourceAttemptFinish = (
  outcome: SourceAttemptOutcome,
  input?: {
    items?: FeedItem[];
    cursor?: string | null;
    pageCount?: number;
    retryAt?: number | null;
    safeFailure?: string | null;
    accessPatch?: SourceAccessPatch;
  },
) => Promise<SourceAttemptResult>;

/**
 * Host-owned Source and bounded Scout Run operations. Provider adapters receive
 * only the resulting safe projections and snapshots; they never receive a Db or
 * arbitrary transport capability.
 */
export class ScoutRunApplication {
  private readonly httpProvider = new HttpFeedProvider();
  private readonly httpXProvider = new HttpXProvider();

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

  createXSource(command: CreateXSourceCommand) {
    const config: Record<string, unknown> = {
      query: command.query,
      postIds: command.postIds,
      windowHours: command.windowHours,
      maxPages: command.maxPages,
      maxItems: command.maxItems,
      maxSpendCents: command.maxSpendCents,
      maxRequestsPerRun: command.maxRequestsPerRun,
      // bearerToken is accepted only so callers do not need a second setup
      // shape; sanitizeSourceConfig removes it before the Source transaction.
      bearerToken: command.bearerToken,
    };
    return this.createSource({
      kind: "x",
      name: command.name,
      config,
      idempotencyKey: command.idempotencyKey,
    });
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
    if (source.kind === "x") {
      return this.checkXSourceReadiness(source, command.provider as XProvider | undefined);
    }
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
      const response = await (isFeedProvider(command.provider)
        ? command.provider
        : this.httpProvider
      ).fetch({
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

  private async checkXSourceReadiness(
    source: SourceRow,
    provider: XProvider | undefined,
  ): Promise<SourceAccessSummaryValue> {
    ensureSourceAccess(this.db, source.id, this.now());
    let config: ReturnType<typeof xConfigFromSource>;
    try {
      config = xConfigFromSource(source.config);
    } catch (error) {
      const message =
        error instanceof XApiError ? error.message : "X Source configuration is malformed";
      const checkedAt = this.now();
      this.persistSourceReadiness(
        source.id,
        {
          readiness: "not_configured",
          safeFailure: message,
          nextAction: "Configure a bounded recent-search query or public Post IDs",
          retryAt: null,
        },
        checkedAt,
      );
      return toSourceAccessSummary(requireSourceAccess(this.db, source.id));
    }
    const access = requireSourceAccess(this.db, source.id);
    const request = config.postIds.length
      ? xRequestForLookup(config)
      : xRequestForSearch(config, this.now(), null, 10);
    let response: XApiResponse;
    try {
      const candidate = provider ?? this.httpXProvider;
      response =
        "readiness" in candidate && typeof candidate.readiness === "function"
          ? await candidate.readiness(request)
          : await candidate.request(request);
    } catch {
      response = { status: 503, body: "" };
    }
    let patch = xReadinessPatchForResponse(response, this.now());
    if ((response.status === 200 || response.status === 204) && !patch.safeFailure) {
      try {
        normalizeXResponse(response.body || "{}", config.postIds);
      } catch (error) {
        patch = {
          readiness: "degraded",
          safeFailure:
            error instanceof XApiError ? error.message : "X API response could not be parsed",
          nextAction: "Retry readiness after verifying the official X API response",
          retryAt: null,
        };
      }
    }
    if (
      patch.readiness === "ready" &&
      config.maxSpendCents > 0 &&
      (response.costCents ?? 0) > config.maxSpendCents
    ) {
      patch = {
        readiness: "degraded",
        safeFailure: "The configured X Source spend budget is below the API request cost",
        nextAction: "Increase the bounded X Source spend budget or choose a lower-cost plan",
        retryAt: null,
      };
    }
    const checkedAt = this.now();
    this.persistSourceReadiness(
      source.id,
      {
        ...patch,
        lastSuccessAt: patch.readiness === "ready" ? checkedAt : access.lastSuccessAt,
        sourceIdentity: "x-api-v2",
      },
      checkedAt,
    );
    return toSourceAccessSummary(requireSourceAccess(this.db, source.id));
  }

  private persistSourceReadiness(
    sourceId: string,
    patch: SourceAccessPatch & { sourceIdentity?: string | null; lastSuccessAt?: number | null },
    checkedAt: number,
  ): void {
    this.db.transaction((tx) => {
      const current = requireSourceAccess(tx, sourceId);
      const next = {
        ...patch,
        lastCheckedAt: checkedAt,
        lastSuccessAt: patch.lastSuccessAt ?? current.lastSuccessAt,
        updatedAt: checkedAt,
        sourceIdentity: patch.sourceIdentity ?? current.sourceIdentity,
      };
      tx.update(sourceAccess).set(next).where(eq(sourceAccess.id, current.id)).run();
      tx.update(sources)
        .set({ readiness: next.readiness, safeFailure: next.safeFailure, updatedAt: checkedAt })
        .where(eq(sources.id, sourceId))
        .run();
    });
    emitChange(
      currentRevision(this.db),
      "source",
      [sourceId],
      "source_readiness_checked",
      checkedAt,
    );
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

    const finish: SourceAttemptFinish = async (outcome, input = {}) => {
      const completedAt = this.now();
      const items = input.items ?? [];
      const acceptedItems = items.filter(isAttributableItem);
      const quarantinedCount = items.length - acceptedItems.length;
      const value = this.db.transaction((tx) => {
        const current = requireSourceAccess(tx, source.id);
        let persistedAccess = current;
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
          persistedAccess = requireSourceAccess(tx, source.id);
        }
        tx.update(sourceAttempts)
          .set({
            outcome,
            cursor: input.cursor === undefined ? persistedAccess.cursor : input.cursor,
            itemCount: items.length,
            quarantinedCount,
            pageCount: input.pageCount ?? 0,
            retryAt: input.retryAt ?? null,
            safeFailure: input.safeFailure ?? null,
            completedAt,
          })
          .where(eq(sourceAttempts.id, attemptId))
          .run();
        persistSignals(tx, {
          run,
          source,
          sourceAccess: persistedAccess,
          attemptId,
          items,
          observedAt: completedAt,
        });
        return toSourceAttemptSummary(requireSourceAttempt(tx, attemptId), items);
      });
      const revision = this.db.transaction((tx) => advanceRevision(tx));
      emitChange(revision, "source", [source.id], "source_attempt_recorded", completedAt);
      const affectedLeadIds = this.db
        .select({ leadId: leadSignalLinks.leadId })
        .from(leadSignalLinks)
        .innerJoin(signals, eq(signals.id, leadSignalLinks.signalId))
        .where(eq(signals.sourceAttemptId, attemptId))
        .all()
        .map((row) => row.leadId);
      if (affectedLeadIds.length > 0)
        emitChange(
          revision,
          "lead",
          [...new Set(affectedLeadIds)],
          "signals_attributed",
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

    if (source.kind === "x") {
      return this.readXSource({
        source,
        access,
        budget,
        startedAt,
        provider: command.provider as XProvider | undefined,
        retry: command.retry,
        finish,
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
        response = await (isFeedProvider(command.provider)
          ? command.provider
          : this.httpProvider
        ).fetch({
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
          page = await (isFeedProvider(command.provider)
            ? command.provider
            : this.httpProvider
          ).fetch({
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
            : boundedItems.some(isAttributableItem)
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

  private async readXSource(input: {
    source: SourceRow;
    access: SourceAccessRow;
    budget: RunBudget;
    startedAt: number;
    provider?: XProvider;
    retry?: ReadSourceCommand["retry"];
    finish: SourceAttemptFinish;
  }): Promise<SourceAttemptResult> {
    const { source, access, budget, startedAt, finish } = input;
    let config: ReturnType<typeof xConfigFromSource>;
    try {
      config = xConfigFromSource(source.config);
    } catch (error) {
      return finish("unsupported", {
        safeFailure:
          error instanceof XApiError ? error.message : "X Source configuration is malformed",
        accessPatch: {
          readiness: "not_configured",
          safeFailure:
            error instanceof XApiError ? error.message : "X Source configuration is malformed",
          nextAction: "Configure a bounded recent-search query or public Post IDs",
          retryAt: null,
          sourceIdentity: "x-api-v2",
        },
      });
    }
    const maxPages = Math.min(budget.maxPages, config.maxPages, config.maxRequestsPerRun);
    const maxItems = Math.min(budget.maxItems, config.maxItems);
    const maxSpendCents =
      config.maxSpendCents > 0
        ? Math.min(budget.maxSpendCents, config.maxSpendCents)
        : budget.maxSpendCents;
    if (maxPages < 1 || maxItems < 1) {
      return finish("budget_exhausted", {
        safeFailure: "The X Source Run budget was exhausted before retrieval",
        accessPatch: {
          readiness: access.readiness as SourceReadinessValue,
          safeFailure: "The X Source Run budget was exhausted before retrieval",
          nextAction: "Increase the bounded X Source Run budget",
          retryAt: null,
          sourceIdentity: "x-api-v2",
        },
      });
    }
    const provider = input.provider ?? this.httpXProvider;
    const attemptsAllowed = Math.max(1, Math.min(input.retry?.maxAttempts ?? 3, 3));
    const baseDelayMs = Math.max(1, Math.min(input.retry?.baseDelayMs ?? 1_000, 60_000));
    const retentionUntil = startedAt + 24 * 60 * 60 * 1_000;
    const allItems: FeedItem[] = [];
    let nextCursor: string | null = null;
    let pageCount = 0;
    let spentCents = 0;
    let partialFailure: string | null = null;
    let retryAt: number | null = null;
    const lookup = config.postIds.length > 0;

    while (pageCount < maxPages && allItems.length < maxItems) {
      if (this.now() - startedAt > budget.maxWallClockMs) {
        partialFailure = "The X Source read exceeded its wall-clock budget";
        break;
      }
      const request = lookup
        ? xRequestForLookup(config)
        : xRequestForSearch(config, startedAt, nextCursor, Math.min(100, Math.max(10, maxItems)));
      let response: XApiResponse = { status: 503, body: "" };
      let attempts = 0;
      while (attempts < attemptsAllowed) {
        attempts++;
        try {
          response = await provider.request(request);
        } catch {
          response = { status: 503, body: "" };
        }
        if (
          ![408, 425, 500, 502, 503, 504].includes(response.status) ||
          attempts >= attemptsAllowed
        )
          break;
      }
      pageCount++;
      spentCents += response.costCents ?? 0;
      if (spentCents > maxSpendCents) {
        return finish("budget_exhausted", {
          pageCount,
          safeFailure: "The X Source Run spend budget was exhausted",
          accessPatch: {
            readiness: access.readiness as SourceReadinessValue,
            safeFailure: "The X Source Run spend budget was exhausted",
            nextAction: "Increase the bounded X Source spend budget",
            retryAt: null,
            sourceIdentity: "x-api-v2",
          },
        });
      }
      if (response.status === 401) {
        return finish("blocked", {
          pageCount,
          safeFailure: "X App-Only Source Access is not configured or was rejected",
          accessPatch: {
            readiness: "reauthentication_required",
            safeFailure: "X App-Only Source Access is not configured or was rejected",
            nextAction: "Configure an official X API v2 App-Only Bearer Token",
            retryAt: null,
            sourceIdentity: "x-api-v2",
          },
        });
      }
      if (response.status === 403) {
        return finish("blocked", {
          pageCount,
          safeFailure: "X blocked this public API read or the App plan lacks access",
          accessPatch: {
            readiness: "blocked",
            safeFailure: "X blocked this public API read or the App plan lacks access",
            nextAction: "Check the official X App permissions and plan",
            retryAt: null,
            sourceIdentity: "x-api-v2",
          },
        });
      }
      if (response.status === 429) {
        retryAt = startedAt + Math.max(0, response.retryAfterMs ?? 60_000);
        return finish("rate_limited", {
          pageCount,
          retryAt,
          safeFailure: "X asked OpenRecruit to retry after the documented rate limit window",
          accessPatch: {
            readiness: "rate_limited",
            safeFailure: "X asked OpenRecruit to retry after the documented rate limit window",
            nextAction: "Retry after X Retry-After",
            retryAt,
            sourceIdentity: "x-api-v2",
          },
        });
      }
      if ([408, 425, 500, 502, 503, 504].includes(response.status)) {
        retryAt = startedAt + baseDelayMs;
        partialFailure = "X is temporarily unavailable";
        break;
      }
      if (response.status < 200 || response.status >= 300) {
        return finish("blocked", {
          pageCount,
          safeFailure: "X returned an unavailable response",
          accessPatch: {
            readiness: "blocked",
            safeFailure: "X returned an unavailable response",
            nextAction: "Verify the official X API App and Source configuration",
            retryAt: null,
            sourceIdentity: "x-api-v2",
          },
        });
      }
      let page: NormalizedXPage;
      try {
        page = normalizeXResponse(response.body, lookup ? config.postIds : [], retentionUntil);
      } catch (error) {
        return finish("malformed_content", {
          pageCount,
          safeFailure: error instanceof XApiError ? error.message : "X returned malformed content",
          accessPatch: {
            readiness: "degraded",
            safeFailure:
              error instanceof XApiError ? error.message : "X returned malformed content",
            nextAction: "Verify the official X API response and retry",
            retryAt: null,
            sourceIdentity: "x-api-v2",
          },
        });
      }
      allItems.push(...page.items);
      nextCursor = page.nextCursor;
      if (lookup || !nextCursor) break;
    }

    const boundedItems = allItems.slice(0, maxItems);
    const exhausted = boundedItems.length < allItems.length || Boolean(nextCursor);
    const accepted = boundedItems.some(isAttributableItem);
    const outcome: SourceAttemptOutcome = partialFailure
      ? "transient_failure"
      : exhausted
        ? "budget_exhausted"
        : accepted
          ? "succeeded_with_items"
          : "succeeded_empty";
    const cursor = nextCursor
      ? `x:${digest(`${source.id}\0${nextCursor}`)}`
      : `x:${digest(`${source.id}\0${boundedItems.at(-1)?.identityKey ?? ""}`)}`;
    return finish(outcome, {
      items: boundedItems,
      cursor,
      pageCount,
      retryAt,
      safeFailure:
        partialFailure ?? (exhausted ? "The X Source item or page budget was exhausted" : null),
      accessPatch: {
        readiness: partialFailure ? "degraded" : "ready",
        safeFailure: partialFailure,
        nextAction: partialFailure ? "Retry the X Source later" : "Run the X Source again when due",
        retryAt,
        sourceIdentity: "x-api-v2",
      },
    });
  }

  /** Return immutable evidence projections, optionally scoped to a Run or Source. */
  listSignals(filter: { runId?: string; sourceId?: string } = {}): SignalSummaryValue[] {
    let rows = this.db
      .select()
      .from(signals)
      .orderBy(asc(signals.observedAt), asc(signals.id))
      .all();
    if (filter.runId) rows = rows.filter((row) => row.runId === filter.runId);
    if (filter.sourceId) rows = rows.filter((row) => row.sourceId === filter.sourceId);
    return rows.map((row) => toSignalSummary(this.db, row));
  }

  getSignal(id: string): SignalSummaryValue | null {
    const row = this.db.select().from(signals).where(eq(signals.id, id)).get();
    return row ? toSignalSummary(this.db, row) : null;
  }

  /** Leads are durable employment-path identities, never Source Item aliases. */
  listLeads(): LeadSummaryValue[] {
    return this.db
      .select()
      .from(leads)
      .orderBy(desc(leads.updatedAt), asc(leads.id))
      .all()
      .filter((row) => row.mergedInto === null)
      .map((row) => toLeadSummary(this.db, row));
  }

  getLead(id: string): LeadSummaryValue | null {
    const row = this.db.select().from(leads).where(eq(leads.id, id)).get();
    if (!row) return null;
    const canonical = resolveLead(this.db, row);
    return toLeadSummary(this.db, canonical);
  }

  getLeadContext(id: string): LeadContextValue | null {
    const lead = this.getLead(id);
    if (!lead) return null;
    return LeadContext.parse({
      lead,
      signals: lead.signalIds
        .map((signalId) => this.getSignal(signalId))
        .filter((signal): signal is SignalSummaryValue => signal !== null),
    });
  }

  /**
   * Explicitly attach an immutable Signal to another Lead. This is the only
   * path that can mark an identity relationship conflicted; ingestion never
   * guesses when aliases disagree. The operation is revision-aware and can be
   * retried safely with the same idempotency key.
   */
  linkSignalToLead(command: LinkSignalToLeadCommand): LeadCommandResult<LeadSummaryValue> {
    requireKey(command.idempotencyKey);
    if (command.leadId.trim() === command.signalId.trim()) {
      throw new RecruitingError("VALIDATION", "Lead and Signal IDs must be different");
    }
    const relation = command.relation ?? "supporting";
    const payloadHash = hashPayload({
      leadId: command.leadId,
      signalId: command.signalId,
      relation,
      expectedRevision: command.expectedRevision ?? null,
    });
    let notification: { revision: number; at: number; id: string } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "lead",
        command.leadId,
        "link_signal",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          ...parseResult<LeadCommandResult<LeadSummaryValue>>(previous.result),
          replayed: true,
        };
      }
      const rawLead = tx.select().from(leads).where(eq(leads.id, command.leadId)).get();
      if (!rawLead) throw new RecruitingError("NOT_FOUND", `Lead ${command.leadId} was not found`);
      const lead = resolveLead(tx, rawLead);
      if (lead.id !== rawLead.id) {
        throw new RecruitingError(
          "CONFLICT",
          `Lead ${command.leadId} was merged into ${lead.id}; link the Signal to the canonical Lead`,
        );
      }
      if (command.expectedRevision !== undefined && command.expectedRevision !== lead.revision) {
        throw new RecruitingError(
          "CONFLICT",
          `Lead ${lead.id} is at revision ${lead.revision}; expected ${command.expectedRevision}`,
        );
      }
      const signal = tx.select().from(signals).where(eq(signals.id, command.signalId)).get();
      if (!signal)
        throw new RecruitingError("NOT_FOUND", `Signal ${command.signalId} was not found`);
      const existing = tx
        .select()
        .from(leadSignalLinks)
        .where(and(eq(leadSignalLinks.leadId, lead.id), eq(leadSignalLinks.signalId, signal.id)))
        .get();
      let changed = false;
      if (!existing) {
        tx.insert(leadSignalLinks)
          .values({ leadId: lead.id, signalId: signal.id, relation, createdAt: this.now() })
          .run();
        changed = true;
      } else if (relation === "conflict" && existing.relation !== "conflict") {
        tx.update(leadSignalLinks)
          .set({ relation: "conflict" })
          .where(and(eq(leadSignalLinks.leadId, lead.id), eq(leadSignalLinks.signalId, signal.id)))
          .run();
        changed = true;
      }
      if (relation === "conflict") {
        const conflicts = leadConflicts(lead.conflict);
        const conflict = {
          kind: "manual_identity_conflict",
          signalId: signal.id,
          relatedLeadId: null,
          detail: `Signal ${signal.id} was explicitly linked as conflicting evidence`,
        } satisfies LeadConflictValue;
        if (!conflicts.some((item) => item.kind === conflict.kind && item.signalId === signal.id)) {
          conflicts.push(conflict);
          tx.update(leads)
            .set({
              identityState: "conflicted",
              conflict: JSON.stringify(conflicts),
            })
            .where(eq(leads.id, lead.id))
            .run();
          changed = true;
        }
      }
      const at = this.now();
      const revision = changed ? advanceRevision(tx) : currentRevision(tx);
      if (changed) {
        tx.update(leads)
          .set({ updatedAt: at, revision: sql`${leads.revision} + 1` })
          .where(eq(leads.id, lead.id))
          .run();
      }
      const value = toLeadSummary(
        tx,
        tx.select().from(leads).where(eq(leads.id, lead.id)).get() ?? lead,
      );
      const result = { value, revision, replayed: false };
      writeReceipt(
        tx,
        receiptFor(
          "lead",
          command.leadId,
          "link_signal",
          command.idempotencyKey,
          payloadHash,
          result,
          at,
        ),
      );
      if (changed) notification = { revision, at, id: lead.id };
      return result;
    });
    if (notification)
      emitChange(notification.revision, "lead", [notification.id], "lead_linked", notification.at);
    return outcome;
  }

  /**
   * Merge two identity threads after Candidate review. The source row is kept
   * as redirect history; Signal links and settled aliases move to the target,
   * and the target revision advances exactly once.
   */
  mergeLeads(command: MergeLeadsCommand): LeadCommandResult<LeadSummaryValue> {
    requireKey(command.idempotencyKey);
    if (command.targetLeadId === command.sourceLeadId) {
      throw new RecruitingError("VALIDATION", "A Lead cannot be merged into itself");
    }
    const payloadHash = hashPayload({
      targetLeadId: command.targetLeadId,
      sourceLeadId: command.sourceLeadId,
      expectedRevision: command.expectedRevision ?? null,
      expectedSourceRevision: command.expectedSourceRevision ?? null,
    });
    let notification: { revision: number; at: number; ids: string[] } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "lead",
        command.targetLeadId,
        "merge",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          ...parseResult<LeadCommandResult<LeadSummaryValue>>(previous.result),
          replayed: true,
        };
      }
      const rawTarget = tx.select().from(leads).where(eq(leads.id, command.targetLeadId)).get();
      const rawSource = tx.select().from(leads).where(eq(leads.id, command.sourceLeadId)).get();
      if (!rawTarget)
        throw new RecruitingError("NOT_FOUND", `Lead ${command.targetLeadId} was not found`);
      if (!rawSource)
        throw new RecruitingError("NOT_FOUND", `Lead ${command.sourceLeadId} was not found`);
      const target = resolveLead(tx, rawTarget);
      const source = resolveLead(tx, rawSource);
      if (target.id === source.id) {
        if (
          command.expectedRevision !== undefined &&
          command.expectedRevision !== target.revision
        ) {
          throw new RecruitingError(
            "CONFLICT",
            `Lead ${target.id} is at revision ${target.revision}; expected ${command.expectedRevision}`,
          );
        }
        const value = toLeadSummary(tx, target);
        const result = { value, revision: currentRevision(tx), replayed: false };
        writeReceipt(
          tx,
          receiptFor(
            "lead",
            command.targetLeadId,
            "merge",
            command.idempotencyKey,
            payloadHash,
            result,
            this.now(),
          ),
        );
        return result;
      }
      if (command.expectedRevision !== undefined && command.expectedRevision !== target.revision) {
        throw new RecruitingError(
          "CONFLICT",
          `Lead ${target.id} is at revision ${target.revision}; expected ${command.expectedRevision}`,
        );
      }
      if (
        command.expectedSourceRevision !== undefined &&
        command.expectedSourceRevision !== source.revision
      ) {
        throw new RecruitingError(
          "CONFLICT",
          `Lead ${source.id} is at revision ${source.revision}; expected ${command.expectedSourceRevision}`,
        );
      }
      const at = this.now();
      const sourceLinks = tx
        .select()
        .from(leadSignalLinks)
        .where(eq(leadSignalLinks.leadId, source.id))
        .all();
      for (const link of sourceLinks) {
        tx.insert(leadSignalLinks)
          .values({
            leadId: target.id,
            signalId: link.signalId,
            relation: link.relation,
            createdAt: link.createdAt,
          })
          .onConflictDoNothing()
          .run();
      }
      tx.delete(leadSignalLinks).where(eq(leadSignalLinks.leadId, source.id)).run();

      const sourceAliases = tx
        .select()
        .from(leadAliases)
        .where(eq(leadAliases.leadId, source.id))
        .all();
      for (const alias of sourceAliases) {
        const collision = tx
          .select()
          .from(leadAliases)
          .where(and(eq(leadAliases.kind, alias.kind), eq(leadAliases.value, alias.value)))
          .get();
        if (!collision || collision.leadId === source.id) {
          tx.update(leadAliases)
            .set({ leadId: target.id })
            .where(eq(leadAliases.id, alias.id))
            .run();
        } else if (resolveLeadId(tx, collision.leadId) !== target.id) {
          const conflicts = leadConflicts(target.conflict);
          const detail = `Alias ${alias.kind}:${alias.value} also belongs to Lead ${collision.leadId}`;
          if (!conflicts.some((item) => item.detail === detail)) {
            conflicts.push({
              kind: "alias_collision",
              relatedLeadId: collision.leadId,
              detail,
            });
            tx.update(leads)
              .set({ identityState: "conflicted", conflict: JSON.stringify(conflicts) })
              .where(eq(leads.id, target.id))
              .run();
          }
          tx.delete(leadAliases).where(eq(leadAliases.id, alias.id)).run();
        } else {
          tx.delete(leadAliases).where(eq(leadAliases.id, alias.id)).run();
        }
      }
      tx.update(leads)
        .set({
          mergedInto: target.id,
          conflict: JSON.stringify([
            ...leadConflicts(source.conflict),
            {
              kind: "merged",
              relatedLeadId: target.id,
              detail: `Merged into canonical Lead ${target.id}`,
            },
          ]),
          updatedAt: at,
          revision: sql`${leads.revision} + 1`,
        })
        .where(eq(leads.id, source.id))
        .run();
      tx.update(leads)
        .set({ updatedAt: at, revision: sql`${leads.revision} + 1` })
        .where(eq(leads.id, target.id))
        .run();
      const revision = advanceRevision(tx);
      const value = toLeadSummary(
        tx,
        tx.select().from(leads).where(eq(leads.id, target.id)).get() ?? target,
      );
      const result = { value, revision, replayed: false };
      writeReceipt(
        tx,
        receiptFor(
          "lead",
          command.targetLeadId,
          "merge",
          command.idempotencyKey,
          payloadHash,
          result,
          at,
        ),
      );
      notification = { revision, at, ids: [target.id, source.id] };
      return result;
    });
    if (notification)
      emitChange(notification.revision, "lead", notification.ids, "leads_merged", notification.at);
    return outcome;
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
    const runSignalIds = db
      .select({ id: signals.id })
      .from(signals)
      .where(eq(signals.runId, row.id))
      .orderBy(asc(signals.observedAt), asc(signals.id))
      .all()
      .map((signal) => signal.id);
    const runLeadIds = runSignalIds.length
      ? db
          .select({ leadId: leadSignalLinks.leadId })
          .from(leadSignalLinks)
          .innerJoin(signals, eq(signals.id, leadSignalLinks.signalId))
          .where(eq(signals.runId, row.id))
          .orderBy(asc(leadSignalLinks.createdAt), asc(leadSignalLinks.leadId))
          .all()
          .map((lead) => lead.leadId)
      : [];
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
      signalIds: runSignalIds,
      leadIds: [...new Set(runLeadIds)],
      checkpoint: row.checkpoint,
      safeFailure: row.safeFailure,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    });
  }
}

type SignalPersistenceInput = {
  run: RunRow;
  source: SourceRow;
  sourceAccess: SourceAccessRow;
  attemptId: string;
  items: FeedItem[];
  observedAt: number;
};

function isAttributableItem(item: FeedItem): boolean {
  // Content-derived identity is useful for parsing and bounded Attempt metrics,
  // but it is not attributable evidence. Signals require a provider identity or
  // a canonical public URL so a Candidate can inspect their provenance later.
  return Boolean(
    (item.providerIdentity || item.canonicalUrl) &&
      item.metadata?.state !== "deleted" &&
      item.metadata?.state !== "protected" &&
      item.metadata?.state !== "withheld" &&
      item.metadata?.state !== "deleted_or_unavailable",
  );
}

function isUnavailableItem(item: FeedItem): boolean {
  return (
    item.metadata?.state === "deleted" ||
    item.metadata?.state === "protected" ||
    item.metadata?.state === "withheld" ||
    item.metadata?.state === "deleted_or_unavailable"
  );
}

function persistSignals(db: RecruitingDb, input: SignalPersistenceInput): void {
  const strategyMaterial = strategyMaterialFromSnapshot(input.run.strategySnapshot);
  const strategyKey = digest(strategyMaterial);
  for (const item of input.items) {
    if (!isAttributableItem(item) && !isUnavailableItem(item)) continue;
    const identityKey = stableItemIdentity(item);
    let sourceItem = db
      .select()
      .from(sourceItems)
      .where(
        and(eq(sourceItems.sourceId, input.source.id), eq(sourceItems.identityKey, identityKey)),
      )
      .get();
    if (!sourceItem) {
      const id = randomUUID();
      db.insert(sourceItems)
        .values({
          id,
          sourceId: input.source.id,
          identityKey,
          canonicalUrl: item.canonicalUrl,
          providerIdentity: item.providerIdentity,
          latestFingerprint: null,
          latestSignalId: null,
          deletionMarkerAt: null,
          createdAt: input.observedAt,
          updatedAt: input.observedAt,
        })
        .run();
      sourceItem = db.select().from(sourceItems).where(eq(sourceItems.id, id)).get();
    }
    if (!sourceItem) continue;

    if (isUnavailableItem(item)) {
      const oldSignals = db
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.sourceItemId, sourceItem.id))
        .all();
      const oldLeadIds = db
        .select({ leadId: leadSignalLinks.leadId })
        .from(leadSignalLinks)
        .where(
          inArray(
            leadSignalLinks.signalId,
            oldSignals.length ? oldSignals.map((signal) => signal.id) : [""],
          ),
        )
        .all()
        .map((link) => link.leadId);
      for (const oldSignal of oldSignals) {
        db.delete(leadSignalLinks).where(eq(leadSignalLinks.signalId, oldSignal.id)).run();
        db.delete(signalAttributions).where(eq(signalAttributions.signalId, oldSignal.id)).run();
        db.delete(signals).where(eq(signals.id, oldSignal.id)).run();
      }
      for (const leadId of new Set(oldLeadIds)) {
        const remaining = db
          .select({ signalId: leadSignalLinks.signalId })
          .from(leadSignalLinks)
          .where(eq(leadSignalLinks.leadId, leadId))
          .limit(1)
          .get();
        if (!remaining) {
          db.delete(leadAliases).where(eq(leadAliases.leadId, leadId)).run();
          db.delete(leads).where(eq(leads.id, leadId)).run();
        }
      }
      db.update(sourceItems)
        .set({
          canonicalUrl: sourceItem.canonicalUrl,
          providerIdentity: item.providerIdentity ?? sourceItem.providerIdentity,
          latestFingerprint: null,
          latestSignalId: null,
          deletionMarkerAt: input.observedAt,
          updatedAt: input.observedAt,
        })
        .where(eq(sourceItems.id, sourceItem.id))
        .run();
      continue;
    }
    const fingerprint = itemFingerprint(item);
    const existing = db
      .select()
      .from(signals)
      .where(and(eq(signals.sourceItemId, sourceItem.id), eq(signals.fingerprint, fingerprint)))
      .get();
    const previousSignalId = sourceItem.latestSignalId;
    let signalId = existing?.id;
    if (!existing) {
      signalId = randomUUID();
      const evidence = {
        title: item.title,
        content: item.content,
        canonicalUrl: item.canonicalUrl,
        providerIdentity: item.providerIdentity,
        sourceIdentity: input.sourceAccess.sourceIdentity,
        ...(item.metadata?.author ? { author: item.metadata.author } : {}),
        ...(item.metadata?.editHistory ? { editHistory: item.metadata.editHistory } : {}),
        ...(item.metadata?.withheld ? { withheld: item.metadata.withheld } : {}),
        ...(item.metadata?.protected !== undefined ? { protected: item.metadata.protected } : {}),
      };
      const isX = item.metadata?.provider === "x-api-v2";
      db.insert(signals)
        .values({
          id: signalId,
          sourceItemId: sourceItem.id,
          sourceId: input.source.id,
          sourceAttemptId: input.attemptId,
          runId: input.run.id,
          fingerprint,
          provenance: JSON.stringify({
            sourceId: input.source.id,
            sourceKind: input.source.kind,
            sourceAttemptId: input.attemptId,
            runId: input.run.id,
            scoutId: input.run.scoutId,
            sourceIdentity: input.sourceAccess.sourceIdentity,
            accessMode: "public",
            adapterVersion: isX ? "x-api-v2" : "rss-atom-v1",
            processor: isX ? "openrecruit-x-api" : "openrecruit-rss-atom",
            ...(isX && item.metadata?.author ? { author: item.metadata.author } : {}),
            ...(isX ? { authMode: "app_only", editHistory: item.metadata?.editHistory ?? [] } : {}),
            strategyKey,
          }),
          publicationAt: item.publicationAt,
          observedAt: input.observedAt,
          retrievedAt: input.observedAt,
          evidence: JSON.stringify(evidence),
          accessMode: "public",
          adapterVersion: isX ? "x-api-v2" : "rss-atom-v1",
          processor: isX ? "openrecruit-x-api" : "openrecruit-rss-atom",
          retentionUntil:
            item.retentionUntil ??
            item.metadata?.retentionUntil ??
            input.observedAt + 30 * 24 * 60 * 60 * 1_000,
          supersededSignalId: previousSignalId,
          createdAt: input.observedAt,
        })
        .run();
    }
    if (!signalId) continue;
    db.update(sourceItems)
      .set({
        canonicalUrl: item.canonicalUrl ?? sourceItem.canonicalUrl,
        providerIdentity: item.providerIdentity ?? sourceItem.providerIdentity,
        latestFingerprint: fingerprint,
        latestSignalId: signalId,
        updatedAt: input.observedAt,
      })
      .where(eq(sourceItems.id, sourceItem.id))
      .run();

    const priorLeadId = previousSignalId
      ? db
          .select({ leadId: leadSignalLinks.leadId })
          .from(leadSignalLinks)
          .where(eq(leadSignalLinks.signalId, previousSignalId))
          .get()?.leadId
      : undefined;
    const lead = ensureLead(db, item, input.observedAt, priorLeadId);
    const linkResult = db
      .insert(leadSignalLinks)
      .values({ leadId: lead.id, signalId, relation: "supporting", createdAt: input.observedAt })
      .onConflictDoNothing()
      .run();
    const attributionResult = db
      .insert(signalAttributions)
      .values({
        signalId,
        runId: input.run.id,
        scoutId: input.run.scoutId,
        strategyKey,
        createdAt: input.observedAt,
      })
      .onConflictDoNothing()
      .run();
    if (linkResult.changes > 0 || attributionResult.changes > 0) {
      db.update(leads)
        .set({ updatedAt: input.observedAt, revision: sql`${leads.revision} + 1` })
        .where(eq(leads.id, lead.id))
        .run();
    }
  }
}

function ensureLead(
  db: RecruitingDb,
  item: FeedItem,
  at: number,
  preferredLeadId?: string,
): typeof leads.$inferSelect {
  const aliases = [
    item.canonicalUrl ? { kind: "canonical_url", value: item.canonicalUrl } : null,
    item.providerIdentity ? { kind: "provider_identity", value: item.providerIdentity } : null,
  ].filter((alias): alias is { kind: string; value: string } => alias !== null);
  let lead: typeof leads.$inferSelect | undefined;
  const matchingLeadIds = new Set<string>();
  for (const alias of aliases) {
    const match = db
      .select({ lead: leads })
      .from(leadAliases)
      .innerJoin(leads, eq(leads.id, leadAliases.leadId))
      .where(and(eq(leadAliases.kind, alias.kind), eq(leadAliases.value, alias.value)))
      .get();
    if (match?.lead) matchingLeadIds.add(resolveLeadId(db, match.lead.id));
  }
  const preferredId = preferredLeadId ? resolveLeadId(db, preferredLeadId) : null;
  if (preferredId && (matchingLeadIds.size === 0 || matchingLeadIds.has(preferredId))) {
    const row = db.select().from(leads).where(eq(leads.id, preferredId)).get();
    if (row) lead = row;
  } else if (matchingLeadIds.size === 1) {
    const id = [...matchingLeadIds][0];
    const row = db.select().from(leads).where(eq(leads.id, id)).get();
    if (row) lead = row;
  }
  if (!lead) {
    const canonicalKeyBase = item.canonicalUrl
      ? `url:${item.canonicalUrl}`
      : `provider:${item.providerIdentity}`;
    const id = randomUUID();
    const ambiguous = matchingLeadIds.size > 1;
    const canonicalKey = ambiguous
      ? `ambiguous:${digest(`${canonicalKeyBase}:${[...matchingLeadIds].sort().join(",")}`)}:${id}`
      : canonicalKeyBase;
    db.insert(leads)
      .values({
        id,
        canonicalKey,
        title: item.title,
        summary: item.content,
        identityState: ambiguous ? "conflicted" : "settled",
        conflict: ambiguous
          ? JSON.stringify([
              {
                kind: "alias_collision",
                relatedLeadId: null,
                detail: `Identity aliases matched Leads ${[...matchingLeadIds].join(", ")}`,
              },
            ])
          : null,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    lead = db.select().from(leads).where(eq(leads.id, id)).get();
  }
  if (!lead) throw new RecruitingError("VALIDATION", "Signal Lead could not be persisted");
  if (matchingLeadIds.size > 1 && matchingLeadIds.has(lead.id)) {
    const conflicts = leadConflicts(lead.conflict);
    const detail = `Identity aliases matched Leads ${[...matchingLeadIds].join(", ")}`;
    if (!conflicts.some((conflict) => conflict.detail === detail)) {
      conflicts.push({ kind: "alias_collision", relatedLeadId: null, detail });
      db.update(leads)
        .set({ identityState: "conflicted", conflict: JSON.stringify(conflicts) })
        .where(eq(leads.id, lead.id))
        .run();
      lead = db.select().from(leads).where(eq(leads.id, lead.id)).get() ?? lead;
    }
  }
  // An alias collision is intentionally left untouched. It means the item has
  // multiple plausible identity threads; only an explicit Candidate command
  // may settle that relationship.
  for (const alias of aliases) {
    const existing = db
      .select({ leadId: leadAliases.leadId })
      .from(leadAliases)
      .where(and(eq(leadAliases.kind, alias.kind), eq(leadAliases.value, alias.value)))
      .get();
    if (!existing || resolveLeadId(db, existing.leadId) === lead.id) {
      db.insert(leadAliases)
        .values({ id: randomUUID(), leadId: lead.id, kind: alias.kind, value: alias.value })
        .onConflictDoNothing()
        .run();
    }
  }
  return lead;
}

function resolveLeadId(db: RecruitingDb, id: string): string {
  let current = id;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const row = db.select().from(leads).where(eq(leads.id, current)).get();
    if (!row?.mergedInto || row.mergedInto === current) return current;
    current = row.mergedInto;
  }
  return current;
}

function resolveLead(db: RecruitingDb, row: typeof leads.$inferSelect): typeof leads.$inferSelect {
  const id = resolveLeadId(db, row.id);
  return id === row.id ? row : (db.select().from(leads).where(eq(leads.id, id)).get() ?? row);
}

function leadConflicts(value: string | null): LeadConflictValue[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.kind !== "string" || typeof candidate.detail !== "string") return [];
      return [
        {
          kind: candidate.kind,
          signalId: typeof candidate.signalId === "string" ? candidate.signalId : null,
          relatedLeadId:
            typeof candidate.relatedLeadId === "string" ? candidate.relatedLeadId : null,
          detail: candidate.detail,
        },
      ];
    });
  } catch {
    return [{ kind: "legacy_conflict", detail: value }];
  }
}

function stableItemIdentity(item: FeedItem): string {
  if (item.metadata?.provider === "x-api-v2" && item.providerIdentity)
    return `provider:${item.providerIdentity}`;
  if (item.canonicalUrl) return `url:${item.canonicalUrl}`;
  if (item.providerIdentity) return `provider:${item.providerIdentity}`;
  return item.identityKey;
}

function itemFingerprint(item: FeedItem): string {
  return digest(
    JSON.stringify({
      canonicalUrl: item.canonicalUrl,
      providerIdentity: item.providerIdentity,
      title: item.title,
      content: item.content,
      publicationAt: item.publicationAt,
      metadata: item.metadata
        ? {
            provider: item.metadata.provider,
            state: item.metadata.state,
            author: item.metadata.author,
            editHistory: item.metadata.editHistory,
            withheld: item.metadata.withheld,
            protected: item.metadata.protected,
          }
        : undefined,
    }),
  );
}

function strategyMaterialFromSnapshot(snapshot: string | null): string {
  if (!snapshot) return "";
  const value = parseJson(snapshot);
  return value && typeof value === "object" && "material" in value
    ? String((value as { material?: unknown }).material ?? "")
    : "";
}

function toSignalSummary(db: RecruitingDb, row: typeof signals.$inferSelect): SignalSummaryValue {
  const item = db.select().from(sourceItems).where(eq(sourceItems.id, row.sourceItemId)).get();
  const attributions = db
    .select()
    .from(signalAttributions)
    .where(eq(signalAttributions.signalId, row.id))
    .orderBy(asc(signalAttributions.createdAt), asc(signalAttributions.runId))
    .all();
  const attribution = attributions[0];
  const run = db.select().from(scoutRuns).where(eq(scoutRuns.id, row.runId)).get();
  const evidence = parseJson(row.evidence);
  const provenance = parseJson(row.provenance);
  return SignalSummary.parse({
    id: row.id,
    sourceItemId: row.sourceItemId,
    sourceId: row.sourceId ?? item?.sourceId ?? "unknown-source",
    sourceAttemptId: row.sourceAttemptId,
    runId: row.runId,
    scoutId: attribution?.scoutId ?? run?.scoutId ?? "unknown",
    fingerprint: row.fingerprint,
    provenance: provenance && typeof provenance === "object" ? provenance : {},
    publicationAt: row.publicationAt,
    observedAt: row.observedAt,
    retrievedAt: row.retrievedAt,
    evidence,
    retentionUntil: row.retentionUntil,
    supersededSignalId: row.supersededSignalId,
    canonicalUrl: item?.canonicalUrl ?? null,
    providerIdentity: item?.providerIdentity ?? null,
    accessMode: "public",
    adapterVersion: row.adapterVersion,
    processor: row.processor,
    attribution: {
      strategyKey: attribution?.strategyKey ?? null,
      strategyMaterial: strategyMaterialFromSnapshot(run?.strategySnapshot ?? null),
    },
    attributions: attributions.map((item) => {
      const itemRun = db.select().from(scoutRuns).where(eq(scoutRuns.id, item.runId)).get();
      return {
        runId: item.runId,
        scoutId: item.scoutId,
        strategyKey: item.strategyKey,
        strategyMaterial: strategyMaterialFromSnapshot(itemRun?.strategySnapshot ?? null),
        createdAt: item.createdAt,
      };
    }),
    createdAt: row.createdAt,
  });
}

function toLeadSummary(db: RecruitingDb, row: typeof leads.$inferSelect): LeadSummaryValue {
  const links = db
    .select({ signalId: leadSignalLinks.signalId })
    .from(leadSignalLinks)
    .where(eq(leadSignalLinks.leadId, row.id))
    .orderBy(asc(leadSignalLinks.createdAt), asc(leadSignalLinks.signalId))
    .all();
  const signalIds = links.map((link) => link.signalId);
  const signalRows = signalIds.length
    ? db.select().from(signals).where(inArray(signals.id, signalIds)).all()
    : [];
  const sourceIds = [...new Set(signalRows.map((signal) => signal.sourceId))].sort();
  const scoutIds = [
    ...new Set(
      db
        .select({ scoutId: signalAttributions.scoutId })
        .from(signalAttributions)
        .where(inArray(signalAttributions.signalId, signalIds.length ? signalIds : [""]))
        .all()
        .map((attribution) => attribution.scoutId),
    ),
  ].sort();
  const canonicalUrl =
    db
      .select({ value: leadAliases.value })
      .from(leadAliases)
      .where(and(eq(leadAliases.leadId, row.id), eq(leadAliases.kind, "canonical_url")))
      .get()?.value ?? null;
  return LeadSummary.parse({
    id: row.id,
    canonicalKey: row.canonicalKey,
    canonicalUrl,
    title: row.title,
    summary: row.summary,
    identityState: row.identityState === "conflicted" ? "conflicted" : "settled",
    conflict: row.conflict,
    conflicts: leadConflicts(row.conflict),
    mergedInto: row.mergedInto ?? null,
    revision: row.revision,
    signalIds,
    sourceIds,
    scoutIds,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  });
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
      quarantinedCount: row.quarantinedCount,
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

function isFeedProvider(provider: FeedProvider | XProvider | undefined): provider is FeedProvider {
  return Boolean(provider && "fetch" in provider && typeof provider.fetch === "function");
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

function xReadinessPatchForResponse(
  response: Pick<XApiResponse, "status" | "retryAfterMs">,
  at: number,
): SourceAccessPatch {
  if (response.status >= 200 && response.status < 300) {
    return {
      readiness: "ready",
      safeFailure: null,
      nextAction: "Run the X Source again when due",
      retryAt: null,
      sourceIdentity: "x-api-v2",
    };
  }
  if (response.status === 401) {
    return {
      readiness: "reauthentication_required",
      safeFailure: "X App-Only Source Access is not configured or was rejected",
      nextAction: "Configure an official X API v2 App-Only Bearer Token",
      retryAt: null,
      sourceIdentity: "x-api-v2",
    };
  }
  if (response.status === 403) {
    return {
      readiness: "blocked",
      safeFailure: "X blocked this public API read or the App plan lacks access",
      nextAction: "Check the official X App permissions and plan",
      retryAt: null,
      sourceIdentity: "x-api-v2",
    };
  }
  if (response.status === 429) {
    const retryAt = at + Math.max(0, response.retryAfterMs ?? 60_000);
    return {
      readiness: "rate_limited",
      safeFailure: "X asked OpenRecruit to retry after the documented rate limit window",
      nextAction: "Retry after X Retry-After",
      retryAt,
      sourceIdentity: "x-api-v2",
    };
  }
  if (response.status >= 500 || response.status === 408 || response.status === 425) {
    return {
      readiness: "degraded",
      safeFailure: "X is temporarily unavailable",
      nextAction: "Retry the X readiness check later",
      retryAt: at + 60_000,
      sourceIdentity: "x-api-v2",
    };
  }
  return {
    readiness: "blocked",
    safeFailure: "X returned an unavailable response",
    nextAction: "Verify the official X API App and Source configuration",
    retryAt: null,
    sourceIdentity: "x-api-v2",
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

function parseResult<T>(result: string | null): T {
  if (!result) throw new RecruitingError("VALIDATION", "Command receipt has no result");
  return JSON.parse(result) as T;
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
  kind: "scout" | "run" | "source" | "lead",
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
