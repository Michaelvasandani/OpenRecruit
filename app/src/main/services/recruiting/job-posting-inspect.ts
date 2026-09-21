import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  scoutRuns,
  scoutSources,
  scouts,
  sourceAccess,
  sourceAttempts,
  sourceItems,
  sources,
} from "../../db/schema";
import {
  applyPinnedPolicy,
  type ExperienceRequirement,
  evaluatePolicy,
  extractExperienceRequirements,
  snapshotSourceIds,
} from "./ashby";
import {
  ATS_ADAPTERS,
  ATS_PROVIDERS,
  type AtsAdapter,
  type AtsJobReference,
  type AtsPosting,
  type AtsProvider,
  type AtsRequest,
  routeBoard,
  routeJobUrl,
} from "./ats-boards";
import { RecruitingError } from "./errors";
import { PendingEvidenceStore } from "./pending-evidence";
import type { PostingFitJudge, PostingFitJudgment } from "./posting-fit";
import {
  type PostingJudgmentOutcome,
  PostingScreener,
  type ScreeningContext,
  type ScreeningReason,
  screeningContextForRun,
} from "./posting-screen";

const ACTIVE_RUN_STATUSES = ["queued", "preflight", "running", "finalizing"] as const;
const RESPONSE_CACHE_TTL_MS = 5 * 60 * 1_000;
const EVIDENCE_TTL_MS = 30 * 60 * 1_000;
const MAX_URLS = 50;
const MAX_BOARDS = 10;
const MAX_BOARD_POSTINGS = 100;
/** Listings without descriptions cost one request per posting; bound it. */
const MAX_BOARD_DETAIL_FETCHES = 25;
const FETCH_CONCURRENCY = 5;
const DAY_MS = 86_400_000;

export type AtsHttpResponse = { status: number; body: unknown; retryAt?: number | null };

/** The external boundary: one unauthenticated JSON GET against a public board API. */
export interface AtsHttp {
  getJson(request: AtsRequest & { signal?: AbortSignal }): Promise<AtsHttpResponse>;
}

export class FetchAtsHttp implements AtsHttp {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async getJson(request: AtsRequest & { signal?: AbortSignal }): Promise<AtsHttpResponse> {
    let response: Response | undefined;
    let retryAt: number | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.fetchImpl(request.url, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        if (attempt === 0) {
          retryAt = this.now();
          continue;
        }
        return { status: 0, body: null, retryAt };
      }
      if (response.ok || !isTransientStatus(response.status) || attempt === 1) break;
      retryAt = retryTime(response.headers.get("retry-after"), this.now());
      const waitMs = Math.min(5_000, Math.max(0, retryAt - this.now()));
      if (waitMs > 0) await this.delay(waitMs);
    }
    if (!response) return { status: 0, body: null, retryAt };
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, retryAt };
  }
}

export type JobPostingInspectCommand = {
  scoutId: string;
  /** Posting URLs on any supported board, in any mix. */
  urls?: string[];
  /** Board URLs whose currently listed, in-window postings are enumerated. */
  boards?: string[];
  includeDescription?: boolean;
  policy?: {
    publishedAfter?: string;
    listedOnly?: boolean;
    maximumExplicitRequiredYears?: number;
    targetRoles?: string[];
  };
  signal?: AbortSignal;
};

export type JobPostingInspectionOptions = {
  atsHttp?: AtsHttp;
  typesafeApiKey?: () => string | undefined;
  postingFitJudge?: PostingFitJudge;
  postingScreener?: PostingScreener;
  pendingEvidence?: PendingEvidenceStore;
};

type InspectedPosting = Omit<AtsPosting, "descriptionPlain" | "descriptionHtml" | "needsDetail"> & {
  provider: AtsProvider;
  boardHandle: string;
  providerJobId: string;
  canonicalJobUrl: string;
  observedAt: number;
  firstSeenAt: number;
  descriptionAvailable: boolean;
  descriptionFingerprint: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
};

type InspectionError = {
  inputIndexes: number[];
  inputUrls: string[];
  provider: AtsProvider | null;
  code: string;
  message: string;
  retryable: boolean;
  retryAt: number | null;
  boardHandle: string | null;
  providerJobId: string | null;
};

export type JobPostingInspectionResult = {
  observedAt: number;
  observedAtIso: string;
  trust: "untrusted_evidence";
  /** One Source Attempt per board provider the inspection touched. */
  sourceAttempts: Array<{ provider: AtsProvider; sourceAttemptId: string }>;
  appliedPolicy: {
    publishedAfter: string | null;
    publishedAfterSource: "request" | "scout_policy" | null;
    listedOnly: boolean;
    maximumExplicitRequiredYears: number | null;
    scoutFitJudged: boolean;
  };
  summary: {
    inputCount: number;
    uniquePostingCount: number;
    verifiedCount: number;
    errorCount: number;
    includeCount: number;
    excludeCount: number;
    reviewCount: number;
    boardCount: number;
    boardOutsideWindowCount: number;
    boardTruncatedCount: number;
  };
  results: Array<{
    inputIndexes: number[];
    inputUrls: string[];
    status: "verified";
    evidenceReference: string;
    discoveredVia: "url" | "board";
    posting: InspectedPosting;
    publishedAtIso: string | null;
    ageDays: number | null;
    experienceStatus: "explicit" | "ambiguous" | "not_stated";
    experienceRequirements: ExperienceRequirement[];
    fitJudgment: PostingFitJudgment | null;
    policy: { decision: "include" | "exclude" | "review"; reasons: ScreeningReason[] };
  }>;
  errors: InspectionError[];
};

type RoutedUrl = { inputIndex: number; inputUrl: string; reference: AtsJobReference };
type Selected = {
  key: string;
  board: string;
  aliases: RoutedUrl[];
  posting: AtsPosting;
};
type Policy = NonNullable<JobPostingInspectCommand["policy"]>;

/**
 * Inspects public job postings on every supported applicant-tracking board.
 * The reasoning harness discovers URLs with its own web search; this module
 * verifies them against each board's public API and applies the pinned Scout
 * Policy, Jev screening, and evidence issuance once for all boards.
 */
export class JobPostingInspectionApplication {
  private readonly http: AtsHttp;
  private readonly screener: PostingScreener;
  private readonly pendingEvidence: PendingEvidenceStore;
  private readonly responseCache = new Map<
    string,
    { cachedAt: number; response: AtsHttpResponse }
  >();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    options: JobPostingInspectionOptions = {},
  ) {
    this.http = options.atsHttp ?? new FetchAtsHttp();
    this.pendingEvidence = options.pendingEvidence ?? new PendingEvidenceStore();
    this.screener =
      options.postingScreener ??
      new PostingScreener({
        typesafeApiKey: options.typesafeApiKey,
        postingFitJudge: options.postingFitJudge,
      });
  }

  async inspect(command: JobPostingInspectCommand): Promise<JobPostingInspectionResult> {
    validateCommand(command);
    const { run, enabled } = this.requireAccess(command.scoutId);
    const observedAt = this.now();
    const applied = applyPinnedPolicy(command.policy, run.policySnapshot, observedAt);
    const policy = applied.policy;
    const context = screeningContextForRun(run, policy.targetRoles);
    const errors: InspectionError[] = [];
    const urlsByProvider = new Map<AtsProvider, RoutedUrl[]>();
    const boardsByProvider = new Map<AtsProvider, Map<string, string>>();

    const notEnabled = (adapter: AtsAdapter, inputIndexes: number[], input: string) =>
      errors.push({
        inputIndexes,
        inputUrls: [input],
        provider: adapter.provider,
        code: "source_not_enabled",
        message: `${adapter.label} is not enabled for this Scout`,
        retryable: false,
        retryAt: null,
        boardHandle: null,
        providerJobId: null,
      });
    (command.urls ?? []).forEach((inputUrl, inputIndex) => {
      const routed = routeJobUrl(inputUrl);
      if (!routed.ok) {
        errors.push(inputError([inputIndex], inputUrl, routed.code, routed.message));
      } else if (!enabled.has(routed.adapter.provider)) {
        notEnabled(routed.adapter, [inputIndex], inputUrl);
      } else {
        const entries = urlsByProvider.get(routed.adapter.provider) ?? [];
        entries.push({ inputIndex, inputUrl, reference: routed.reference });
        urlsByProvider.set(routed.adapter.provider, entries);
      }
    });
    for (const input of command.boards ?? []) {
      const routed = routeBoard(input);
      if (!routed.ok) {
        errors.push(inputError([], input, routed.code, routed.message));
      } else if (!enabled.has(routed.adapter.provider)) {
        notEnabled(routed.adapter, [], input);
      } else {
        const boards = boardsByProvider.get(routed.adapter.provider) ?? new Map<string, string>();
        if (!boards.has(routed.board)) boards.set(routed.board, input);
        boardsByProvider.set(routed.adapter.provider, boards);
      }
    }

    const results: JobPostingInspectionResult["results"] = [];
    const attempts: JobPostingInspectionResult["sourceAttempts"] = [];
    const counters = { boardOutsideWindow: 0, boardTruncated: 0 };
    for (const provider of ATS_PROVIDERS) {
      const routedUrls = urlsByProvider.get(provider) ?? [];
      const boards = boardsByProvider.get(provider) ?? new Map<string, string>();
      if (routedUrls.length === 0 && boards.size === 0) continue;
      const source = enabled.get(provider);
      if (!source) continue;
      const attemptId = await this.inspectProvider({
        adapter: ATS_ADAPTERS[provider],
        sourceId: source,
        command,
        run,
        routedUrls,
        boards,
        policy,
        context,
        observedAt,
        results,
        errors,
        counters,
      });
      attempts.push({ provider, sourceAttemptId: attemptId });
    }

    const order = (indexes: number[]) => indexes[0] ?? Number.MAX_SAFE_INTEGER;
    results.sort(
      (left, right) =>
        order(left.inputIndexes) - order(right.inputIndexes) ||
        (right.posting.publishedAt ?? -1) - (left.posting.publishedAt ?? -1),
    );
    errors.sort((left, right) => order(left.inputIndexes) - order(right.inputIndexes));
    return {
      observedAt,
      observedAtIso: new Date(observedAt).toISOString(),
      trust: "untrusted_evidence",
      sourceAttempts: attempts,
      appliedPolicy: {
        publishedAfter: policy.publishedAfter ?? null,
        publishedAfterSource: applied.publishedAfterSource,
        listedOnly: policy.listedOnly === true,
        maximumExplicitRequiredYears: policy.maximumExplicitRequiredYears ?? null,
        scoutFitJudged: context.scoutBrief !== null && this.screener.isConfigured(),
      },
      summary: {
        inputCount: (command.urls?.length ?? 0) + (command.boards?.length ?? 0),
        uniquePostingCount: results.length,
        verifiedCount: results.length,
        errorCount: errors.length,
        includeCount: results.filter((result) => result.policy.decision === "include").length,
        excludeCount: results.filter((result) => result.policy.decision === "exclude").length,
        reviewCount: results.filter((result) => result.policy.decision === "review").length,
        boardCount: [...boardsByProvider.values()].reduce((sum, boards) => sum + boards.size, 0),
        boardOutsideWindowCount: counters.boardOutsideWindow,
        boardTruncatedCount: counters.boardTruncated,
      },
      results,
      errors,
    };
  }

  private async inspectProvider(input: {
    adapter: AtsAdapter;
    sourceId: string;
    command: JobPostingInspectCommand;
    run: typeof scoutRuns.$inferSelect;
    routedUrls: RoutedUrl[];
    boards: Map<string, string>;
    policy: Policy;
    context: ScreeningContext;
    observedAt: number;
    results: JobPostingInspectionResult["results"];
    errors: InspectionError[];
    counters: { boardOutsideWindow: number; boardTruncated: number };
  }): Promise<string> {
    const { adapter, command, run, policy, observedAt } = input;
    const attemptId = randomUUID();
    const grouped = new Map<string, RoutedUrl[]>();
    for (const routed of input.routedUrls) {
      const key = postingKey(adapter, routed.reference.board, routed.reference.jobId);
      grouped.set(key, [...(grouped.get(key) ?? []), routed]);
    }
    this.db
      .insert(sourceAttempts)
      .values({
        id: attemptId,
        runId: run.id,
        sourceId: input.sourceId,
        requestedScope: JSON.stringify({
          operation: "job_posting_inspect",
          provider: adapter.provider,
          enumeratedBoards: [...input.boards.keys()].sort(),
          postings: [...grouped.keys()].sort(),
          policy,
        }),
        cursor: null,
        outcome: "started",
        itemCount: 0,
        quarantinedCount: 0,
        pageCount: 0,
        retryAt: null,
        safeFailure: null,
        startedAt: observedAt,
        completedAt: null,
      })
      .run();

    const errorsBefore = input.errors.length;
    const resultsBefore = input.results.length;
    let pageCount = 0;
    let attemptRetryAt: number | null = null;
    const get = async (request: AtsRequest): Promise<AtsHttpResponse> => {
      const cached = this.responseCache.get(request.url);
      if (cached && observedAt - cached.cachedAt < RESPONSE_CACHE_TTL_MS) return cached.response;
      pageCount += 1;
      let response: AtsHttpResponse;
      try {
        response = await this.http.getJson({
          ...request,
          ...(command.signal ? { signal: command.signal } : {}),
        });
      } catch (error) {
        if (command.signal?.aborted) throw error;
        response = { status: 0, body: null };
      }
      if (response.status === 200) {
        this.responseCache.set(request.url, { cachedAt: observedAt, response });
      }
      if (response.retryAt !== undefined && response.retryAt !== null && response.status !== 200) {
        attemptRetryAt = Math.max(attemptRetryAt ?? 0, response.retryAt);
      }
      return response;
    };
    const fetchJob = async (
      reference: AtsJobReference,
    ): Promise<{ posting: AtsPosting } | { failure: ReturnType<typeof jobFailure> }> => {
      const response = await get(adapter.jobRequest(reference));
      if (response.status !== 200) return { failure: jobFailure(adapter, response) };
      try {
        return { posting: adapter.parseJob(response.body, reference) };
      } catch {
        return { failure: schemaChanged(adapter) };
      }
    };

    const selected: Selected[] = [];
    try {
      await pooled([...grouped.entries()], async ([key, aliases]) => {
        const reference = aliases[0].reference;
        const fetched = await fetchJob(reference);
        if ("failure" in fetched) {
          input.errors.push(errorForAliases(adapter, aliases, fetched.failure));
          return;
        }
        selected.push({ key, board: reference.board, aliases, posting: fetched.posting });
      });

      const threshold =
        policy.publishedAfter === undefined ? null : Date.parse(policy.publishedAfter);
      for (const [board, boardInput] of input.boards) {
        const request = adapter.boardRequest(board);
        if (!request) continue;
        const response = await get(request);
        let listing: AtsPosting[];
        if (response.status !== 200) {
          input.errors.push(
            boardError(adapter, board, boardInput, boardFailure(adapter, response)),
          );
          continue;
        }
        try {
          listing = adapter.parseBoardListing(response.body, board);
        } catch {
          input.errors.push(boardError(adapter, board, boardInput, schemaChanged(adapter)));
          continue;
        }
        // Listed postings inside the window, newest first, bounded so one large
        // board cannot flood the response.
        const enumerated = listing.filter((posting) => {
          if (grouped.has(postingKey(adapter, board, posting.jobId)) || !posting.isListed)
            return false;
          if (threshold !== null && posting.publishedAt !== null) {
            if (windowTime(posting) < threshold) {
              input.counters.boardOutsideWindow += 1;
              return false;
            }
          }
          return true;
        });
        enumerated.sort(
          (left, right) =>
            (right.publishedAt ?? -1) - (left.publishedAt ?? -1) ||
            left.jobId.localeCompare(right.jobId),
        );
        const viaBoard = selected.filter((entry) => entry.aliases.length === 0).length;
        const room = Math.max(0, MAX_BOARD_POSTINGS - viaBoard);
        const detailRoom = enumerated.some((posting) => posting.needsDetail)
          ? Math.min(room, MAX_BOARD_DETAIL_FETCHES)
          : room;
        input.counters.boardTruncated += Math.max(0, enumerated.length - detailRoom);
        await pooled(enumerated.slice(0, detailRoom), async (listed) => {
          let posting = listed;
          if (listed.needsDetail) {
            const fetched = await fetchJob({ board, jobId: listed.jobId });
            if ("failure" in fetched) return;
            posting = fetched.posting;
          }
          selected.push({
            key: postingKey(adapter, board, posting.jobId),
            board,
            aliases: [],
            posting,
          });
        });
      }
    } catch (error) {
      if (command.signal?.aborted) this.cancelAttempt(attemptId, observedAt);
      throw error;
    }

    const judgments = await this.judgeSelected(selected, policy, input.context, command.signal);
    for (const { key, board, aliases, posting } of selected) {
      const canonicalJobUrl = posting.canonicalUrl ?? aliases[0]?.inputUrl ?? "";
      const firstSeenAt = this.recordFirstSeen(
        input.sourceId,
        key,
        posting.jobId,
        canonicalJobUrl,
        observedAt,
      );
      const extracted = extractExperienceRequirements(posting.descriptionPlain);
      const judgment = judgments.get(key);
      const fitJudgment = typeof judgment === "object" ? judgment : null;
      const decision = evaluatePolicy(
        {
          publishedAt: posting.publishedAt === null ? null : windowTime(posting),
          isListed: posting.isListed,
        },
        extracted.status,
        extracted.requirements,
        policy,
        judgment,
        input.context,
      );
      const organization = posting.organization ?? titleCaseHandle(board);
      const evidenceReference = this.pendingEvidence.issue({
        issuer: "ats",
        scoutId: command.scoutId,
        runId: run.id,
        sourceId: input.sourceId,
        sourceAttemptId: attemptId,
        issuedAt: observedAt,
        expiresAt: observedAt + EVIDENCE_TTL_MS,
        excludedByPolicy: decision.decision === "exclude",
        item: {
          identityKey: key,
          providerIdentity: posting.jobId,
          canonicalUrl: canonicalJobUrl,
          title: posting.title,
          content: posting.descriptionPlain,
          publicationAt: posting.publishedAt,
          metadata: {
            provider: adapter.provider,
            organization,
            state: posting.isListed ? "available" : "deleted_or_unavailable",
            descriptionHtml: posting.descriptionHtml,
            experienceStatus: extracted.status,
            experienceRequirements: extracted.requirements,
            ...(fitJudgment ? { fitJudgment } : {}),
          },
        },
      });
      const { descriptionPlain, descriptionHtml, needsDetail: _needsDetail, ...facts } = posting;
      const fingerprint = createHash("sha256")
        .update(`${descriptionPlain} ${descriptionHtml}`)
        .digest("hex");
      const sortedAliases = [...aliases].sort((left, right) => left.inputIndex - right.inputIndex);
      input.results.push({
        inputIndexes: sortedAliases.map((alias) => alias.inputIndex),
        inputUrls: sortedAliases.map((alias) => alias.inputUrl),
        status: "verified",
        evidenceReference,
        discoveredVia: aliases.length > 0 ? "url" : "board",
        posting: {
          ...facts,
          organization,
          provider: adapter.provider,
          boardHandle: board,
          providerJobId: posting.jobId,
          canonicalJobUrl,
          observedAt,
          firstSeenAt,
          descriptionAvailable: Boolean(descriptionPlain || descriptionHtml),
          descriptionFingerprint: `sha256:${fingerprint}`,
          ...(command.includeDescription === true ? { descriptionPlain, descriptionHtml } : {}),
        },
        publishedAtIso:
          posting.publishedAt === null ? null : new Date(posting.publishedAt).toISOString(),
        ageDays:
          posting.publishedAt === null
            ? null
            : Math.max(0, Math.floor((observedAt - posting.publishedAt) / DAY_MS)),
        experienceStatus: extracted.status,
        experienceRequirements: extracted.requirements,
        fitJudgment,
        policy: decision,
      });
    }

    const resultCount = input.results.length - resultsBefore;
    const errorCount = input.errors.length - errorsBefore;
    this.db
      .update(sourceAttempts)
      .set({
        outcome:
          resultCount > 0 && errorCount > 0
            ? "partial"
            : resultCount > 0
              ? "succeeded_with_items"
              : errorCount > 0
                ? "rejected"
                : "succeeded_empty",
        itemCount: resultCount,
        quarantinedCount: errorCount,
        pageCount,
        retryAt: attemptRetryAt,
        safeFailure:
          errorCount > 0 && resultCount === 0
            ? `${adapter.label} inspection returned no verified postings`
            : null,
        completedAt: observedAt,
      })
      .where(eq(sourceAttempts.id, attemptId))
      .run();
    return attemptId;
  }

  /** Ask Jev about every posting the cheap code gates have not already excluded. */
  private judgeSelected(
    selected: Selected[],
    policy: Policy,
    context: ScreeningContext,
    signal?: AbortSignal,
  ): Promise<Map<string, PostingJudgmentOutcome>> {
    const threshold =
      policy.publishedAfter === undefined ? null : Date.parse(policy.publishedAfter);
    const postings = selected.flatMap(({ key, board, posting }) => {
      if (policy.listedOnly && !posting.isListed) return [];
      if (threshold !== null && posting.publishedAt !== null && windowTime(posting) < threshold)
        return [];
      return [
        {
          key,
          title: posting.title,
          organization: posting.organization ?? titleCaseHandle(board),
          department: posting.department,
          team: posting.team,
          employmentType: posting.employmentType,
          location: posting.location,
          descriptionPlain: posting.descriptionPlain,
        },
      ];
    });
    return this.screener.judgeAll(postings, context, signal);
  }

  /** The active Run plus the board Sources this Scout may inspect. */
  private requireAccess(scoutId: string) {
    const scout = this.db.select().from(scouts).where(eq(scouts.id, scoutId)).get();
    if (!scout) throw new RecruitingError("NOT_FOUND", `Scout ${scoutId} was not found`);
    if (scout.lifecycleState !== "active") {
      throw new RecruitingError("CONFLICT", "Archived Scouts cannot inspect job postings");
    }
    const run = this.db
      .select()
      .from(scoutRuns)
      .where(
        and(eq(scoutRuns.scoutId, scoutId), inArray(scoutRuns.status, [...ACTIVE_RUN_STATUSES])),
      )
      .orderBy(asc(scoutRuns.createdAt), asc(scoutRuns.id))
      .get();
    if (!run) throw new RecruitingError("CONFLICT", `Scout ${scoutId} has no active Scout Run`);
    const frozenSourceIds = snapshotSourceIds(run.overrideSnapshot);
    const selectedIds =
      frozenSourceIds ??
      this.db
        .select({ sourceId: scoutSources.sourceId })
        .from(scoutSources)
        .where(eq(scoutSources.scoutId, scoutId))
        .all()
        .map((row) => row.sourceId);
    const enabled = new Map<AtsProvider, string>();
    for (const provider of ATS_PROVIDERS) {
      const sourceId = ATS_ADAPTERS[provider].sourceId;
      if (!selectedIds.includes(sourceId)) continue;
      const source = this.db.select().from(sources).where(eq(sources.id, sourceId)).get();
      const access = this.db
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
      if (source && access && access.readiness !== "candidate_disabled") {
        enabled.set(provider, sourceId);
      }
    }
    if (enabled.size === 0) {
      throw new RecruitingError("CONFLICT", "No job board Source is enabled for this Scout");
    }
    return { run, enabled };
  }

  private cancelAttempt(attemptId: string, completedAt: number): void {
    this.db
      .update(sourceAttempts)
      .set({
        outcome: "cancelled",
        safeFailure: "Job posting inspection was cancelled",
        completedAt,
      })
      .where(eq(sourceAttempts.id, attemptId))
      .run();
  }

  private recordFirstSeen(
    sourceId: string,
    identityKey: string,
    jobId: string,
    canonicalUrl: string,
    observedAt: number,
  ): number {
    const existing = this.db
      .select()
      .from(sourceItems)
      .where(and(eq(sourceItems.sourceId, sourceId), eq(sourceItems.identityKey, identityKey)))
      .get();
    if (existing) {
      this.db
        .update(sourceItems)
        .set({ canonicalUrl, providerIdentity: jobId, updatedAt: observedAt })
        .where(eq(sourceItems.id, existing.id))
        .run();
      return existing.createdAt;
    }
    this.db
      .insert(sourceItems)
      .values({
        id: randomUUID(),
        sourceId,
        identityKey,
        canonicalUrl,
        providerIdentity: jobId,
        latestFingerprint: null,
        latestSignalId: null,
        deletionMarkerAt: null,
        createdAt: observedAt,
        updatedAt: observedAt,
      })
      .run();
    return observedAt;
  }
}

function validateCommand(command: JobPostingInspectCommand): void {
  const allowed = new Set(["scoutId", "urls", "boards", "includeDescription", "policy", "signal"]);
  const unknown = Object.keys(command).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RecruitingError(
      "VALIDATION",
      `Job posting inspection has unknown fields: ${unknown.join(", ")}`,
    );
  }
  const urls = command.urls ?? [];
  const boards = command.boards ?? [];
  if (
    !Array.isArray(urls) ||
    urls.length > MAX_URLS ||
    urls.some((url) => typeof url !== "string")
  ) {
    throw new RecruitingError(
      "VALIDATION",
      `Job posting inspection accepts at most ${MAX_URLS} URL strings`,
    );
  }
  if (
    !Array.isArray(boards) ||
    boards.length > MAX_BOARDS ||
    boards.some((board) => typeof board !== "string")
  ) {
    throw new RecruitingError(
      "VALIDATION",
      `Job posting inspection accepts at most ${MAX_BOARDS} board URLs`,
    );
  }
  if (urls.length + boards.length < 1) {
    throw new RecruitingError("VALIDATION", "Job posting inspection requires a URL or a board");
  }
  if (command.includeDescription !== undefined && typeof command.includeDescription !== "boolean") {
    throw new RecruitingError("VALIDATION", "includeDescription must be boolean");
  }
  const policy = command.policy;
  if (policy === undefined) return;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new RecruitingError("VALIDATION", "Job posting inspection policy must be an object");
  }
  const policyAllowed = new Set([
    "publishedAfter",
    "listedOnly",
    "maximumExplicitRequiredYears",
    "targetRoles",
  ]);
  const policyUnknown = Object.keys(policy).filter((key) => !policyAllowed.has(key));
  if (policyUnknown.length > 0) {
    throw new RecruitingError(
      "VALIDATION",
      `Job posting inspection policy has unknown fields: ${policyUnknown.join(", ")}`,
    );
  }
  if (policy.listedOnly !== undefined && typeof policy.listedOnly !== "boolean") {
    throw new RecruitingError("VALIDATION", "listedOnly must be boolean");
  }
  const roles = policy.targetRoles;
  if (
    roles !== undefined &&
    (!Array.isArray(roles) ||
      roles.length > 12 ||
      roles.some((role) => typeof role !== "string" || !role.trim() || role.length > 80))
  ) {
    throw new RecruitingError(
      "VALIDATION",
      "targetRoles must be up to 12 role names of at most 80 characters",
    );
  }
  if (policy.publishedAfter !== undefined) {
    const value = policy.publishedAfter;
    if (
      typeof value !== "string" ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw new RecruitingError("VALIDATION", "publishedAfter must be an RFC 3339 timestamp");
    }
  }
  const maximum = policy.maximumExplicitRequiredYears;
  if (maximum !== undefined && (!Number.isFinite(maximum) || maximum < 0 || maximum > 100)) {
    throw new RecruitingError(
      "VALIDATION",
      "maximumExplicitRequiredYears must be between 0 and 100",
    );
  }
}

/** A board that only states a date publishes "sometime that day": compare the
 * end of the day so a posting on the cutoff day stays inside the window. */
function windowTime(posting: { publishedAt: number | null; publishedAtPrecision: string }): number {
  const at = posting.publishedAt ?? 0;
  return posting.publishedAtPrecision === "day" ? at + DAY_MS - 1 : at;
}

function postingKey(adapter: AtsAdapter, board: string, jobId: string): string {
  return `${adapter.provider}:${board.toLowerCase()}:${jobId.toLowerCase()}`;
}

function titleCaseHandle(board: string): string {
  const handle = board.includes("/") ? (board.split(".")[0] ?? board) : board;
  return handle
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function pooled<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await work(item);
      }
    }),
  );
}

type Failure = { code: string; message: string; retryable: boolean; retryAt: number | null };

function jobFailure(adapter: AtsAdapter, response: AtsHttpResponse): Failure {
  // Workday answers a withdrawn posting with 403, the others with 404 or 410.
  if ([403, 404, 410].includes(response.status)) {
    return {
      code: "job_not_found",
      message: `${adapter.label} job was not found; it may have been removed`,
      retryable: false,
      retryAt: null,
    };
  }
  return transportFailure(adapter, response);
}

function boardFailure(adapter: AtsAdapter, response: AtsHttpResponse): Failure {
  if (response.status === 404) {
    return {
      code: "board_not_found",
      message: `${adapter.label} board was not found`,
      retryable: false,
      retryAt: null,
    };
  }
  return transportFailure(adapter, response);
}

function transportFailure(adapter: AtsAdapter, response: AtsHttpResponse): Failure {
  const retryAt = response.retryAt ?? null;
  if (response.status === 429) {
    return {
      code: "rate_limited",
      message: `${adapter.label} is temporarily rate limited`,
      retryable: true,
      retryAt,
    };
  }
  if (response.status === 0 || response.status === 408 || response.status >= 500) {
    return {
      code: "network_failure",
      message: `${adapter.label} is temporarily unavailable`,
      retryable: true,
      retryAt,
    };
  }
  return schemaChanged(adapter);
}

function schemaChanged(adapter: AtsAdapter): Failure {
  return {
    code: "schema_changed",
    message: `${adapter.label} returned an unsupported response`,
    retryable: false,
    retryAt: null,
  };
}

function inputError(
  inputIndexes: number[],
  input: string,
  code: string,
  message: string,
): InspectionError {
  return {
    inputIndexes,
    inputUrls: [input],
    provider: null,
    code,
    message,
    retryable: false,
    retryAt: null,
    boardHandle: null,
    providerJobId: null,
  };
}

function errorForAliases(
  adapter: AtsAdapter,
  aliases: RoutedUrl[],
  failure: Failure,
): InspectionError {
  const sorted = [...aliases].sort((left, right) => left.inputIndex - right.inputIndex);
  return {
    inputIndexes: sorted.map((alias) => alias.inputIndex),
    inputUrls: sorted.map((alias) => alias.inputUrl),
    provider: adapter.provider,
    ...failure,
    boardHandle: sorted[0]?.reference.board ?? null,
    providerJobId: sorted[0]?.reference.jobId ?? null,
  };
}

function boardError(
  adapter: AtsAdapter,
  board: string,
  input: string,
  failure: Failure,
): InspectionError {
  return {
    inputIndexes: [],
    inputUrls: [input],
    provider: adapter.provider,
    ...failure,
    boardHandle: board,
    providerJobId: null,
  };
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryTime(value: string | null, now: number): number {
  if (!value) return now;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(now, parsed) : now;
}
