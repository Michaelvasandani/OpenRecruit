import { createHash, randomUUID } from "node:crypto";
import {
  type FitEvaluationSummary,
  type OpportunitySummary,
  type RecruitingInvalidation,
  type ReviewLeadPanelProjection,
  ReviewLeadPanelProjection as ReviewLeadPanelProjectionSchema,
  type ReviewScoutRunCenterProjection,
  ReviewScoutRunCenterProjection as ReviewScoutRunCenterProjectionSchema,
  type ReviewSidebarProjection,
  ReviewSidebarProjection as ReviewSidebarProjectionSchema,
  ScoutHarness,
  type ScoutRunActivity,
  ScoutRunActivity as ScoutRunActivitySchema,
  type ScoutRunCheckpointSummary,
  type ScoutRunSummary,
  type ScoutSummary,
  type SignalSummary,
  type SourceAttemptSummary,
  type SourceReadinessAggregate,
  type SourceSummary,
} from "@shared/recruiting";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  commandReceipts,
  domainClock,
  profiles,
  scoutSources,
  scouts,
  sources,
} from "../../db/schema";
import { bus } from "../event-bus";
import type { WakeTransport } from "../scheduler/wake/types";
import {
  CandidateDecisionApplication,
  type RecordCandidateDecisionCommand,
  type RequestCandidateReconsiderationCommand,
} from "./candidate-decisions";
import { assertSafeMaterial } from "./contract";
import { RecruitingError } from "./errors";
import {
  type DeleteEvidenceCommand,
  EvidenceApplication,
  type InspectEvidenceCommand,
} from "./evidence";
import {
  type CreateFitEvaluationCommand,
  FitEvaluationApplication,
  type PromoteLeadCommand,
} from "./fit";
import {
  type CompleteInvestigationAttemptCommand,
  type CreateInvestigationCommand,
  InvestigationApplication,
  type RecordInvestigationAttemptCommand,
  type StartInvestigationAttemptCommand,
} from "./investigations";
import type { ConfirmProfileCommand, ImportProfileCommand, UpdateDraftCommand } from "./profile";
import { CandidateProfileApplication } from "./profile";
import {
  type CreateRevisitPlanCommand,
  type RequestCandidateRunCommand,
  type RequestExplicitReconsiderationCommand,
  type RequestScheduledRefreshCommand,
  type RequestScoutRunCommand,
  type RequestSourceEventCommand,
  RevisitPlanApplication,
  type UpdateRevisitPlanCommand,
} from "./revisit";
import {
  type AdvanceScoutRunCommand,
  type CheckpointScoutRunCommand,
  type CheckSourceReadinessCommand,
  type CreateFeedSourceCommand,
  type CreateRssSourceCommand,
  type CreateSourceCommand,
  type CreateXSourceCommand,
  type LaunchScoutRunCommand,
  type LinkSignalToLeadCommand,
  type MergeLeadsCommand,
  type ReadSourceCommand,
  ScoutRunApplication,
  type ScoutRunApplicationOptions,
  type SetScoutSourcesCommand,
  type SetSourceDisabledCommand,
  WEB_SEARCH_SOURCE_ID,
  type WebSearchSettingsProjection,
} from "./scout-runs";
import {
  WebFetchApplication,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResponse,
} from "./web-fetch";
import {
  WebSearchApplication,
  type WebSearchApplicationOptions,
  type WebSearchRequest,
  type WebSearchResponse,
} from "./web-search";

export type {
  EvidenceDeletionSummary,
  EvidenceInspectionSummary,
  EvidenceItemSummary,
  EvidenceRetentionState,
  EvidenceScope,
} from "@shared/recruiting";
export {
  InvestigationAttemptDecision,
  InvestigationAttemptOutcome,
  InvestigationAttemptSummary,
  InvestigationEvidence,
  InvestigationRerunReason,
  InvestigationStatus,
  InvestigationSummary,
  LeadConflict,
  LeadContext,
  LeadSummary,
  SignalEvidence,
  SignalSummary,
  SourceAccessSummary,
  SourceAttemptOutcome,
  SourceAttemptSummary,
  SourceReadiness,
} from "@shared/recruiting";
export {
  CANDIDATE_DECISION_KINDS,
  CandidateDecisionApplication,
  type CandidateDecisionDetail,
  type CandidateDecisionKind,
  type CandidateDecisionSummary,
  type RecordCandidateDecisionCommand,
  type RequestCandidateReconsiderationCommand,
} from "./candidate-decisions";
export {
  assertSafeMaterial,
  PROHIBITED_RECRUITING_CAPABILITIES,
  RECRUITING_OPERATIONS,
  recruitingOperationsFor,
  recruitingProviderInstructions,
  validateRecruitingOperation,
} from "./contract";
export { RecruitingError } from "./errors";
export {
  type DeleteEvidenceCommand,
  EvidenceApplication,
  type InspectEvidenceCommand,
} from "./evidence";
export {
  type CreateFitEvaluationCommand,
  type FitConclusionInput,
  FitEvaluationApplication,
  type FitEvidenceInput,
  type PromoteLeadCommand,
} from "./fit";
export {
  type CompleteInvestigationAttemptCommand,
  type CreateInvestigationCommand,
  InvestigationApplication,
  normalizeQuestionKey,
  type RecordInvestigationAttemptCommand,
  type StartInvestigationAttemptCommand,
} from "./investigations";
export type {
  ConfirmProfileCommand,
  GitHubFactInput,
  GitHubImportInput,
  ImportProfileCommand,
  ProfileArtifactStore,
  ProfileFactInput,
  UpdateDraftCommand,
} from "./profile";
export { CandidateProfileApplication } from "./profile";
export {
  type CreateRevisitPlanCommand,
  type RequestCandidateRunCommand,
  type RequestExplicitReconsiderationCommand,
  type RequestScheduledRefreshCommand,
  type RequestScoutRunCommand,
  type RequestSourceEventCommand,
  RevisitPlanApplication,
  type RevisitTarget,
  type UpdateRevisitPlanCommand,
} from "./revisit";
export type {
  AdvanceScoutRunCommand,
  CheckpointScoutRunCommand,
  CheckSourceReadinessCommand,
  CreateFeedSourceCommand,
  CreateRssSourceCommand,
  CreateSourceCommand,
  CreateXSourceCommand,
  LaunchScoutRunCommand,
  LinkSignalToLeadCommand,
  MergeLeadsCommand,
  ReadSourceCommand,
  ScoutRunApplicationOptions,
  SetScoutSourcesCommand,
  SetSourceDisabledCommand,
  SourceAttemptResult,
  WebSearchSettingsProjection,
} from "./scout-runs";
export {
  DEFAULT_RUN_BUDGET,
  ScoutRunApplication,
  WEB_SEARCH_SOURCE_ID,
  WEB_SEARCH_SOURCE_KIND,
} from "./scout-runs";
export {
  DeterministicFeedProvider,
  type FeedItem,
  type FeedItemMetadata,
  type FeedProvider,
  type FeedRequest,
  type FeedResponse,
  HttpFeedProvider,
  parseFeed,
  validateFeedUrl,
} from "./source";
export {
  DeterministicWebFetchProvider,
  FirecrawlWebFetchProvider,
  normalizeFetchRequest,
  WebFetchApplication,
  type WebFetchApplicationOptions,
  type WebFetchFailure,
  type WebFetchOutcome,
  type WebFetchPageError,
  type WebFetchProvenance,
  type WebFetchProvider,
  WebFetchProviderError,
  type WebFetchProviderErrorCategory,
  type WebFetchProviderPage,
  type WebFetchProviderRequest,
  type WebFetchRequest,
  type WebFetchResponse,
  type WebFetchSuccess,
} from "./web-fetch";
export {
  DeterministicWebSearchProvider,
  FirecrawlWebSearchProvider,
  normalizeQuery,
  WebSearchApplication,
  type WebSearchApplicationOptions,
  type WebSearchProvider,
  WebSearchProviderError,
  type WebSearchProviderRequest,
  type WebSearchProviderResponse,
  type WebSearchProviderResult,
  type WebSearchRequest,
  type WebSearchResponse,
} from "./web-search";
export {
  DeterministicXProvider,
  HttpXProvider,
  normalizeXResponse,
  XApiProvider,
  type XApiRequest,
  type XApiResponse,
  type XProvider,
  type XSourceConfig,
  xConfigFromSource,
} from "./x";

export type CreateScoutCommand = {
  name: string;
  harness: ScoutHarness;
  instructionPath: string;
  strategyPath?: string | null;
  strategyMaterial?: string;
  policyMaterial?: string;
  sourceIds?: string[];
  defaultProfileId?: string | null;
  resumableSessionRef?: string | null;
  idempotencyKey: string;
};

export type RecruitingApplicationOptions = ScoutRunApplicationOptions &
  WebSearchApplicationOptions & {
    webSearchApiKey?: () => string | undefined;
    webFetchProvider?: WebFetchProvider;
  };

export type ArchiveScoutCommand = {
  scoutId: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type UpdateScoutCommand = {
  scoutId: string;
  expectedRevision: number;
  name?: string;
  instructionPath?: string;
  strategyPath?: string | null;
  strategyMaterial?: string;
  policyMaterial?: string;
  defaultProfileId?: string | null;
  sourceIds?: string[];
  idempotencyKey: string;
};

export type CommandResult<T> = {
  value: T;
  revision: number;
  replayed: boolean;
};

type ReceiptLookup = {
  result: string | null;
  payloadHash: string;
};

type RecruitingDb = Pick<Db, "select" | "insert" | "update" | "delete">;

/**
 * The single deep Recruiting write/read boundary. Adapters (tRPC, the future
 * agent API, and the renderer) consume this service rather than touching tables.
 * Each mutation is a short SQLite transaction; post-commit invalidations are
 * published only after the transaction has completed successfully.
 */
export class RecruitingApplication {
  private readonly profileApplication: CandidateProfileApplication;
  private readonly scoutRuns: ScoutRunApplication;
  private readonly fitEvaluations: FitEvaluationApplication;
  private readonly investigations: InvestigationApplication;
  private readonly revisitPlans: RevisitPlanApplication;
  private readonly candidateDecisions: CandidateDecisionApplication;
  private readonly evidence: EvidenceApplication;
  private readonly webSearchSettings?: () => WebSearchSettingsProjection;
  private readonly webSearchApplication: WebSearchApplication;
  private readonly webFetchApplication: WebFetchApplication;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    options: RecruitingApplicationOptions = {},
  ) {
    this.webSearchSettings = options.webSearchSettings;
    this.profileApplication = new CandidateProfileApplication(db, { now });
    this.scoutRuns = new ScoutRunApplication(db, now, options);
    this.webSearchApplication = new WebSearchApplication(db, now, {
      provider: options.provider,
      apiKey: options.webSearchApiKey ?? options.apiKey,
    });
    this.webFetchApplication = new WebFetchApplication(db, now, {
      provider: options.webFetchProvider,
      apiKey: options.webSearchApiKey ?? options.apiKey,
    });
    this.candidateDecisions = new CandidateDecisionApplication(db, now);
    this.evidence = new EvidenceApplication(db, now);
    this.fitEvaluations = new FitEvaluationApplication(db, now, (subjectId, at) =>
      this.candidateDecisions.requireCurrentSupportingEvidence(subjectId, at),
    );
    this.investigations = new InvestigationApplication(db, now);
    this.revisitPlans = new RevisitPlanApplication(
      db,
      (command) => this.scoutRuns.launchScoutRun(command),
      (runId) => this.scoutRuns.getScoutRun(runId),
      now,
      (target) =>
        (target.leadId
          ? this.candidateDecisions.getDecisionState(target.leadId)
          : target.opportunityId
            ? this.candidateDecisions.getDecisionState(target.opportunityId)
            : { resurfacingSuppressed: false }
        ).resurfacingSuppressed,
    );
  }

  setWake(wake: WakeTransport): void {
    this.revisitPlans.setWake(wake);
  }

  listProfiles() {
    return this.profileApplication.listProfiles();
  }

  getProfile(id: string) {
    return this.profileApplication.getProfile(id);
  }

  listProfileVersions(profileId: string) {
    return this.profileApplication.listVersions(profileId);
  }

  getProfileVersion(id: string) {
    return this.profileApplication.getVersion(id);
  }

  importProfile(command: ImportProfileCommand) {
    return this.profileApplication.importProfile(command);
  }

  updateProfileDraft(command: UpdateDraftCommand) {
    return this.profileApplication.updateDraft(command);
  }

  deleteProfileContent(command: Omit<UpdateDraftCommand, "addFacts" | "replaceFacts">) {
    return this.profileApplication.deleteProfileContent(command);
  }

  confirmProfile(command: ConfirmProfileCommand) {
    return this.profileApplication.confirmProfile(command);
  }

  createSource(command: CreateSourceCommand) {
    return this.scoutRuns.createSource(command);
  }

  createRssSource(command: CreateRssSourceCommand) {
    return this.scoutRuns.createRssSource(command);
  }

  createAtomSource(command: CreateRssSourceCommand) {
    return this.scoutRuns.createAtomSource(command);
  }

  createFeedSource(command: CreateFeedSourceCommand) {
    return this.scoutRuns.createFeedSource(command);
  }

  createXSource(command: CreateXSourceCommand) {
    return this.scoutRuns.createXSource(command);
  }

  listSources() {
    return this.scoutRuns.listSources();
  }

  getSource(id: string) {
    return this.scoutRuns.getSource(id);
  }

  getSourceAccess(sourceId: string, accountRef?: string, scopeKey?: string) {
    return this.scoutRuns.getSourceAccess(sourceId, accountRef, scopeKey);
  }

  setSourceDisabled(command: SetSourceDisabledCommand) {
    return this.scoutRuns.setSourceDisabled(command);
  }

  disableSource(sourceId: string) {
    return this.scoutRuns.disableSource(sourceId);
  }

  enableSource(sourceId: string) {
    return this.scoutRuns.enableSource(sourceId);
  }

  checkSourceReadiness(command: CheckSourceReadinessCommand) {
    return this.scoutRuns.checkSourceReadiness(command);
  }

  readSource(command: ReadSourceCommand) {
    return this.scoutRuns.readSource(command);
  }

  webSearch(command: WebSearchRequest & { scoutId: string }): Promise<WebSearchResponse> {
    return this.webSearchApplication.search(command);
  }

  webFetch(command: WebFetchRequest & { scoutId: string }): Promise<WebFetchResponse> {
    return this.webFetchApplication.fetch(command);
  }

  /** Map the authenticated local agent identity to its canonical Scout. New
   * Scouts may use their own id in tests and future harness adapters; migrated
   * Scouts use the legacy agent id that rides the existing MCP environment. */
  resolveScoutForAgent(agentId: string): string | null {
    const row = this.db.select({ id: scouts.id }).from(scouts).where(eq(scouts.id, agentId)).get();
    if (row) return row.id;
    const legacy = this.db
      .select({ id: scouts.id })
      .from(scouts)
      .where(eq(scouts.legacyAgentId, agentId))
      .get();
    return legacy?.id ?? null;
  }

  listSourceAttempts(runId?: string) {
    return this.scoutRuns.listSourceAttempts(runId);
  }

  getSourceAttempt(id: string) {
    return this.scoutRuns.getSourceAttempt(id);
  }

  listSignals(filter: { runId?: string; sourceId?: string } = {}) {
    return this.scoutRuns.listSignals(filter);
  }

  getSignal(id: string) {
    return this.scoutRuns.getSignal(id);
  }

  inspectEvidence(command: InspectEvidenceCommand = {}) {
    return this.evidence.inspectEvidence(command);
  }

  listEvidence(command: InspectEvidenceCommand = {}) {
    return this.evidence.listEvidence(command);
  }

  deleteEvidence(command: DeleteEvidenceCommand) {
    return this.evidence.deleteEvidence(command);
  }

  removeEvidence(command: DeleteEvidenceCommand) {
    return this.evidence.removeEvidence(command);
  }

  listLeads() {
    return this.scoutRuns.listLeads();
  }

  getLead(id: string) {
    return this.scoutRuns.getLead(id);
  }

  linkSignalToLead(command: LinkSignalToLeadCommand) {
    return this.scoutRuns.linkSignalToLead(command);
  }

  mergeLeads(command: MergeLeadsCommand) {
    return this.scoutRuns.mergeLeads(command);
  }

  getLeadContext(id: string) {
    const context = this.scoutRuns.getLeadContext(id);
    if (!context) return null;
    const opportunities = this.fitEvaluations.listOpportunities(id);
    return {
      ...context,
      opportunities,
      investigations: this.investigations.investigationsForLead(id),
      fitEvaluations: [
        ...this.fitEvaluations.listFitEvaluations(id),
        ...opportunities.flatMap((opportunity) =>
          this.fitEvaluations.listFitEvaluations(opportunity.id),
        ),
      ],
      candidateDecisions: this.candidateDecisions.listForLead(id),
      decisionState: this.candidateDecisions.getDecisionState(id),
    };
  }

  getLeadPanel(id: string) {
    return this.getLeadContext(id);
  }

  recordCandidateDecision(command: RecordCandidateDecisionCommand) {
    return this.candidateDecisions.recordCandidateDecision(command);
  }

  recordDecision(command: RecordCandidateDecisionCommand) {
    return this.recordCandidateDecision(command);
  }

  requestCandidateReconsideration(command: RequestCandidateReconsiderationCommand) {
    return this.candidateDecisions.requestCandidateReconsideration(command);
  }

  listCandidateDecisions(subjectId: string) {
    return this.candidateDecisions.listCandidateDecisions(subjectId);
  }

  listDecisions(subjectId: string) {
    return this.candidateDecisions.listDecisions(subjectId);
  }

  getCandidateDecision(id: string) {
    return this.candidateDecisions.getCandidateDecision(id);
  }

  createInvestigation(command: CreateInvestigationCommand) {
    return this.investigations.createInvestigation(command);
  }

  ensureInvestigation(command: CreateInvestigationCommand) {
    return this.investigations.ensureInvestigation(command);
  }

  getOrCreateInvestigation(command: CreateInvestigationCommand) {
    return this.investigations.getOrCreateInvestigation(command);
  }

  listInvestigations(subjectId?: string) {
    return this.investigations.listInvestigations(subjectId);
  }

  getInvestigation(id: string) {
    return this.investigations.getInvestigation(id);
  }

  listInvestigationAttempts(investigationId: string) {
    return this.investigations.listInvestigationAttempts(investigationId);
  }

  getInvestigationAttempt(id: string) {
    return this.investigations.getInvestigationAttempt(id);
  }

  startInvestigationAttempt(command: StartInvestigationAttemptCommand) {
    return this.investigations.startInvestigationAttempt(command);
  }

  requestInvestigationAttempt(command: StartInvestigationAttemptCommand) {
    return this.investigations.startInvestigationAttempt(command);
  }

  recordInvestigationAttempt(command: RecordInvestigationAttemptCommand) {
    return this.investigations.recordInvestigationAttempt(command);
  }

  completeInvestigationAttempt(command: CompleteInvestigationAttemptCommand) {
    return this.investigations.completeInvestigationAttempt(command);
  }

  createFitEvaluation(command: CreateFitEvaluationCommand): FitEvaluationSummary {
    return this.fitEvaluations.createFitEvaluation(command);
  }

  evaluateFit(command: CreateFitEvaluationCommand): FitEvaluationSummary {
    return this.fitEvaluations.evaluateFit(command);
  }

  createEvaluation(command: CreateFitEvaluationCommand): FitEvaluationSummary {
    return this.createFitEvaluation(command);
  }

  listFitEvaluations(subjectId?: string): FitEvaluationSummary[] {
    return this.fitEvaluations.listFitEvaluations(subjectId);
  }

  getFitEvaluation(id: string): FitEvaluationSummary | null {
    return this.fitEvaluations.getFitEvaluation(id);
  }

  listOpportunities(leadId?: string): OpportunitySummary[] {
    return this.fitEvaluations.listOpportunities(leadId);
  }

  getOpportunity(id: string): OpportunitySummary | null {
    return this.fitEvaluations.getOpportunity(id);
  }

  promoteLead(command: PromoteLeadCommand) {
    return this.fitEvaluations.promoteLead(command);
  }

  promote(command: PromoteLeadCommand) {
    return this.promoteLead(command);
  }

  setScoutSources(command: SetScoutSourcesCommand) {
    return this.scoutRuns.setScoutSources(command);
  }

  launchScoutRun(command: LaunchScoutRunCommand) {
    return this.scoutRuns.launchScoutRun(command);
  }

  /** Alias used by UI/agent adapters: a manual launch always performs preflight. */
  runScout(command: LaunchScoutRunCommand) {
    return this.launchScoutRun(command);
  }

  createScoutRun(command: LaunchScoutRunCommand) {
    return this.launchScoutRun(command);
  }

  launchRun(command: LaunchScoutRunCommand) {
    return this.launchScoutRun(command);
  }

  listScoutRuns(scoutId?: string) {
    return this.scoutRuns.listScoutRuns(scoutId);
  }

  getScoutRun(id: string) {
    return this.scoutRuns.getScoutRun(id);
  }

  advanceScoutRun(command: AdvanceScoutRunCommand) {
    return this.scoutRuns.advanceScoutRun(command);
  }

  checkpointScoutRun(command: CheckpointScoutRunCommand) {
    return this.scoutRuns.checkpointScoutRun(command);
  }

  listScoutRunCheckpoints(runId: string) {
    return this.scoutRuns.listScoutRunCheckpoints(runId);
  }

  createRevisitPlan(command: CreateRevisitPlanCommand) {
    return this.revisitPlans.createRevisitPlan(command);
  }

  updateRevisitPlan(command: UpdateRevisitPlanCommand) {
    return this.revisitPlans.updateRevisitPlan(command);
  }

  listRevisitPlans(scoutId?: string) {
    return this.revisitPlans.listRevisitPlans(scoutId);
  }

  getRevisitPlan(id: string) {
    return this.revisitPlans.getRevisitPlan(id);
  }

  requestScoutRun(command: RequestScoutRunCommand) {
    return this.revisitPlans.requestScoutRun(command);
  }

  requestScheduledRefresh(command: RequestScheduledRefreshCommand) {
    return this.revisitPlans.requestScheduledRefresh(command);
  }

  requestSourceEvent(command: RequestSourceEventCommand) {
    return this.revisitPlans.requestSourceEvent(command);
  }

  requestCandidateRun(command: RequestCandidateRunCommand) {
    return this.revisitPlans.requestCandidateRun(command);
  }

  requestExplicitReconsideration(command: RequestExplicitReconsiderationCommand) {
    return this.revisitPlans.requestExplicitReconsideration(command);
  }

  listRunRequests(scoutId?: string) {
    return this.revisitPlans.listRunRequests(scoutId);
  }

  getRunRequest(id: string) {
    return this.revisitPlans.getRunRequest(id);
  }

  processRunRequests() {
    return this.revisitPlans.processRunRequests();
  }

  processDueRevisits() {
    return this.revisitPlans.processDueRevisits();
  }

  getScoutRunCenter(scoutId: string) {
    return this.revisitPlans.getScoutRunCenter(scoutId);
  }

  listScoutRunCenters() {
    return this.revisitPlans.listScoutRunCenters();
  }

  /**
   * Candidate-facing Variant B sidebar projection. The projection deliberately
   * joins Scout, Run, Lead, Revisit Plan, and Source read models here so the
   * renderer never has to synthesize operational authority from several
   * independently fetched tables.
   */
  reviewSidebar(): ReviewSidebarProjection {
    const generatedAt = this.now();
    const sources = this.listSources();
    const scouts = this.listScouts().map((scout) => {
      const center = this.getScoutRunCenter(scout.id);
      const sourceRows = sources.filter((source) => scout.sourceIds.includes(source.id));
      return {
        scout,
        activeRun: center.activeRunId === null ? null : this.getScoutRun(center.activeRunId),
        latestRun: center.lastRun,
        lastRunAt: center.lastRun?.completedAt ?? center.lastRun?.createdAt ?? null,
        nextRunAt: center.nextRunAt,
        freshLeadCount: this.freshLeadsForScout(scout.id, generatedAt).length,
        dueRevisitCount: center.dueRevisitCount,
        sourceReadiness: sourceReadinessAggregate(sourceRows),
      };
    });
    return ReviewSidebarProjectionSchema.parse({
      revision: this.revision(),
      generatedAt,
      scouts,
      sourceReadiness: sourceReadinessAggregate(sources),
    });
  }

  getReviewSidebar(): ReviewSidebarProjection {
    return this.reviewSidebar();
  }

  /**
   * One authoritative Run Center snapshot. Activity is reconstructed from
   * normalized committed records, which gives the renderer a useful timeline
   * after a reconnect without ever exposing provider output or transcripts.
   */
  reviewScoutRunCenter(scoutId: string): ReviewScoutRunCenterProjection | null {
    const scout = this.getScout(scoutId);
    if (!scout) return null;
    const generatedAt = this.now();
    const center = this.getScoutRunCenter(scoutId);
    const recentRuns = this.listScoutRuns(scoutId).slice(0, 20);
    const sourceAttempts = recentRuns.flatMap((run) => this.listSourceAttempts(run.id));
    const signals = recentRuns.flatMap((run) => this.listSignals({ runId: run.id }));
    const signalIds = new Set(signals.map((signal) => signal.id));
    const freshLeads = this.freshLeadsForScout(scoutId, generatedAt).filter((lead) =>
      lead.signalIds.some((signalId) => signalIds.has(signalId)),
    );
    const checkpoints = recentRuns.flatMap((run) => this.listScoutRunCheckpoints(run.id));
    const activeRun = center.activeRunId ? this.getScoutRun(center.activeRunId) : null;
    const latestRun = center.lastRun;
    const activity = buildRunActivity({
      recentRuns,
      sourceAttempts,
      signals,
      checkpoints,
      leads: freshLeads,
    });
    return ReviewScoutRunCenterProjectionSchema.parse({
      revision: this.revision(),
      generatedAt,
      scoutId,
      scout,
      activeRun,
      latestRun,
      lastRunAt: latestRun?.completedAt ?? latestRun?.createdAt ?? null,
      nextRunAt: center.nextRunAt,
      dueRevisitCount: center.dueRevisitCount,
      pendingRequestCount: center.pendingRequestCount,
      activity,
      signals,
      sourceAttempts,
      freshLeads,
      checkpoints,
      recentRuns,
      sources: this.listSources().filter((source) => scout.sourceIds.includes(source.id)),
    });
  }

  getReviewScoutRunCenter(scoutId: string): ReviewScoutRunCenterProjection | null {
    return this.reviewScoutRunCenter(scoutId);
  }

  /**
   * The Lead context projection keeps the canonical Lead as the parent while
   * joining related Opportunity, Investigation, Fit, Decision, Revisit, and
   * Source read models. All labels remain derived in the renderer.
   */
  reviewLeadPanel(id: string): ReviewLeadPanelProjection | null {
    const generatedAt = this.now();
    const context = this.getLeadContext(id);
    if (!context) return null;
    const opportunityIds = new Set(context.opportunities.map((opportunity) => opportunity.id));
    const investigationIds = new Set(
      context.investigations.map((investigation) => investigation.id),
    );
    const revisitPlans = this.listRevisitPlans().filter(
      (plan) =>
        plan.leadId === id ||
        (plan.opportunityId !== null && opportunityIds.has(plan.opportunityId)) ||
        (plan.investigationId !== null && investigationIds.has(plan.investigationId)),
    );
    const sourceReadiness = this.listSources().filter((source) =>
      context.lead.sourceIds.includes(source.id),
    );
    const signalCounts = new Map<string, number>();
    for (const signal of context.signals) {
      for (const attribution of signal.attributions) {
        signalCounts.set(attribution.scoutId, (signalCounts.get(attribution.scoutId) ?? 0) + 1);
      }
    }
    const attributions = context.lead.scoutIds.map((scoutId) => ({
      scoutId,
      scoutName: this.getScout(scoutId)?.name ?? scoutId,
      signalCount: signalCounts.get(scoutId) ?? 0,
    }));
    return ReviewLeadPanelProjectionSchema.parse({
      revision: this.revision(),
      generatedAt,
      lead: context.lead,
      attributions,
      signals: context.signals,
      opportunities: context.opportunities,
      fitEvaluations: context.fitEvaluations,
      investigations: context.investigations,
      candidateDecisions: context.candidateDecisions,
      decisionState: context.decisionState,
      revisitPlans,
      sourceReadiness,
    });
  }

  getReviewLeadPanel(id: string): ReviewLeadPanelProjection | null {
    return this.reviewLeadPanel(id);
  }

  private freshLeadsForScout(scoutId: string, at = this.now()) {
    const cutoff = at - FRESH_LEAD_WINDOW_MS;
    return this.listLeads().filter(
      (lead) => lead.scoutIds.includes(scoutId) && lead.updatedAt >= cutoff,
    );
  }

  listScouts(): ScoutSummary[] {
    return this.db
      .select()
      .from(scouts)
      .where(eq(scouts.lifecycleState, "active"))
      .orderBy(asc(scouts.createdAt), asc(scouts.id))
      .all()
      .map((row) => toScoutSummary(this.db, row));
  }

  getScout(id: string): ScoutSummary | null {
    const row = this.db.select().from(scouts).where(eq(scouts.id, id)).get();
    return row ? toScoutSummary(this.db, row) : null;
  }

  createScout(command: CreateScoutCommand): CommandResult<ScoutSummary> {
    const explicitSourceSelection = command.sourceIds !== undefined;
    const normalized = {
      name: command.name.trim(),
      harness: ScoutHarness.parse(command.harness),
      instructionPath: command.instructionPath.trim(),
      strategyPath: command.strategyPath ?? null,
      strategyMaterial: command.strategyMaterial?.trim() ?? "",
      policyMaterial: command.policyMaterial?.trim() ?? "",
      sourceIds: [
        ...new Set((command.sourceIds ?? []).map((id) => id.trim()).filter(Boolean)),
      ].sort(),
      sourceSelectionSpecified: explicitSourceSelection,
      defaultProfileId: command.defaultProfileId ?? null,
      resumableSessionRef: command.resumableSessionRef ?? null,
    };
    assertSafeMaterial(normalized.strategyMaterial, "Discovery Strategy");
    assertSafeMaterial(normalized.policyMaterial, "Scout Policy");
    if (!normalized.name || !normalized.instructionPath || !command.idempotencyKey.trim()) {
      throw new RecruitingError(
        "VALIDATION",
        "Scout name, instruction path, and idempotency key are required",
      );
    }
    const payloadHash = hashPayload(normalized);
    let notification: RecruitingInvalidation | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(tx, "scout", "root", "create", command.idempotencyKey);
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        const value = parseResult<ScoutSummary>(previous.result);
        return { value, revision: currentRevision(tx), replayed: true };
      }

      const id = randomUUID();
      const at = this.now();
      const sourceIds =
        !explicitSourceSelection && this.webSearchSettings?.().configured
          ? [WEB_SEARCH_SOURCE_ID]
          : normalized.sourceIds;
      assertSourceIdsExist(tx, sourceIds);
      if (normalized.defaultProfileId !== null) {
        const profile = tx
          .select()
          .from(profiles)
          .where(eq(profiles.id, normalized.defaultProfileId))
          .get();
        if (!profile || profile.state !== "confirmed" || !profile.currentVersionId) {
          throw new RecruitingError(
            "VALIDATION",
            "A Scout default must be a confirmed Candidate Profile",
          );
        }
      } else if (sourceIds.length > 0 || tx.select().from(profiles).limit(1).get()) {
        throw new RecruitingError(
          "VALIDATION",
          "Every configured Scout requires a default confirmed Candidate Profile",
        );
      }
      tx.insert(scouts)
        .values({
          id,
          name: normalized.name,
          harness: normalized.harness,
          instructionPath: normalized.instructionPath,
          strategyPath: normalized.strategyPath,
          strategyMaterial: normalized.strategyMaterial,
          policyMaterial: normalized.policyMaterial,
          defaultProfileId: normalized.defaultProfileId,
          lifecycleState: "active",
          resumableSessionRef: normalized.resumableSessionRef,
          legacyAgentId: null,
          revision: 0,
          createdAt: at,
          archivedAt: null,
        })
        .run();
      for (const sourceId of sourceIds) {
        tx.insert(scoutSources).values({ scoutId: id, sourceId, selectedAt: at }).run();
      }
      const value = toScoutSummary(tx, requireScout(tx, id));
      const revision = advanceRevision(tx);
      writeReceipt(tx, {
        scopeKind: "scout",
        scopeId: "root",
        commandKind: "create",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(value),
        createdAt: at,
        completedAt: at,
      });
      notification = { revision, kind: "scout", ids: [id], reason: "scout_created", at };
      return { value, revision, replayed: false };
    });
    if (notification) bus.emitEvent("recruiting:changed", notification);
    return outcome;
  }

  updateScout(command: UpdateScoutCommand): CommandResult<ScoutSummary> {
    if (!command.idempotencyKey.trim())
      throw new RecruitingError("VALIDATION", "Idempotency key is required");
    const sourceIds = command.sourceIds
      ? [...new Set(command.sourceIds.map((id) => id.trim()).filter(Boolean))].sort()
      : undefined;
    const normalized = {
      scoutId: command.scoutId,
      expectedRevision: command.expectedRevision,
      name: command.name?.trim(),
      instructionPath: command.instructionPath?.trim(),
      strategyPath: command.strategyPath,
      strategyMaterial: command.strategyMaterial?.trim(),
      policyMaterial: command.policyMaterial?.trim(),
      defaultProfileId: command.defaultProfileId,
      sourceIds,
    };
    if (normalized.name !== undefined && !normalized.name)
      throw new RecruitingError("VALIDATION", "Scout name is required");
    if (normalized.instructionPath !== undefined && !normalized.instructionPath)
      throw new RecruitingError("VALIDATION", "Scout instruction path is required");
    if (normalized.strategyMaterial !== undefined)
      assertSafeMaterial(normalized.strategyMaterial, "Discovery Strategy");
    if (normalized.policyMaterial !== undefined)
      assertSafeMaterial(normalized.policyMaterial, "Scout Policy");
    const payloadHash = hashPayload(normalized);
    let notification: RecruitingInvalidation | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(tx, "scout", command.scoutId, "update", command.idempotencyKey);
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseResult<ScoutSummary>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const row = requireScout(tx, command.scoutId);
      if (row.revision !== command.expectedRevision)
        throw new RecruitingError(
          "CONFLICT",
          `Scout ${row.id} is at revision ${row.revision}; expected ${command.expectedRevision}`,
        );
      if (sourceIds) assertSourceIdsExist(tx, sourceIds);
      if (normalized.defaultProfileId !== undefined && normalized.defaultProfileId !== null) {
        const profile = tx
          .select()
          .from(profiles)
          .where(eq(profiles.id, normalized.defaultProfileId))
          .get();
        if (!profile || profile.state !== "confirmed" || !profile.currentVersionId) {
          throw new RecruitingError(
            "VALIDATION",
            "A Scout default must be a confirmed Candidate Profile",
          );
        }
      }
      const at = this.now();
      tx.update(scouts)
        .set({
          ...(normalized.name !== undefined ? { name: normalized.name } : {}),
          ...(normalized.instructionPath !== undefined
            ? { instructionPath: normalized.instructionPath }
            : {}),
          ...(normalized.strategyPath !== undefined
            ? { strategyPath: normalized.strategyPath }
            : {}),
          ...(normalized.strategyMaterial !== undefined
            ? { strategyMaterial: normalized.strategyMaterial }
            : {}),
          ...(normalized.policyMaterial !== undefined
            ? { policyMaterial: normalized.policyMaterial }
            : {}),
          ...(normalized.defaultProfileId !== undefined
            ? { defaultProfileId: normalized.defaultProfileId }
            : {}),
          revision: row.revision + 1,
        })
        .where(eq(scouts.id, row.id))
        .run();
      if (sourceIds) {
        tx.delete(scoutSources).where(eq(scoutSources.scoutId, row.id)).run();
        for (const sourceId of sourceIds)
          tx.insert(scoutSources).values({ scoutId: row.id, sourceId, selectedAt: at }).run();
      }
      const value = toScoutSummary(tx, requireScout(tx, row.id));
      const revision = advanceRevision(tx);
      writeReceipt(tx, {
        scopeKind: "scout",
        scopeId: row.id,
        commandKind: "update",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(value),
        createdAt: at,
        completedAt: at,
      });
      notification = { revision, kind: "scout", ids: [row.id], reason: "scout_updated", at };
      return { value, revision, replayed: false };
    });
    if (notification) bus.emitEvent("recruiting:changed", notification);
    return outcome;
  }

  archiveScout(command: ArchiveScoutCommand): CommandResult<ScoutSummary> {
    if (!command.idempotencyKey.trim()) {
      throw new RecruitingError("VALIDATION", "Idempotency key is required");
    }
    const payload = { scoutId: command.scoutId, expectedRevision: command.expectedRevision };
    const payloadHash = hashPayload(payload);
    let notification: RecruitingInvalidation | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(tx, "scout", command.scoutId, "archive", command.idempotencyKey);
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseResult<ScoutSummary>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const row = tx.select().from(scouts).where(eq(scouts.id, command.scoutId)).get();
      if (!row) throw new RecruitingError("NOT_FOUND", `Scout ${command.scoutId} was not found`);
      if (row.revision !== command.expectedRevision) {
        throw new RecruitingError(
          "CONFLICT",
          `Scout ${command.scoutId} is at revision ${row.revision}; expected ${command.expectedRevision}`,
        );
      }
      const at = this.now();
      tx.update(scouts)
        .set({ lifecycleState: "archived", archivedAt: at, revision: row.revision + 1 })
        .where(eq(scouts.id, command.scoutId))
        .run();
      const value = toScoutSummary(tx, requireScout(tx, command.scoutId));
      const revision = advanceRevision(tx);
      writeReceipt(tx, {
        scopeKind: "scout",
        scopeId: command.scoutId,
        commandKind: "archive",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(value),
        createdAt: at,
        completedAt: at,
      });
      notification = {
        revision,
        kind: "scout",
        ids: [command.scoutId],
        reason: "scout_archived",
        at,
      };
      return { value, revision, replayed: false };
    });
    if (notification) bus.emitEvent("recruiting:changed", notification);
    return outcome;
  }

  revision(): number {
    return currentRevision(this.db);
  }
}

const FRESH_LEAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

function sourceReadinessAggregate(sources: SourceSummary[]): SourceReadinessAggregate {
  const counts: Record<string, number> = {};
  for (const source of sources) counts[source.readiness] = (counts[source.readiness] ?? 0) + 1;
  const ready = counts.ready ?? 0;
  return {
    total: sources.length,
    ready,
    needsAttention: sources.length - ready,
    counts,
  };
}

function buildRunActivity(input: {
  recentRuns: ScoutRunSummary[];
  sourceAttempts: SourceAttemptSummary[];
  signals: SignalSummary[];
  checkpoints: ScoutRunCheckpointSummary[];
  leads: ReturnType<RecruitingApplication["listLeads"]>;
}): ScoutRunActivity[] {
  const items: ScoutRunActivity[] = [];
  for (const run of input.recentRuns) {
    items.push(
      ScoutRunActivitySchema.parse({
        id: `${run.id}:created`,
        runId: run.id,
        kind: "run_created",
        phase: run.phase,
        at: run.createdAt,
        sourceId: null,
        sourceAttemptId: null,
        signalId: null,
        leadId: null,
        outcome: null,
        message: "Scout Run created with bounded inputs",
      }),
    );
    if (run.status !== "queued") {
      items.push(
        ScoutRunActivitySchema.parse({
          id: `${run.id}:status:${run.status}`,
          runId: run.id,
          kind: "run_status_changed",
          phase: run.phase,
          at: run.completedAt ?? run.startedAt ?? run.createdAt,
          sourceId: null,
          sourceAttemptId: null,
          signalId: null,
          leadId: null,
          outcome: null,
          message: `Run is ${run.status}`,
        }),
      );
    }
  }
  for (const checkpoint of input.checkpoints) {
    items.push(
      ScoutRunActivitySchema.parse({
        id: checkpoint.id,
        runId: checkpoint.runId,
        kind: "checkpoint_committed",
        phase: checkpoint.phase,
        at: checkpoint.createdAt,
        sourceId: null,
        sourceAttemptId: null,
        signalId: null,
        leadId: null,
        outcome: null,
        message: `Checkpoint ${checkpoint.sequence} committed`,
      }),
    );
  }
  for (const attempt of input.sourceAttempts) {
    items.push(
      ScoutRunActivitySchema.parse({
        id: attempt.id,
        runId: attempt.runId,
        kind: "source_attempt_completed",
        phase: "discovery",
        at: attempt.completedAt ?? attempt.startedAt,
        sourceId: attempt.sourceId,
        sourceAttemptId: attempt.id,
        signalId: null,
        leadId: null,
        outcome: attempt.outcome,
        message: `Source Attempt ${attempt.outcome}`,
      }),
    );
  }
  for (const signal of input.signals) {
    items.push(
      ScoutRunActivitySchema.parse({
        id: signal.id,
        runId: signal.runId,
        kind: "signal_recorded",
        phase: "discovery",
        at: signal.observedAt,
        sourceId: signal.sourceId,
        sourceAttemptId: signal.sourceAttemptId,
        signalId: signal.id,
        leadId: null,
        outcome: null,
        message: "Signal recorded with safe provenance",
      }),
    );
  }
  for (const lead of input.leads) {
    for (const signalId of lead.signalIds) {
      const signal = input.signals.find((candidate) => candidate.id === signalId);
      if (!signal) continue;
      items.push(
        ScoutRunActivitySchema.parse({
          id: `${lead.id}:${signal.id}:linked`,
          runId: signal.runId,
          kind: "lead_linked",
          phase: "discovery",
          at: lead.updatedAt,
          sourceId: signal.sourceId,
          sourceAttemptId: signal.sourceAttemptId,
          signalId: signal.id,
          leadId: lead.id,
          outcome: null,
          message: "Signal linked to canonical Lead",
        }),
      );
    }
  }
  return items.sort((left, right) => right.at - left.at || right.id.localeCompare(left.id));
}

function toScoutSummary(db: RecruitingDb, row: typeof scouts.$inferSelect): ScoutSummary {
  return {
    id: row.id,
    name: row.name,
    harness: ScoutHarness.parse(row.harness),
    instructionPath: row.instructionPath,
    strategyPath: row.strategyPath,
    strategyMaterial: row.strategyMaterial ?? "",
    policyMaterial: row.policyMaterial ?? "",
    defaultProfileId: row.defaultProfileId,
    sourceIds: db
      .select({ sourceId: scoutSources.sourceId })
      .from(scoutSources)
      .where(eq(scoutSources.scoutId, row.id))
      .orderBy(asc(scoutSources.selectedAt), asc(scoutSources.sourceId))
      .all()
      .map((item) => item.sourceId),
    lifecycleState: row.lifecycleState === "archived" ? "archived" : "active",
    resumableSessionRef: row.resumableSessionRef,
    legacyAgentId: row.legacyAgentId,
    revision: row.revision,
    createdAt: row.createdAt,
  };
}

function assertSourceIdsExist(db: RecruitingDb, sourceIds: string[]): void {
  if (sourceIds.length === 0) return;
  const rows = db
    .select({ id: sources.id })
    .from(sources)
    .where(inArray(sources.id, sourceIds))
    .all();
  const existing = new Set(rows.map((row) => row.id));
  const missing = sourceIds.find((id) => !existing.has(id));
  if (missing) throw new RecruitingError("VALIDATION", `Source ${missing} was not found`);
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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
  if (receipt.payloadHash !== payloadHash) {
    throw new RecruitingError(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used with a different command payload",
    );
  }
}

function parseResult<T>(result: string | null): T {
  if (!result) throw new RecruitingError("VALIDATION", "Command receipt has no result");
  return JSON.parse(result) as T;
}

function currentRevision(db: RecruitingDb): number {
  return db.select().from(domainClock).where(eq(domainClock.id, 1)).get()?.revision ?? 0;
}

function requireScout(db: RecruitingDb, id: string): typeof scouts.$inferSelect {
  const row = db.select().from(scouts).where(eq(scouts.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Scout ${id} was not found`);
  return row;
}

function advanceRevision(db: RecruitingDb): number {
  db.update(domainClock)
    .set({ revision: sql`${domainClock.revision} + 1` })
    .where(eq(domainClock.id, 1))
    .run();
  return currentRevision(db);
}

function writeReceipt(
  db: RecruitingDb,
  receipt: Omit<typeof commandReceipts.$inferInsert, "id">,
): void {
  db.insert(commandReceipts)
    .values({ id: randomUUID(), ...receipt })
    .run();
}
