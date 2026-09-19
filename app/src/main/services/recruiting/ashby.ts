import { createHash, randomUUID } from "node:crypto";
import { listingPublishedAfter } from "@shared/agent";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  ashbyPostingObservations,
  scoutRuns,
  scoutSources,
  scouts,
  sourceAccess,
  sourceAttempts,
  sourceItems,
  sources,
} from "../../db/schema";
import { RecruitingError } from "./errors";
import { PendingEvidenceStore } from "./pending-evidence";
import { JevPostingFitJudge, type PostingFitJudge, type PostingFitJudgment } from "./posting-fit";

export const ASHBY_SOURCE_ID = "source-ashby";
const ACTIVE_RUN_STATUSES = ["queued", "preflight", "running", "finalizing"] as const;
const ASHBY_HOST = "jobs.ashbyhq.com";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOARD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BOARD_CACHE_TTL_MS = 5 * 60 * 1_000;
const EVIDENCE_TTL_MS = 30 * 60 * 1_000;
const MAX_BOARDS = 10;
const MAX_BOARD_POSTINGS = 100;
const DAY_MS = 86_400_000;
/** Below this Choice confidence a Jev experience judgment goes to review
 * instead of deciding. A starting point; tune against recorded judgments. */
const FIT_JUDGMENT_MIN_CONFIDENCE = 0.6;
/** scout_fit: below the floor Jev is confident the posting is not the kind of
 * role the Scout was asked to find; between the two it goes to review. */
const SCOUT_FIT_EXCLUDE_BELOW = 0.3;
const SCOUT_FIT_INCLUDE_FROM = 0.6;

export type AshbyBoardProviderRequest = {
  boardHandle: string;
  etag?: string;
  lastModified?: string;
  signal?: AbortSignal;
};

export type AshbyBoardProviderResponse = {
  status: number;
  body: unknown;
  etag?: string | null;
  lastModified?: string | null;
  retryCount?: number;
  retryAt?: number | null;
};

export interface AshbyBoardProvider {
  fetchBoard(request: AshbyBoardProviderRequest): Promise<AshbyBoardProviderResponse>;
}

export class HttpAshbyBoardProvider implements AshbyBoardProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async fetchBoard(request: AshbyBoardProviderRequest): Promise<AshbyBoardProviderResponse> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(request.boardHandle)}`;
    let response: Response | undefined;
    let retryCount = 0;
    let retryAt: number | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            ...(request.etag ? { "if-none-match": request.etag } : {}),
            ...(request.lastModified ? { "if-modified-since": request.lastModified } : {}),
          },
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        if (attempt === 0) {
          retryCount = 1;
          retryAt = this.now();
          continue;
        }
        return { status: 0, body: null, retryCount, retryAt };
      }
      if (response.ok || !isTransientStatus(response.status) || attempt === 1) break;
      retryCount = 1;
      retryAt = retryTime(response.headers.get("retry-after"), this.now());
      const waitMs = Math.min(5_000, Math.max(0, retryAt - this.now()));
      if (waitMs > 0) await this.delay(waitMs);
    }
    if (!response) return { status: 0, body: null, retryCount, retryAt };
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      retryCount,
      retryAt,
    };
  }
}

export type AshbyInspectCommand = {
  scoutId: string;
  urls?: string[];
  /** Board handles or board URLs whose currently listed, in-window postings
   * are enumerated from the same board response. */
  boards?: string[];
  includeDescription?: boolean;
  policy?: {
    publishedAfter?: string;
    listedOnly?: boolean;
    maximumExplicitRequiredYears?: number;
    /** Roles the Candidate refined with the Scout beyond the saved Discovery
     * Strategy; added to the brief Jev judges each posting against. */
    targetRoles?: string[];
  };
  signal?: AbortSignal;
};

export type AshbyInspectionApplicationOptions = {
  ashbyProvider?: AshbyBoardProvider;
  /** Candidate-supplied TypeSafe key from Settings; enables Jev judgments. */
  typesafeApiKey?: () => string | undefined;
  /** Injected at the external model boundary for deterministic tests. */
  postingFitJudge?: PostingFitJudge;
  /** Shared RecordSignal reference store; RecordSignal resolves from it. */
  pendingEvidence?: PendingEvidenceStore;
};

/** `unavailable` = a judge is configured but returned nothing for this posting. */
type FitJudgmentOutcome = PostingFitJudgment | "unavailable" | undefined;

type ParsedReference = {
  inputIndex: number;
  inputUrl: string;
  boardHandle: string;
  jobId: string;
};

class AshbyReferenceError extends Error {
  constructor(
    readonly errorCode: "invalid_url" | "unsupported_host",
    message: string,
  ) {
    super(message);
  }
}

type ExperienceRequirement = {
  minimumYears: number | null;
  maximumYears: number | null;
  domain: string | null;
  necessity: "required" | "preferred" | "ambiguous";
  evidenceText: string;
  sourceField: "descriptionPlain";
  start: number;
  end: number;
};

type NormalizedPosting = {
  provider: "ashby";
  providerJobId: string;
  boardHandle: string;
  organization: string | null;
  title: string;
  canonicalJobUrl: string;
  applyUrl: string | null;
  location: string | null;
  address: unknown;
  secondaryLocations: unknown[];
  employmentType: string | null;
  workplaceType: string | null;
  isRemote: boolean | null;
  department: string | null;
  team: string | null;
  publishedAt: number | null;
  isListed: boolean;
  observedAt: number;
  firstSeenAt: number;
  descriptionAvailable: boolean;
  descriptionFingerprint: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
};

export type AshbyInspectionResult = {
  sourceAttemptId: string;
  observedAt: number;
  observedAtIso: string;
  provider: "ashby";
  trust: "untrusted_evidence";
  /** The policy the host actually enforced. publishedAfter is the later of the
   * requested value and the pinned Scout Policy cutoff on the host clock. */
  appliedPolicy: {
    publishedAfter: string | null;
    publishedAfterSource: "request" | "scout_policy" | null;
    listedOnly: boolean;
    maximumExplicitRequiredYears: number | null;
    /** True when postings were judged against the Scout's brief. */
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
    posting: NormalizedPosting;
    publishedAtIso: string | null;
    ageDays: number | null;
    experienceStatus: "explicit" | "ambiguous" | "not_stated";
    experienceRequirements: ExperienceRequirement[];
    /** Jev's reading of the posting, when a TypeSafe key is configured. It
     * supersedes the pattern-matched experienceRequirements for the decision. */
    fitJudgment: PostingFitJudgment | null;
    policy: {
      decision: "include" | "exclude" | "review";
      reasons: Array<{ rule: string; outcome: "pass" | "fail" | "review"; code: string }>;
    };
  }>;
  errors: Array<{
    inputIndexes: number[];
    inputUrls: string[];
    code: string;
    message: string;
    retryable: boolean;
    retryAt: number | null;
    boardHandle: string | null;
    providerJobId: string | null;
  }>;
};

export class AshbyInspectionApplication {
  private readonly provider: AshbyBoardProvider | undefined;
  private readonly fitJudge: PostingFitJudge;
  private readonly boardCache = new Map<
    string,
    { cachedAt: number; response: AshbyBoardProviderResponse }
  >();
  private readonly inFlightBoards = new Map<string, Promise<AshbyBoardProviderResponse>>();
  private readonly pendingEvidence: PendingEvidenceStore;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    options: AshbyInspectionApplicationOptions = {},
  ) {
    this.provider = options.ashbyProvider ?? new HttpAshbyBoardProvider();
    this.pendingEvidence = options.pendingEvidence ?? new PendingEvidenceStore();
    this.fitJudge =
      options.postingFitJudge ??
      new JevPostingFitJudge(options.typesafeApiKey ?? (() => undefined));
  }

  async inspect(command: AshbyInspectCommand): Promise<AshbyInspectionResult> {
    const { run, source } = this.requireAccess(command.scoutId);
    validateCommand(command);
    if (!this.provider) {
      throw new RecruitingError("CONFLICT", "Ashby inspection provider is not configured");
    }
    const attemptId = randomUUID();
    const observedAt = this.now();
    const references: ParsedReference[] = [];
    const inputErrors: AshbyInspectionResult["errors"] = [];
    (command.urls ?? []).forEach((inputUrl, inputIndex) => {
      try {
        references.push(parseReference(inputUrl, inputIndex));
      } catch (error) {
        const referenceError = error instanceof AshbyReferenceError ? error : null;
        inputErrors.push({
          inputIndexes: [inputIndex],
          inputUrls: [inputUrl],
          code: referenceError?.errorCode ?? "invalid_url",
          message: referenceError?.message ?? "Ashby job URL is invalid",
          retryable: false,
          retryAt: null,
          boardHandle: null,
          providerJobId: null,
        });
      }
    });
    const grouped = groupReferences(references);
    const boardInputs = new Map<string, string>();
    for (const input of command.boards ?? []) {
      try {
        const handle = parseBoard(input);
        if (!boardInputs.has(handle)) boardInputs.set(handle, input);
      } catch (error) {
        const referenceError = error instanceof AshbyReferenceError ? error : null;
        inputErrors.push({
          inputIndexes: [],
          inputUrls: [input],
          code: referenceError?.errorCode ?? "invalid_url",
          message: referenceError?.message ?? "Ashby board reference is invalid",
          retryable: false,
          retryAt: null,
          boardHandle: null,
          providerJobId: null,
        });
      }
    }
    const boardHandles = [...new Set([...grouped.keys(), ...boardInputs.keys()])].sort();
    const applied = applyPinnedPolicy(command.policy, run.policySnapshot, observedAt);
    const policy = applied.policy;
    const scoutBrief = scoutBriefFor(run.strategySnapshot, policy.targetRoles);
    this.db
      .insert(sourceAttempts)
      .values({
        id: attemptId,
        runId: run.id,
        sourceId: source.id,
        requestedScope: JSON.stringify({
          operation: "ashby_inspect",
          boards: boardHandles,
          enumeratedBoards: [...boardInputs.keys()].sort(),
          jobIds: [...new Set(references.map((reference) => reference.jobId))].sort(),
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

    const results: AshbyInspectionResult["results"] = [];
    const errors: AshbyInspectionResult["errors"] = [...inputErrors];
    let pageCount = 0;
    let attemptRetryAt: number | null = null;
    let boardOutsideWindowCount = 0;
    let boardTruncatedCount = 0;
    for (const boardHandle of boardHandles) {
      const boardReferences = grouped.get(boardHandle) ?? [];
      const cached = this.boardCache.get(boardHandle);
      const cacheHit = cached !== undefined && observedAt - cached.cachedAt < BOARD_CACHE_TTL_MS;
      let initiatedFetch = false;
      let response: AshbyBoardProviderResponse;
      if (cacheHit) {
        response = cached.response;
      } else {
        const inFlight = this.inFlightBoards.get(boardHandle);
        if (inFlight) {
          try {
            response = await inFlight;
          } catch (error) {
            if (command.signal?.aborted) {
              this.cancelAttempt(attemptId, observedAt);
              throw error;
            }
            response = { status: 0, body: null };
          }
        } else {
          initiatedFetch = true;
          const request = this.provider.fetchBoard({
            boardHandle,
            ...(cached?.response.etag ? { etag: cached.response.etag } : {}),
            ...(cached?.response.lastModified
              ? { lastModified: cached.response.lastModified }
              : {}),
            ...(command.signal ? { signal: command.signal } : {}),
          });
          this.inFlightBoards.set(boardHandle, request);
          try {
            try {
              response = await request;
            } catch (error) {
              if (command.signal?.aborted) {
                this.cancelAttempt(attemptId, observedAt);
                throw error;
              }
              response = { status: 0, body: null };
            }
          } finally {
            if (this.inFlightBoards.get(boardHandle) === request) {
              this.inFlightBoards.delete(boardHandle);
            }
          }
        }
      }
      if (!cacheHit) {
        if (initiatedFetch) pageCount += 1;
        if (response.status === 304 && cached) {
          response = cached.response;
          this.boardCache.set(boardHandle, { cachedAt: observedAt, response });
        } else if (response.status === 200) {
          this.boardCache.set(boardHandle, { cachedAt: observedAt, response });
        }
      }
      if (response.status !== 200) {
        const failure = providerFailure(response.status);
        if (response.retryAt !== undefined && response.retryAt !== null) {
          attemptRetryAt = Math.max(attemptRetryAt ?? 0, response.retryAt);
        }
        for (const reference of boardReferences) {
          errors.push(
            errorFor(
              reference,
              failure.code,
              failure.message,
              failure.retryable,
              response.retryAt ?? null,
            ),
          );
        }
        const boardInput = boardInputs.get(boardHandle);
        if (boardInput !== undefined) {
          errors.push({
            inputIndexes: [],
            inputUrls: [boardInput],
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            retryAt: response.retryAt ?? null,
            boardHandle,
            providerJobId: null,
          });
        }
        continue;
      }
      let records: Record<string, unknown>[];
      try {
        records = boardRecords(response.body);
      } catch {
        for (const reference of boardReferences) {
          errors.push(
            errorFor(
              reference,
              "schema_changed",
              "Ashby returned an unsupported response schema",
              false,
            ),
          );
        }
        const boardInput = boardInputs.get(boardHandle);
        if (boardInput !== undefined) {
          errors.push({
            inputIndexes: [],
            inputUrls: [boardInput],
            code: "schema_changed",
            message: "Ashby returned an unsupported response schema",
            retryable: false,
            retryAt: null,
            boardHandle,
            providerJobId: null,
          });
        }
        continue;
      }
      const requestedJobs = groupByJob(boardReferences);
      const selected: Array<{
        jobId: string;
        aliases: ParsedReference[];
        record: Record<string, unknown>;
      }> = [];
      for (const [jobId, aliases] of requestedJobs) {
        const record = records.find(
          (candidate) => stringField(candidate, "id")?.toLowerCase() === jobId,
        );
        if (!record) {
          errors.push(errorForAliases(aliases, "job_not_found", "Ashby job was not found", false));
          continue;
        }
        try {
          validateRequestedRecord(record);
        } catch {
          errors.push(
            errorForAliases(
              aliases,
              "schema_changed",
              "Ashby returned an unsupported posting schema",
              false,
            ),
          );
          continue;
        }
        selected.push({ jobId, aliases, record });
      }
      if (boardInputs.has(boardHandle)) {
        // Enumerate the rest of the board: listed postings inside the window,
        // newest first, bounded so one large board cannot flood the response.
        const threshold =
          policy.publishedAfter === undefined ? null : Date.parse(policy.publishedAfter);
        const enumerated: Array<{ jobId: string; record: Record<string, unknown>; at: number }> =
          [];
        for (const record of records) {
          const jobId = stringField(record, "id")?.toLowerCase();
          if (!jobId || !UUID_PATTERN.test(jobId) || requestedJobs.has(jobId)) continue;
          if (record.isListed !== true) continue;
          try {
            validateRequestedRecord(record);
          } catch {
            continue;
          }
          const published = stringField(record, "publishedAt");
          const at = published ? Date.parse(published) : Number.NaN;
          if (threshold !== null && Number.isFinite(at) && at < threshold) {
            boardOutsideWindowCount += 1;
            continue;
          }
          enumerated.push({ jobId, record, at: Number.isFinite(at) ? at : -1 });
        }
        enumerated.sort(
          (left, right) => right.at - left.at || left.jobId.localeCompare(right.jobId),
        );
        const room = Math.max(
          0,
          MAX_BOARD_POSTINGS - results.filter((result) => result.discoveredVia === "board").length,
        );
        boardTruncatedCount += Math.max(0, enumerated.length - room);
        for (const entry of enumerated.slice(0, room)) {
          selected.push({ jobId: entry.jobId, aliases: [], record: entry.record });
        }
      }
      const judgments = await this.judgeSelected(selected, policy, scoutBrief, command.signal);
      for (const { jobId, aliases, record } of selected) {
        const identity = this.recordFirstSeen(source.id, jobId, boardHandle, record, observedAt);
        const descriptionPlain = stringField(record, "descriptionPlain") ?? "";
        const descriptionHtml = stringField(record, "descriptionHtml") ?? "";
        const posting = normalizePosting({
          record,
          boardHandle,
          jobId,
          observedAt,
          firstSeenAt: identity.firstSeenAt,
          includeDescription: command.includeDescription === true,
          descriptionPlain,
          descriptionHtml,
        });
        this.recordObservation(identity.sourceItemId, posting, observedAt);
        const extracted = extractExperienceRequirements(descriptionPlain);
        const judgment = judgments.get(jobId);
        const fitJudgment = typeof judgment === "object" ? judgment : null;
        const decision = evaluatePolicy(
          posting,
          extracted.status,
          extracted.requirements,
          policy,
          judgment,
          scoutBrief !== null,
        );
        const evidenceReference = this.pendingEvidence.issue({
          issuer: "ashby",
          scoutId: command.scoutId,
          runId: run.id,
          sourceId: source.id,
          sourceAttemptId: attemptId,
          issuedAt: observedAt,
          expiresAt: observedAt + EVIDENCE_TTL_MS,
          excludedByPolicy: decision.decision === "exclude",
          item: {
            identityKey: `ashby:${jobId}`,
            providerIdentity: jobId,
            canonicalUrl: posting.canonicalJobUrl,
            title: posting.title,
            content: descriptionPlain,
            publicationAt: posting.publishedAt,
            metadata: {
              provider: "ashby",
              state: posting.isListed ? "available" : "deleted_or_unavailable",
              descriptionHtml,
              experienceStatus: extracted.status,
              experienceRequirements: extracted.requirements,
              ...(fitJudgment ? { fitJudgment } : {}),
            },
          },
        });
        results.push({
          inputIndexes: aliases
            .map((alias) => alias.inputIndex)
            .sort((left, right) => left - right),
          inputUrls: aliases
            .sort((left, right) => left.inputIndex - right.inputIndex)
            .map((alias) => alias.inputUrl),
          status: "verified",
          evidenceReference,
          discoveredVia: aliases.length > 0 ? "url" : "board",
          posting,
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
    }
    const order = (indexes: number[]) => indexes[0] ?? Number.MAX_SAFE_INTEGER;
    results.sort(
      (left, right) =>
        order(left.inputIndexes) - order(right.inputIndexes) ||
        (right.posting.publishedAt ?? -1) - (left.posting.publishedAt ?? -1),
    );
    errors.sort((left, right) => order(left.inputIndexes) - order(right.inputIndexes));
    this.db
      .update(sourceAttempts)
      .set({
        outcome:
          results.length > 0 && errors.length > 0
            ? "partial"
            : results.length > 0
              ? "succeeded_with_items"
              : errors.length > 0
                ? "rejected"
                : "succeeded_empty",
        itemCount: results.length,
        quarantinedCount: errors.length,
        pageCount,
        retryAt: attemptRetryAt,
        safeFailure:
          errors.length > 0 && results.length === 0
            ? "Ashby inspection returned no verified postings"
            : null,
        completedAt: observedAt,
      })
      .where(eq(sourceAttempts.id, attemptId))
      .run();
    return {
      sourceAttemptId: attemptId,
      observedAt,
      observedAtIso: new Date(observedAt).toISOString(),
      provider: "ashby",
      trust: "untrusted_evidence",
      appliedPolicy: {
        publishedAfter: policy.publishedAfter ?? null,
        publishedAfterSource: applied.publishedAfterSource,
        listedOnly: policy.listedOnly === true,
        maximumExplicitRequiredYears: policy.maximumExplicitRequiredYears ?? null,
        scoutFitJudged: scoutBrief !== null && this.fitJudge.isConfigured(),
      },
      summary: {
        inputCount: (command.urls?.length ?? 0) + (command.boards?.length ?? 0),
        uniquePostingCount: results.length,
        verifiedCount: results.length,
        errorCount: errors.length,
        includeCount: results.filter((result) => result.policy.decision === "include").length,
        excludeCount: results.filter((result) => result.policy.decision === "exclude").length,
        reviewCount: results.filter((result) => result.policy.decision === "review").length,
        boardCount: boardInputs.size,
        boardOutsideWindowCount,
        boardTruncatedCount,
      },
      results,
      errors,
    };
  }

  /** Ask Jev about every posting the cheap code gates have not already
   * excluded. Judgments run concurrently; a failure degrades that posting to
   * the deterministic path rather than failing the inspection. */
  private async judgeSelected(
    selected: Array<{ jobId: string; record: Record<string, unknown> }>,
    policy: NonNullable<AshbyInspectCommand["policy"]>,
    scoutBrief: string | null,
    signal?: AbortSignal,
  ): Promise<Map<string, FitJudgmentOutcome>> {
    const judgments = new Map<string, FitJudgmentOutcome>();
    if (!this.fitJudge.isConfigured()) return judgments;
    const threshold =
      policy.publishedAfter === undefined ? null : Date.parse(policy.publishedAfter);
    await Promise.all(
      selected.map(async ({ jobId, record }) => {
        if (policy.listedOnly && record.isListed !== true) return;
        const published = stringField(record, "publishedAt");
        const at = published ? Date.parse(published) : Number.NaN;
        if (threshold !== null && Number.isFinite(at) && at < threshold) return;
        const title = stringField(record, "title");
        if (!title) return;
        const judgment = await this.fitJudge
          .judge(
            {
              title,
              organization: stringField(record, "organization"),
              department: stringField(record, "department"),
              team: stringField(record, "team"),
              employmentType: stringField(record, "employmentType"),
              location: stringField(record, "location"),
              descriptionPlain: stringField(record, "descriptionPlain") ?? "",
              scoutBrief,
            },
            signal,
          )
          .catch(() => null);
        judgments.set(jobId, judgment ?? "unavailable");
      }),
    );
    return judgments;
  }

  private requireAccess(scoutId: string) {
    const scout = this.db.select().from(scouts).where(eq(scouts.id, scoutId)).get();
    if (!scout) throw new RecruitingError("NOT_FOUND", `Scout ${scoutId} was not found`);
    if (scout.lifecycleState !== "active") {
      throw new RecruitingError("CONFLICT", "Archived Scouts cannot inspect Ashby postings");
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
    const source = this.db.select().from(sources).where(eq(sources.id, ASHBY_SOURCE_ID)).get();
    if (!source) throw new RecruitingError("NOT_FOUND", "Ashby Source was not found");
    const access = this.db
      .select()
      .from(sourceAccess)
      .where(
        and(
          eq(sourceAccess.sourceId, ASHBY_SOURCE_ID),
          eq(sourceAccess.accountRef, ""),
          eq(sourceAccess.scopeKey, "public"),
        ),
      )
      .get();
    if (!access) throw new RecruitingError("NOT_FOUND", "Ashby Source Access was not found");
    if (access.readiness === "candidate_disabled") {
      throw new RecruitingError("CONFLICT", "The Candidate disabled Ashby inspection");
    }
    const frozenSourceIds = snapshotSourceIds(run.overrideSnapshot);
    const selected = frozenSourceIds
      ? frozenSourceIds.includes(ASHBY_SOURCE_ID)
      : Boolean(
          this.db
            .select({ sourceId: scoutSources.sourceId })
            .from(scoutSources)
            .where(
              and(eq(scoutSources.scoutId, scoutId), eq(scoutSources.sourceId, ASHBY_SOURCE_ID)),
            )
            .get(),
        );
    if (!selected) throw new RecruitingError("CONFLICT", "Ashby is not enabled for this Scout");
    return { run, source };
  }

  private cancelAttempt(attemptId: string, completedAt: number): void {
    this.db
      .update(sourceAttempts)
      .set({
        outcome: "cancelled",
        safeFailure: "Ashby inspection was cancelled",
        completedAt,
      })
      .where(eq(sourceAttempts.id, attemptId))
      .run();
  }

  private recordFirstSeen(
    sourceId: string,
    jobId: string,
    boardHandle: string,
    record: Record<string, unknown>,
    observedAt: number,
  ): { firstSeenAt: number; sourceItemId: string } {
    const identityKey = `ashby:${jobId}`;
    const existing = this.db
      .select()
      .from(sourceItems)
      .where(and(eq(sourceItems.sourceId, sourceId), eq(sourceItems.identityKey, identityKey)))
      .get();
    const canonicalUrl = canonicalJobUrl(record, boardHandle, jobId);
    if (existing) {
      this.db
        .update(sourceItems)
        .set({ canonicalUrl, providerIdentity: jobId, updatedAt: observedAt })
        .where(eq(sourceItems.id, existing.id))
        .run();
      return { firstSeenAt: existing.createdAt, sourceItemId: existing.id };
    }
    const id = randomUUID();
    this.db
      .insert(sourceItems)
      .values({
        id,
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
    return { firstSeenAt: observedAt, sourceItemId: id };
  }

  private recordObservation(
    sourceItemId: string,
    posting: NormalizedPosting,
    observedAt: number,
  ): void {
    const observationFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          boardHandle: posting.boardHandle,
          publishedAt: posting.publishedAt,
          isListed: posting.isListed,
          contentFingerprint: posting.descriptionFingerprint,
        }),
      )
      .digest("hex");
    const existing = this.db
      .select()
      .from(ashbyPostingObservations)
      .where(
        and(
          eq(ashbyPostingObservations.sourceItemId, sourceItemId),
          eq(ashbyPostingObservations.observationFingerprint, observationFingerprint),
        ),
      )
      .get();
    if (existing) {
      this.db
        .update(ashbyPostingObservations)
        .set({ lastObservedAt: observedAt })
        .where(eq(ashbyPostingObservations.id, existing.id))
        .run();
      return;
    }
    const prior = this.db
      .select()
      .from(ashbyPostingObservations)
      .where(eq(ashbyPostingObservations.sourceItemId, sourceItemId))
      .orderBy(desc(ashbyPostingObservations.observedAt), desc(ashbyPostingObservations.id))
      .get();
    this.db
      .insert(ashbyPostingObservations)
      .values({
        id: randomUUID(),
        sourceItemId,
        boardHandle: posting.boardHandle,
        publicationAt: posting.publishedAt,
        isListed: posting.isListed,
        contentFingerprint: posting.descriptionFingerprint,
        observationFingerprint,
        relisting: prior?.isListed === false && posting.isListed,
        observedAt,
        lastObservedAt: observedAt,
      })
      .run();
  }
}

function validateCommand(command: AshbyInspectCommand): void {
  const allowed = new Set(["scoutId", "urls", "boards", "includeDescription", "policy", "signal"]);
  const unknown = Object.keys(command).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RecruitingError(
      "VALIDATION",
      `Ashby inspection has unknown fields: ${unknown.join(", ")}`,
    );
  }
  const urls = command.urls ?? [];
  const boards = command.boards ?? [];
  if (!Array.isArray(urls) || urls.length > 50) {
    throw new RecruitingError("VALIDATION", "Ashby inspection requires between one and 50 URLs");
  }
  if (urls.some((url) => typeof url !== "string")) {
    throw new RecruitingError("VALIDATION", "Ashby inspection URLs must be strings");
  }
  if (
    !Array.isArray(boards) ||
    boards.length > MAX_BOARDS ||
    boards.some((board) => typeof board !== "string")
  ) {
    throw new RecruitingError(
      "VALIDATION",
      `Ashby inspection accepts at most ${MAX_BOARDS} board references`,
    );
  }
  if (urls.length + boards.length < 1) {
    throw new RecruitingError("VALIDATION", "Ashby inspection requires between one and 50 URLs");
  }
  if (command.includeDescription !== undefined && typeof command.includeDescription !== "boolean") {
    throw new RecruitingError("VALIDATION", "includeDescription must be boolean");
  }
  if (command.policy !== undefined) {
    if (!isRecord(command.policy)) {
      throw new RecruitingError("VALIDATION", "Ashby inspection policy must be an object");
    }
    const policyAllowed = new Set([
      "publishedAfter",
      "listedOnly",
      "maximumExplicitRequiredYears",
      "targetRoles",
    ]);
    const policyUnknown = Object.keys(command.policy).filter((key) => !policyAllowed.has(key));
    if (policyUnknown.length > 0) {
      throw new RecruitingError(
        "VALIDATION",
        `Ashby inspection policy has unknown fields: ${policyUnknown.join(", ")}`,
      );
    }
    if (command.policy.listedOnly !== undefined && typeof command.policy.listedOnly !== "boolean") {
      throw new RecruitingError("VALIDATION", "listedOnly must be boolean");
    }
    const roles = command.policy.targetRoles;
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
  }
  if (command.policy?.publishedAfter !== undefined) {
    const value = command.policy.publishedAfter;
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new RecruitingError("VALIDATION", "publishedAfter must be an RFC 3339 timestamp");
    }
  }
  const maximum = command.policy?.maximumExplicitRequiredYears;
  if (maximum !== undefined && (!Number.isFinite(maximum) || maximum < 0 || maximum > 100)) {
    throw new RecruitingError(
      "VALIDATION",
      "maximumExplicitRequiredYears must be between 0 and 100",
    );
  }
}

function parseReference(inputUrl: string, inputIndex: number): ParsedReference {
  let url: URL;
  try {
    url = new URL(inputUrl.trim());
  } catch {
    throw new AshbyReferenceError("invalid_url", "Ashby job URL is invalid");
  }
  if (url.hostname !== ASHBY_HOST) {
    throw new AshbyReferenceError("unsupported_host", "Ashby job URL uses an unsupported host");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new AshbyReferenceError(
      "invalid_url",
      "Ashby job URL must use HTTPS without credentials or a custom port",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length !== 2 ||
    !BOARD_PATTERN.test(parts[0] ?? "") ||
    !UUID_PATTERN.test(parts[1] ?? "")
  ) {
    throw new AshbyReferenceError(
      "invalid_url",
      "Ashby job URL must contain a board and UUID job ID",
    );
  }
  return {
    inputIndex,
    inputUrl,
    boardHandle: parts[0] as string,
    jobId: (parts[1] as string).toLowerCase(),
  };
}

/** Accepts a bare board handle or any jobs.ashbyhq.com URL under that board. */
function parseBoard(input: string): string {
  const trimmed = input.trim();
  if (BOARD_PATTERN.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AshbyReferenceError("invalid_url", "Ashby board reference is invalid");
  }
  if (url.hostname !== ASHBY_HOST) {
    throw new AshbyReferenceError("unsupported_host", "Ashby board URL uses an unsupported host");
  }
  const handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new AshbyReferenceError(
      "invalid_url",
      "Ashby board URL must use HTTPS without credentials or a custom port",
    );
  }
  if (!BOARD_PATTERN.test(handle)) {
    throw new AshbyReferenceError("invalid_url", "Ashby board URL must contain a board handle");
  }
  return handle;
}

/** The pinned Scout Policy window is authoritative: the reasoning harness may
 * narrow it, but an omitted or earlier publishedAfter is raised to the cutoff
 * computed on the host clock. */
function applyPinnedPolicy(
  requested: AshbyInspectCommand["policy"],
  policySnapshot: string | null,
  now: number,
): {
  policy: NonNullable<AshbyInspectCommand["policy"]>;
  publishedAfterSource: "request" | "scout_policy" | null;
} {
  const pinned = listingPublishedAfter(policyMaterial(policySnapshot), now);
  const asked =
    requested?.publishedAfter === undefined ? null : Date.parse(requested.publishedAfter);
  if (pinned !== null && (asked === null || asked < pinned)) {
    return {
      policy: { ...requested, publishedAfter: new Date(pinned).toISOString() },
      publishedAfterSource: "scout_policy",
    };
  }
  return { policy: { ...requested }, publishedAfterSource: asked === null ? null : "request" };
}

/** What the Scout was asked to find: its pinned Discovery Strategy plus any
 * roles the Candidate refined with the Scout. Null when there is nothing to
 * judge a posting against. */
function scoutBriefFor(strategySnapshot: string | null, targetRoles?: string[]): string | null {
  const roles = (targetRoles ?? []).map((role) => role.trim()).filter(Boolean);
  const brief = [
    policyMaterial(strategySnapshot).trim(),
    roles.length > 0 ? `Target roles also include: ${roles.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return brief || null;
}

function policyMaterial(policySnapshot: string | null): string {
  if (!policySnapshot) return "";
  try {
    const parsed: unknown = JSON.parse(policySnapshot);
    return isRecord(parsed) && typeof parsed.material === "string" ? parsed.material : "";
  } catch {
    return "";
  }
}

function groupReferences(references: ParsedReference[]): Map<string, ParsedReference[]> {
  const grouped = new Map<string, ParsedReference[]>();
  for (const reference of references) {
    const entries = grouped.get(reference.boardHandle) ?? [];
    entries.push(reference);
    grouped.set(reference.boardHandle, entries);
  }
  return grouped;
}

function groupByJob(references: ParsedReference[]): Map<string, ParsedReference[]> {
  const grouped = new Map<string, ParsedReference[]>();
  for (const reference of references) {
    const entries = grouped.get(reference.jobId) ?? [];
    entries.push(reference);
    grouped.set(reference.jobId, entries);
  }
  return grouped;
}

function boardRecords(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.jobs)) {
    throw new RecruitingError(
      "CONFLICT",
      "Ashby returned an unsupported response schema",
      "malformed_content",
    );
  }
  return body.jobs.filter(isRecord);
}

function normalizePosting(input: {
  record: Record<string, unknown>;
  boardHandle: string;
  jobId: string;
  observedAt: number;
  firstSeenAt: number;
  includeDescription: boolean;
  descriptionPlain: string;
  descriptionHtml: string;
}): NormalizedPosting {
  const published = stringField(input.record, "publishedAt");
  const isListed = input.record.isListed;
  if (typeof isListed !== "boolean") {
    throw new RecruitingError(
      "CONFLICT",
      "Ashby returned an unsupported listed state",
      "malformed_content",
    );
  }
  const title = stringField(input.record, "title");
  if (!title)
    throw new RecruitingError(
      "CONFLICT",
      "Ashby returned a posting without a title",
      "malformed_content",
    );
  const fingerprint = createHash("sha256")
    .update(`${input.descriptionPlain}\u0000${input.descriptionHtml}`)
    .digest("hex");
  return {
    provider: "ashby",
    providerJobId: input.jobId,
    boardHandle: input.boardHandle,
    organization: stringField(input.record, "organization"),
    title,
    canonicalJobUrl: canonicalJobUrl(input.record, input.boardHandle, input.jobId),
    applyUrl: safeHttpUrl(input.record.applyUrl),
    location: stringField(input.record, "location"),
    address: input.record.address ?? null,
    secondaryLocations: Array.isArray(input.record.secondaryLocations)
      ? input.record.secondaryLocations
      : [],
    employmentType: stringField(input.record, "employmentType"),
    workplaceType: stringField(input.record, "workplaceType"),
    isRemote: typeof input.record.isRemote === "boolean" ? input.record.isRemote : null,
    department: stringField(input.record, "department"),
    team: stringField(input.record, "team"),
    publishedAt: published ? parseTimestamp(published) : null,
    isListed,
    observedAt: input.observedAt,
    firstSeenAt: input.firstSeenAt,
    descriptionAvailable: Boolean(input.descriptionPlain || input.descriptionHtml),
    descriptionFingerprint: `sha256:${fingerprint}`,
    ...(input.includeDescription
      ? { descriptionPlain: input.descriptionPlain, descriptionHtml: input.descriptionHtml }
      : {}),
  };
}

function validateRequestedRecord(record: Record<string, unknown>): void {
  if (!stringField(record, "title") || typeof record.isListed !== "boolean") {
    throw new Error("invalid Ashby posting");
  }
  const publishedAt = record.publishedAt;
  if (
    publishedAt !== null &&
    publishedAt !== undefined &&
    (typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt)))
  ) {
    throw new Error("invalid Ashby publication time");
  }
  for (const field of ["descriptionPlain", "descriptionHtml"]) {
    const value = record[field];
    if (value !== null && value !== undefined && typeof value !== "string") {
      throw new Error(`invalid Ashby ${field}`);
    }
  }
}

function extractExperienceRequirements(description: string): {
  status: "explicit" | "ambiguous" | "not_stated";
  requirements: ExperienceRequirement[];
} {
  const requirements: ExperienceRequirement[] = [];
  const pattern =
    /\b(?:(at least|up to)\s+)?(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2})|(\+))?\s+years?\s+(?:of\s+)?([^.;\n]{1,80})/gi;
  for (const match of description.matchAll(pattern)) {
    const evidenceText = match[0].trim();
    const start = match.index ?? 0;
    const end = start + evidenceText.length;
    const qualifier = match[1]?.toLowerCase();
    const first = Number(match[2]);
    const rangeEnd = match[3] === undefined ? null : Number(match[3]);
    const before = description.slice(Math.max(0, start - 100), start).toLowerCase();
    const necessity = /(?:preferred|nice to have|bonus)[^\n.]*$/.test(before)
      ? "preferred"
      : /(?:or equivalent|or a |either)[^\n.]*$|\bor\s*$/.test(before)
        ? "ambiguous"
        : "required";
    requirements.push({
      minimumYears: qualifier === "up to" ? 0 : first,
      maximumYears: rangeEnd ?? (qualifier === "up to" ? first : match[4] ? null : first),
      domain: (match[5] ?? "").replace(/\s+experience$/i, "").trim() || null,
      necessity,
      evidenceText,
      sourceField: "descriptionPlain",
      start,
      end,
    });
  }
  if (requirements.length > 0) return { status: "explicit", requirements };
  return /\b(?:experience|years?)\b/i.test(description)
    ? { status: "ambiguous", requirements }
    : { status: "not_stated", requirements };
}

function evaluatePolicy(
  posting: NormalizedPosting,
  experienceStatus: "explicit" | "ambiguous" | "not_stated",
  requirements: ExperienceRequirement[],
  policy: AshbyInspectCommand["policy"],
  judgment?: FitJudgmentOutcome,
  scoutBriefed = false,
) {
  const reasons: Array<{ rule: string; outcome: "pass" | "fail" | "review"; code: string }> = [];
  if (policy?.publishedAfter !== undefined) {
    const threshold = Date.parse(policy.publishedAfter);
    reasons.push(
      posting.publishedAt === null
        ? { rule: "published_after", outcome: "review", code: "publication_time_not_stated" }
        : posting.publishedAt >= threshold
          ? { rule: "published_after", outcome: "pass", code: "published_in_window" }
          : { rule: "published_after", outcome: "fail", code: "published_before_window" },
    );
  }
  if (policy?.listedOnly) {
    reasons.push(
      posting.isListed
        ? { rule: "listed_only", outcome: "pass", code: "currently_listed" }
        : { rule: "listed_only", outcome: "fail", code: "not_listed" },
    );
  }
  if (policy?.maximumExplicitRequiredYears !== undefined && typeof judgment === "object") {
    // Jev read the whole posting, so its judgment replaces pattern matching,
    // which cannot tell a requirement from a sabbatical perk or a founder bio.
    const { minimumYears, confidence } = judgment.requiredExperience;
    reasons.push(
      confidence < FIT_JUDGMENT_MIN_CONFIDENCE
        ? {
            rule: "maximum_explicit_required_years",
            outcome: "review",
            code: "judged_experience_uncertain",
          }
        : minimumYears === null
          ? {
              // No stated requirement and no seniority cue reads as early career.
              rule: "maximum_explicit_required_years",
              outcome: "pass",
              code: "judged_experience_not_stated",
            }
          : minimumYears > policy.maximumExplicitRequiredYears
            ? {
                rule: "maximum_explicit_required_years",
                outcome: "fail",
                code: "judged_minimum_exceeds_limit",
              }
            : {
                rule: "maximum_explicit_required_years",
                outcome: "pass",
                code: "judged_minimum_within_limit",
              },
    );
  } else if (policy?.maximumExplicitRequiredYears !== undefined) {
    const required = requirements.filter((requirement) => requirement.necessity === "required");
    const ambiguous = requirements.some((requirement) => requirement.necessity === "ambiguous");
    const exceeds = required.some(
      (requirement) =>
        requirement.minimumYears !== null &&
        requirement.minimumYears > (policy.maximumExplicitRequiredYears as number),
    );
    reasons.push(
      exceeds
        ? judgment === "unavailable"
          ? {
              // Pattern matching alone must not drop a posting Jev was meant to read.
              rule: "maximum_explicit_required_years",
              outcome: "review",
              code: "experience_judgment_unavailable",
            }
          : {
              rule: "maximum_explicit_required_years",
              outcome: "fail",
              code: "explicit_minimum_exceeds_limit",
            }
        : ambiguous || experienceStatus !== "explicit" || required.length === 0
          ? {
              rule: "maximum_explicit_required_years",
              outcome: "review",
              code:
                experienceStatus === "not_stated"
                  ? "experience_not_stated"
                  : "experience_ambiguous",
            }
          : {
              rule: "maximum_explicit_required_years",
              outcome: "pass",
              code: "explicit_minimum_within_limit",
            },
    );
  }
  // General fit: whatever field the Scout was set up for, Jev judged the
  // posting against that Scout's own brief. No brief or no judge, no rule.
  if (judgment === "unavailable" && scoutBriefed) {
    reasons.push({ rule: "scout_fit", outcome: "review", code: "fit_judgment_unavailable" });
  } else if (typeof judgment === "object" && judgment.scoutFitProbability !== null) {
    const probability = judgment.scoutFitProbability;
    reasons.push(
      probability < SCOUT_FIT_EXCLUDE_BELOW
        ? { rule: "scout_fit", outcome: "fail", code: "judged_outside_scout_brief" }
        : probability < SCOUT_FIT_INCLUDE_FROM
          ? { rule: "scout_fit", outcome: "review", code: "judged_fit_uncertain" }
          : { rule: "scout_fit", outcome: "pass", code: "judged_within_scout_brief" },
    );
  }
  return {
    decision: reasons.some((reason) => reason.outcome === "fail")
      ? ("exclude" as const)
      : reasons.some((reason) => reason.outcome === "review")
        ? ("review" as const)
        : ("include" as const),
    reasons,
  };
}

function canonicalJobUrl(
  record: Record<string, unknown>,
  boardHandle: string,
  jobId: string,
): string {
  const candidate = safeHttpUrl(record.jobUrl);
  if (candidate) {
    try {
      const parsed = parseReference(candidate, 0);
      if (parsed.jobId === jobId) return `https://${ASHBY_HOST}/${parsed.boardHandle}/${jobId}`;
    } catch {
      // Construct the verified canonical URL below.
    }
  }
  return `https://${ASHBY_HOST}/${boardHandle}/${jobId}`;
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RecruitingError(
      "CONFLICT",
      "Ashby returned an invalid publication time",
      "malformed_content",
    );
  }
  return parsed;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function errorFor(
  reference: ParsedReference,
  code: string,
  message: string,
  retryable: boolean,
  retryAt: number | null = null,
): AshbyInspectionResult["errors"][number] {
  return errorForAliases([reference], code, message, retryable, retryAt);
}

function errorForAliases(
  aliases: ParsedReference[],
  code: string,
  message: string,
  retryable: boolean,
  retryAt: number | null = null,
): AshbyInspectionResult["errors"][number] {
  const sorted = [...aliases].sort((left, right) => left.inputIndex - right.inputIndex);
  return {
    inputIndexes: sorted.map((alias) => alias.inputIndex),
    inputUrls: sorted.map((alias) => alias.inputUrl),
    code,
    message,
    retryable,
    retryAt,
    boardHandle: sorted[0]?.boardHandle ?? null,
    providerJobId: sorted[0]?.jobId ?? null,
  };
}

function providerFailure(status: number): {
  code: "board_not_found" | "rate_limited" | "network_failure" | "schema_changed";
  message: string;
  retryable: boolean;
} {
  if (status === 404) {
    return { code: "board_not_found", message: "Ashby board was not found", retryable: false };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "Ashby is temporarily rate limited", retryable: true };
  }
  if (status === 0 || status === 408 || status >= 500) {
    return {
      code: "network_failure",
      message: "Ashby is temporarily unavailable",
      retryable: true,
    };
  }
  return { code: "schema_changed", message: "Ashby rejected the board request", retryable: false };
}
