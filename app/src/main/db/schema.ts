import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Registry row per agent folder. Runtime `status` is a mirror, rewritten on boot. */
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  template: text("template").notNull().default("default"),
  /** Which agent CLI runs this agent ("claude" | "codex"); fixed at creation. */
  harness: text("harness").notNull().default("claude"),
  /** Retained only to read legacy rows; the recruiting API never projects this value. */
  legacyApprovalMode: text("approval_mode").notNull().default("approve"),
  lastSessionId: text("last_session_id"),
  status: text("status").notNull().default("idle"),
  /** Headless wake runs since the user last viewed this agent (reset on view). */
  headlessTurnsUsed: integer("headless_turns_used").notNull().default(0),
  /** Whether the global headless turn limit applies to this agent. */
  turnLimitEnabled: integer("turn_limit_enabled", { mode: "boolean" }).notNull().default(true),
  /** Last time the AGENT spoke — its turn ended, or it asked for input (§6.7 status
   *  hook). Feeds `Agent.lastActiveAt` (§12.6). Persisted rather than held in memory so
   *  it survives a host restart, which every app update forces. Null = never. */
  lastTurnAt: integer("last_turn_at"),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
});

/** Legacy inherited rows retained for recovery; no active recruiting path writes them. */
export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  toolName: text("tool_name").notNull(),
  rawInput: text("raw_input").notNull(),
  parsed: text("parsed"),
  status: text("status").notNull().default("pending"),
  decidedBy: text("decided_by"),
  note: text("note"),
  /** Legacy outcome JSON, retained without interpretation during migration. */
  outcome: text("outcome"),
  requestedAt: integer("requested_at").notNull(),
  decidedAt: integer("decided_at"),
});

/** Legacy append-only event feed, retained without an active renderer projection. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id"),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("audit_agent_at").on(t.agentId, t.at)],
);

/** Legacy provider cache entries, retained without an active recruiting reader/writer. */
export const brokerCache = sqliteTable("broker_cache", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

/** Host-owned kv. oauth_tokens are safeStorage-encrypted blobs; provider
 * credentials (such as Firecrawl) are read only by host services and never
 * included in renderer projections or agent configuration. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Durable cron schedules owned by the backend (survive app close / host restart,
 * unlike Claude Code's session-scoped CronCreate). `next_fire_at` is advisory —
 * the scheduler recomputes it from `cron_expr` on boot rather than trusting it.
 */
export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    cronExpr: text("cron_expr").notNull(),
    prompt: text("prompt").notNull(),
    recurring: integer("recurring", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextFireAt: integer("next_fire_at"),
    lastFiredAt: integer("last_fired_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("schedules_agent").on(t.agentId)],
);

/**
 * Durable signal monitors: a supervised backend child whose stdout lines are
 * triggers (mirrors Claude Code's Monitor, but runs regardless of the GUI).
 */
export const monitors = sqliteTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    command: text("command").notNull(),
    description: text("description"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastFiredAt: integer("last_fired_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("monitors_agent").on(t.agentId)],
);

/**
 * Append-only record of every autonomy wake (a cron firing or a monitor trigger).
 * Distinct from the audit log: this is the Run History pane's own source, so wake
 * fires never get entangled with the trade-lifecycle feed. `schedules`/`monitors`
 * only carry a single `last_fired_at`; this keeps the full per-fire history.
 */
export const wakes = sqliteTable(
  "wakes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    sourceKind: text("source_kind").notNull(), // "cron" | "monitor"
    /** Id of the originating schedule/monitor row, joined with `source_kind`. Lets a
     *  wake resolve its (possibly retired) timer's details for the history pane.
     *  Nullable: rows written before this column existed read NULL. */
    sourceId: text("source_id"),
    prompt: text("prompt").notNull(),
    /** True if delivered headlessly (no live interactive session); false if warm via the channel. */
    background: integer("background", { mode: "boolean" }).notNull(),
    firedAt: integer("fired_at").notNull(),
  },
  (t) => [index("wakes_agent_fired").on(t.agentId, t.firedAt)],
);

/**
 * Durable **ring buffer** of the last N notify events — deliberately NOT a
 * notification log: rows beyond the cap are pruned on every insert and gone for
 * good. Sole consumer is the tray's Recent submenu (§12.6), which needs the list to
 * survive launcher *and* host restarts. Ordered/pruned by the autoincrement `id`
 * (monotonic, never reused), so same-millisecond `at` ties can't misorder.
 */
export const recentNotifications = sqliteTable("recent_notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  agentId: text("agent_id"),
  at: integer("at").notNull(),
});

// Recruiting persistence starts at schema v6. These tables deliberately live beside
// the inherited tables during the additive migration. The host owns all
// writes; the renderer only receives projections from the Recruiting application.
export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  roleTarget: text("role_target").notNull().default(""),
  artifactPath: text("artifact_path").notNull(),
  state: text("state").notNull().default("draft"),
  currentVersionId: text("current_version_id"),
  contentHash: text("content_hash"),
  draftMarkdown: text("draft_markdown"),
  draftStructured: text("draft_structured"),
  draftProvenance: text("draft_provenance"),
  revision: integer("revision").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const profileVersions = sqliteTable(
  "profile_versions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id),
    versionNo: integer("version_no").notNull(),
    markdownSnapshot: text("markdown_snapshot").notNull(),
    structuredSnapshot: text("structured_snapshot").notNull(),
    provenance: text("provenance").notNull(),
    contentHash: text("content_hash").notNull(),
    confirmedAt: integer("confirmed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("profile_versions_number").on(t.profileId, t.versionNo),
    uniqueIndex("profile_versions_hash").on(t.profileId, t.contentHash),
  ],
);

export const scouts = sqliteTable(
  "scouts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    harness: text("harness").notNull().default("claude"),
    instructionPath: text("instruction_path").notNull(),
    strategyPath: text("strategy_path"),
    strategyMaterial: text("strategy_material").notNull().default(""),
    policyMaterial: text("policy_material").notNull().default(""),
    instructionHash: text("instruction_hash"),
    strategyHash: text("strategy_hash"),
    defaultProfileId: text("default_profile_id").references(() => profiles.id),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    resumableSessionRef: text("resumable_session_ref"),
    legacyAgentId: text("legacy_agent_id").references(() => agents.id),
    revision: integer("revision").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    archivedAt: integer("archived_at"),
  },
  (t) => [
    uniqueIndex("scouts_legacy_agent").on(t.legacyAgentId),
    index("scouts_lifecycle").on(t.lifecycleState, t.createdAt),
  ],
);

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  config: text("config").notNull().default("{}"),
  readiness: text("readiness").notNull().default("not_configured"),
  safeFailure: text("safe_failure"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sourceAccess = sqliteTable(
  "source_access",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    accountRef: text("account_ref").notNull().default(""),
    scopeKey: text("scope_key").notNull(),
    accessMode: text("access_mode").notNull().default("public"),
    readiness: text("readiness").notNull().default("not_configured"),
    safeFailure: text("safe_failure"),
    lastCheckedAt: integer("last_checked_at"),
    lastSuccessAt: integer("last_success_at"),
    nextAction: text("next_action"),
    retryAt: integer("retry_at"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    cursor: text("cursor"),
    sourceIdentity: text("source_identity"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("source_access_scope").on(t.sourceId, t.accountRef, t.scopeKey)],
);

export const scoutSources = sqliteTable(
  "scout_sources",
  {
    scoutId: text("scout_id")
      .notNull()
      .references(() => scouts.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    selectedAt: integer("selected_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scoutId, t.sourceId] })],
);

export const scoutRuns = sqliteTable(
  "scout_runs",
  {
    id: text("id").primaryKey(),
    scoutId: text("scout_id")
      .notNull()
      .references(() => scouts.id),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("queued"),
    phase: text("phase").notNull().default("preflight"),
    budget: text("budget").notNull().default("{}"),
    profileVersionId: text("profile_version_id").references(() => profileVersions.id),
    profileSnapshot: text("profile_snapshot"),
    strategySnapshot: text("strategy_snapshot"),
    policySnapshot: text("policy_snapshot"),
    overrideSnapshot: text("override_snapshot"),
    checkpoint: text("checkpoint"),
    safeFailure: text("safe_failure"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("scout_runs_scout_created").on(t.scoutId, t.createdAt),
    uniqueIndex("scout_runs_one_active")
      .on(t.scoutId)
      .where(sql`status IN ('queued', 'preflight', 'running', 'finalizing')`),
  ],
);

/** Durable intent to run a Scout. Requests are separate from Scout Runs so a
 * request can survive a host restart, wait for a Scout's current Run to finish,
 * and be coalesced before it consumes a Run slot. */
export const scoutRunRequests = sqliteTable(
  "scout_run_requests",
  {
    id: text("id").primaryKey(),
    scoutId: text("scout_id")
      .notNull()
      .references(() => scouts.id),
    trigger: text("trigger").notNull(),
    requestKey: text("request_key").notNull(),
    sourceId: text("source_id").references(() => sources.id),
    leadId: text("lead_id").references(() => leads.id),
    opportunityId: text("opportunity_id").references(() => opportunities.id),
    investigationId: text("investigation_id").references(() => investigations.id),
    reason: text("reason").notNull().default(""),
    budget: text("budget").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    runId: text("run_id").references(() => scoutRuns.id),
    safeFailure: text("safe_failure"),
    createdAt: integer("created_at").notNull(),
    dispatchedAt: integer("dispatched_at"),
    wakeDeliveredAt: integer("wake_delivered_at"),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("scout_run_requests_scout_created").on(t.scoutId, t.createdAt),
    uniqueIndex("scout_run_requests_pending_key")
      .on(t.scoutId, t.requestKey)
      .where(sql`status IN ('pending', 'dispatching')`),
  ],
);

export const scoutRunCheckpoints = sqliteTable(
  "scout_run_checkpoints",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scoutRuns.id),
    sequence: integer("sequence").notNull(),
    phase: text("phase").notNull(),
    checkpoint: text("checkpoint").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("scout_run_checkpoint_sequence").on(t.runId, t.sequence)],
);

export const sourceAttempts = sqliteTable(
  "source_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scoutRuns.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    requestedScope: text("requested_scope").notNull().default("{}"),
    cursor: text("cursor"),
    outcome: text("outcome").notNull().default("started"),
    itemCount: integer("item_count").notNull().default(0),
    quarantinedCount: integer("quarantined_count").notNull().default(0),
    pageCount: integer("page_count").notNull().default(0),
    retryAt: integer("retry_at"),
    safeFailure: text("safe_failure"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [index("source_attempts_run").on(t.runId, t.startedAt)],
);

export const sourceItems = sqliteTable(
  "source_items",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    identityKey: text("identity_key").notNull(),
    canonicalUrl: text("canonical_url"),
    providerIdentity: text("provider_identity"),
    latestFingerprint: text("latest_fingerprint"),
    latestSignalId: text("latest_signal_id"),
    deletionMarkerAt: integer("deletion_marker_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("source_items_identity").on(t.sourceId, t.identityKey)],
);

export const signals = sqliteTable(
  "signals",
  {
    id: text("id").primaryKey(),
    sourceItemId: text("source_item_id")
      .notNull()
      .references(() => sourceItems.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceAttemptId: text("source_attempt_id")
      .notNull()
      .references(() => sourceAttempts.id),
    runId: text("run_id")
      .notNull()
      .references(() => scoutRuns.id),
    fingerprint: text("fingerprint").notNull(),
    provenance: text("provenance").notNull(),
    publicationAt: integer("publication_at"),
    observedAt: integer("observed_at").notNull(),
    retrievedAt: integer("retrieved_at").notNull(),
    evidence: text("evidence").notNull(),
    accessMode: text("access_mode").notNull().default("public"),
    adapterVersion: text("adapter_version").notNull().default("rss-atom-v1"),
    processor: text("processor").notNull().default("openrecruit-rss-atom"),
    retentionUntil: integer("retention_until"),
    supersededSignalId: text("superseded_signal_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("signals_observation_fingerprint").on(t.sourceItemId, t.fingerprint)],
);

export const signalAttributions = sqliteTable(
  "signal_attributions",
  {
    signalId: text("signal_id")
      .notNull()
      .references(() => signals.id),
    runId: text("run_id")
      .notNull()
      .references(() => scoutRuns.id),
    scoutId: text("scout_id")
      .notNull()
      .references(() => scouts.id),
    strategyKey: text("strategy_key"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.signalId, t.runId] })],
);

export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  canonicalKey: text("canonical_key").notNull().unique(),
  title: text("title").notNull(),
  summary: text("summary"),
  identityState: text("identity_state").notNull().default("settled"),
  conflict: text("conflict"),
  /** A merged Lead remains as history and redirects to its canonical Lead. */
  mergedInto: text("merged_into"),
  revision: integer("revision").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const leadAliases = sqliteTable(
  "lead_aliases",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
  },
  (t) => [uniqueIndex("lead_aliases_identity").on(t.kind, t.value)],
);

export const leadSignalLinks = sqliteTable(
  "lead_signal_links",
  {
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id),
    signalId: text("signal_id")
      .notNull()
      .references(() => signals.id),
    relation: text("relation").notNull().default("supporting"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.leadId, t.signalId] })],
);

export const opportunities = sqliteTable("opportunities", {
  id: text("id").primaryKey(),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id),
  title: text("title").notNull(),
  state: text("state").notNull().default("active"),
  revision: integer("revision").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const fitEvaluations = sqliteTable(
  "fit_evaluations",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id").references(() => leads.id),
    opportunityId: text("opportunity_id").references(() => opportunities.id),
    profileVersionId: text("profile_version_id")
      .notNull()
      .references(() => profileVersions.id),
    runId: text("run_id")
      .notNull()
      .references(() => scoutRuns.id),
    strategyHash: text("strategy_hash"),
    policyHash: text("policy_hash"),
    detail: text("detail").notNull(),
    freshness: text("freshness").notNull(),
    staleReason: text("stale_reason"),
    staleAt: integer("stale_at"),
    createdAt: integer("created_at").notNull(),
  },
  () => [
    check(
      "fit_evaluations_one_subject",
      sql`(lead_id IS NOT NULL) <> (opportunity_id IS NOT NULL)`,
    ),
  ],
);

export const fitEvaluationSignalLinks = sqliteTable(
  "fit_evaluation_signal_links",
  {
    evaluationId: text("evaluation_id")
      .notNull()
      .references(() => fitEvaluations.id),
    signalId: text("signal_id")
      .notNull()
      .references(() => signals.id),
  },
  (t) => [primaryKey({ columns: [t.evaluationId, t.signalId] })],
);

export const investigations = sqliteTable(
  "investigations",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id").references(() => leads.id),
    opportunityId: text("opportunity_id").references(() => opportunities.id),
    questionKey: text("question_key").notNull(),
    questionSnapshot: text("question_snapshot").notNull(),
    status: text("status").notNull().default("open"),
    revision: integer("revision").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("investigations_one_subject", sql`(lead_id IS NOT NULL) <> (opportunity_id IS NOT NULL)`),
    uniqueIndex("investigations_lead_question")
      .on(t.leadId, t.questionKey)
      .where(sql`lead_id IS NOT NULL`),
    uniqueIndex("investigations_opportunity_question")
      .on(t.opportunityId, t.questionKey)
      .where(sql`opportunity_id IS NOT NULL`),
  ],
);

export const investigationAttempts = sqliteTable(
  "investigation_attempts",
  {
    id: text("id").primaryKey(),
    investigationId: text("investigation_id")
      .notNull()
      .references(() => investigations.id),
    scoutId: text("scout_id")
      .notNull()
      .references(() => scouts.id),
    runId: text("run_id").references(() => scoutRuns.id),
    profileVersionId: text("profile_version_id").references(() => profileVersions.id),
    questionSnapshot: text("question_snapshot").notNull(),
    evidence: text("evidence").notNull().default("[]"),
    conclusion: text("conclusion"),
    uncertainty: text("uncertainty"),
    outcome: text("outcome").notNull(),
    rerunReason: text("rerun_reason"),
    strategySnapshot: text("strategy_snapshot").notNull().default(""),
    policySnapshot: text("policy_snapshot").notNull().default(""),
    freshness: text("freshness").notNull().default("fresh"),
    supersedesAttemptId: text("supersedes_attempt_id"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("investigation_attempts_subject").on(t.investigationId, t.createdAt),
    uniqueIndex("investigation_attempts_one_active")
      .on(t.investigationId)
      .where(sql`outcome = 'in_progress'`),
  ],
);

export const revisitPlans = sqliteTable(
  "revisit_plans",
  {
    id: text("id").primaryKey(),
    scoutId: text("scout_id")
      .notNull()
      .references(() => scouts.id),
    sourceId: text("source_id").references(() => sources.id),
    leadId: text("lead_id").references(() => leads.id),
    opportunityId: text("opportunity_id").references(() => opportunities.id),
    investigationId: text("investigation_id").references(() => investigations.id),
    kind: text("kind").notNull(),
    cadence: text("cadence"),
    dueAt: integer("due_at"),
    state: text("state").notNull().default("active"),
    policySnapshot: text("policy_snapshot").notNull().default("{}"),
    revision: integer("revision").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check(
      "revisit_plans_one_subject",
      sql`((source_id IS NOT NULL) + (lead_id IS NOT NULL) + (opportunity_id IS NOT NULL) + (investigation_id IS NOT NULL)) = 1`,
    ),
    uniqueIndex("revisit_plans_source_identity")
      .on(t.scoutId, t.sourceId)
      .where(sql`source_id IS NOT NULL`),
    uniqueIndex("revisit_plans_lead_identity")
      .on(t.scoutId, t.leadId)
      .where(sql`lead_id IS NOT NULL`),
    uniqueIndex("revisit_plans_opportunity_identity")
      .on(t.scoutId, t.opportunityId)
      .where(sql`opportunity_id IS NOT NULL`),
    uniqueIndex("revisit_plans_investigation_identity")
      .on(t.scoutId, t.investigationId)
      .where(sql`investigation_id IS NOT NULL`),
  ],
);

export const candidateDecisions = sqliteTable(
  "candidate_decisions",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id").references(() => leads.id),
    opportunityId: text("opportunity_id").references(() => opportunities.id),
    kind: text("kind").notNull(),
    detail: text("detail").notNull().default("{}"),
    expectedRevision: integer("expected_revision"),
    createdAt: integer("created_at").notNull(),
  },
  () => [
    check(
      "candidate_decisions_one_subject",
      sql`(lead_id IS NOT NULL) <> (opportunity_id IS NOT NULL)`,
    ),
  ],
);

export const domainClock = sqliteTable("domain_clock", {
  id: integer("id").primaryKey(),
  revision: integer("revision").notNull(),
});

export const commandReceipts = sqliteTable(
  "command_receipts",
  {
    id: text("id").primaryKey(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id"),
    commandKind: text("command_kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull(),
    result: text("result"),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [
    uniqueIndex("command_receipts_identity").on(
      t.scopeKind,
      t.scopeId,
      t.commandKind,
      t.idempotencyKey,
    ),
  ],
);
