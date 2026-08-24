import { createHash, randomUUID } from "node:crypto";
import {
  RevisitPlanSummary,
  type RevisitPlanSummary as RevisitPlanSummaryValue,
  ScoutRunCenterProjection,
  type ScoutRunCenterProjection as ScoutRunCenterProjectionValue,
  ScoutRunRequestSummary,
  type ScoutRunRequestSummary as ScoutRunRequestSummaryValue,
  type ScoutRunRequestTrigger as ScoutRunRequestTriggerValue,
  type ScoutRunSummary as ScoutRunSummaryValue,
} from "@shared/recruiting";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  commandReceipts,
  domainClock,
  investigations,
  leads,
  opportunities,
  revisitPlans,
  scoutRunRequests,
  scoutRuns,
  scoutSources,
  scouts,
  sourceAccess,
  sources,
} from "../../db/schema";
import { bus } from "../event-bus";
import type { WakeTransport } from "../scheduler/wake/types";
import { RecruitingError } from "./errors";
import type { LaunchScoutRunCommand, RunBudget } from "./scout-runs";

export type RevisitTarget = {
  sourceId?: string;
  leadId?: string;
  opportunityId?: string;
  investigationId?: string;
};

export type CreateRevisitPlanCommand = RevisitTarget & {
  scoutId: string;
  cadence?: string | null;
  dueAt?: number | null;
  policySnapshot?: string;
  idempotencyKey: string;
};

export type UpdateRevisitPlanCommand = {
  planId: string;
  expectedRevision: number;
  cadence?: string | null;
  dueAt?: number | null;
  state?: "active" | "paused" | "completed";
  policySnapshot?: string;
  idempotencyKey: string;
};

export type RequestScoutRunCommand = RevisitTarget & {
  scoutId: string;
  trigger: ScoutRunRequestTriggerValue;
  reason?: string;
  requestKey?: string;
  budget?: Partial<RunBudget>;
  idempotencyKey: string;
};

export type RequestScheduledRefreshCommand = Omit<RequestScoutRunCommand, "trigger"> & {
  trigger?: never;
};

export type RequestSourceEventCommand = Omit<RequestScoutRunCommand, "trigger" | "sourceId"> & {
  sourceId: string;
};

export type RequestCandidateRunCommand = Omit<RequestScoutRunCommand, "trigger">;

export type RequestExplicitReconsiderationCommand = Omit<RequestScoutRunCommand, "trigger">;

type LaunchPinnedRun = (command: LaunchScoutRunCommand) => {
  value: { id: string };
  revision: number;
  replayed: boolean;
};

type RevisitDb = Pick<Db, "select" | "insert" | "update" | "delete" | "transaction">;

const MAX_REQUEST_ATTEMPTS = 3;
const ACTIVE_REQUEST_STATES = ["pending", "dispatching"] as const;

/**
 * Durable Recruiting scheduling seam. Legacy schedules/monitors are deliberately
 * not read here: they remain recoverable in their original tables and cannot be
 * silently converted into Recruiting intent.
 */
export class RevisitPlanApplication {
  private wake?: WakeTransport;

  constructor(
    private readonly db: Db,
    private readonly launchRun: LaunchPinnedRun,
    private readonly summarizeRun: (runId: string) => ScoutRunSummaryValue | null,
    private readonly now: () => number = Date.now,
    private readonly isSuppressed?: (target: RevisitTarget) => boolean,
  ) {}

  setWake(wake: WakeTransport): void {
    this.wake = wake;
    // A host can die after claiming a request but before the wake reaches the
    // harness. Requeue only those durable active Run intents on the next host;
    // legacy wakes are deliberately left to their own scheduler recovery.
    this.db
      .update(scoutRunRequests)
      .set({ status: "pending", nextAttemptAt: this.now() })
      .where(eq(scoutRunRequests.status, "dispatching"))
      .run();
    const active = this.db
      .select({ request: scoutRunRequests, run: scoutRuns })
      .from(scoutRunRequests)
      .innerJoin(scoutRuns, eq(scoutRuns.id, scoutRunRequests.runId))
      .where(
        and(
          eq(scoutRunRequests.status, "dispatched"),
          isNull(scoutRunRequests.wakeDeliveredAt),
          inArray(scoutRuns.status, ["queued", "preflight", "running", "finalizing"]),
        ),
      )
      .all();
    for (const { request, run } of active)
      this.deliverWake(request.id, request.scoutId, run.id, "resume");
  }

  createRevisitPlan(command: CreateRevisitPlanCommand): {
    value: RevisitPlanSummaryValue;
    revision: number;
    replayed: boolean;
  } {
    const target = targetOf(command);
    const cadence = normalizeCadence(command.cadence);
    const payload = JSON.stringify({
      scoutId: command.scoutId,
      target,
      cadence,
      dueAt: command.dueAt ?? null,
      policySnapshot: command.policySnapshot ?? "{}",
    });
    const payloadHash = digest(payload);
    const result = this.db.transaction((tx) => {
      const prior = receipt(tx, "revisit-plan", command.scoutId, "create", command.idempotencyKey);
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw idempotencyError();
        return {
          value: JSON.parse(prior.result ?? "null") as RevisitPlanSummaryValue,
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      requireScout(tx, command.scoutId);
      validateTarget(tx, target);
      const duplicate = tx
        .select({ id: revisitPlans.id })
        .from(revisitPlans)
        .where(
          and(
            eq(revisitPlans.scoutId, command.scoutId),
            target.sourceId
              ? eq(revisitPlans.sourceId, target.sourceId)
              : target.leadId
                ? eq(revisitPlans.leadId, target.leadId)
                : target.opportunityId
                  ? eq(revisitPlans.opportunityId, target.opportunityId)
                  : eq(revisitPlans.investigationId, target.investigationId as string),
          ),
        )
        .get();
      if (duplicate)
        throw new RecruitingError(
          "CONFLICT",
          `Scout ${command.scoutId} already has Revisit Plan ${duplicate.id} for this subject`,
        );
      const at = this.now();
      const id = randomUUID();
      const dueAt = cadence ? (command.dueAt ?? at + cadenceMs(cadence)) : null;
      const row = {
        id,
        scoutId: command.scoutId,
        sourceId: target.sourceId ?? null,
        leadId: target.leadId ?? null,
        opportunityId: target.opportunityId ?? null,
        investigationId: target.investigationId ?? null,
        kind: target.kind,
        cadence,
        dueAt,
        state: "active" as const,
        policySnapshot: command.policySnapshot ?? "{}",
        revision: 0,
        createdAt: at,
        updatedAt: at,
      };
      tx.insert(revisitPlans).values(row).run();
      const revision = advanceRevision(tx);
      const value = toPlan(row);
      writeReceipt(tx, {
        scopeKind: "revisit-plan",
        scopeId: command.scoutId,
        commandKind: "create",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(value),
        errorCode: null,
        createdAt: at,
        completedAt: at,
      });
      return { value, revision, replayed: false };
    });
    if (!result.replayed)
      emitChange(result.revision, "revisit", [result.value.id], "revisit_plan_created", this.now());
    return result;
  }

  updateRevisitPlan(command: UpdateRevisitPlanCommand): {
    value: RevisitPlanSummaryValue;
    revision: number;
    replayed: boolean;
  } {
    const payloadHash = digest(
      JSON.stringify({
        planId: command.planId,
        expectedRevision: command.expectedRevision,
        cadence: command.cadence,
        dueAt: command.dueAt,
        state: command.state,
        policySnapshot: command.policySnapshot,
      }),
    );
    const result = this.db.transaction((tx) => {
      const prior = receipt(tx, "revisit-plan", command.planId, "update", command.idempotencyKey);
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw idempotencyError();
        return {
          value: JSON.parse(prior.result ?? "null") as RevisitPlanSummaryValue,
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const row = requirePlan(tx, command.planId);
      if (row.revision !== command.expectedRevision)
        throw new RecruitingError("CONFLICT", `Revisit Plan ${row.id} is revision ${row.revision}`);
      const cadence =
        command.cadence === undefined ? row.cadence : normalizeCadence(command.cadence);
      const at = this.now();
      const nextDue = cadence
        ? command.dueAt === undefined
          ? (row.dueAt ?? at + cadenceMs(cadence))
          : command.dueAt
        : null;
      tx.update(revisitPlans)
        .set({
          cadence,
          dueAt: nextDue,
          state: command.state ?? row.state,
          policySnapshot: command.policySnapshot ?? row.policySnapshot,
          revision: row.revision + 1,
          updatedAt: at,
        })
        .where(eq(revisitPlans.id, row.id))
        .run();
      const revision = advanceRevision(tx);
      const value = toPlan(requirePlan(tx, row.id));
      writeReceipt(tx, {
        scopeKind: "revisit-plan",
        scopeId: command.planId,
        commandKind: "update",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(value),
        errorCode: null,
        createdAt: at,
        completedAt: at,
      });
      return { value, revision, replayed: false };
    });
    if (!result.replayed)
      emitChange(result.revision, "revisit", [result.value.id], "revisit_plan_changed", this.now());
    return result;
  }

  listRevisitPlans(scoutId?: string): RevisitPlanSummaryValue[] {
    const rows = scoutId
      ? this.db
          .select()
          .from(revisitPlans)
          .where(eq(revisitPlans.scoutId, scoutId))
          .orderBy(asc(revisitPlans.dueAt), asc(revisitPlans.id))
          .all()
      : this.db
          .select()
          .from(revisitPlans)
          .orderBy(asc(revisitPlans.dueAt), asc(revisitPlans.id))
          .all();
    return rows.map(toPlan);
  }

  getRevisitPlan(id: string): RevisitPlanSummaryValue | null {
    const row = this.db.select().from(revisitPlans).where(eq(revisitPlans.id, id)).get();
    return row ? toPlan(row) : null;
  }

  requestScoutRun(command: RequestScoutRunCommand): {
    value: ScoutRunRequestSummaryValue;
    revision: number;
    replayed: boolean;
  } {
    const target = targetOf(command, { allowNone: true });
    const budget = JSON.stringify(command.budget ?? {});
    const requestKey =
      command.requestKey?.trim() ||
      digest(
        JSON.stringify({
          trigger: command.trigger,
          target,
        }),
      );
    const payloadHash = digest(
      JSON.stringify({
        scoutId: command.scoutId,
        trigger: command.trigger,
        target,
        requestKey,
        budget,
      }),
    );
    const result = this.db.transaction((tx) => {
      const prior = receipt(tx, "run-request", command.scoutId, "create", command.idempotencyKey);
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw idempotencyError();
        return {
          value: JSON.parse(prior.result ?? "null") as ScoutRunRequestSummaryValue,
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const scout = requireScout(tx, command.scoutId);
      validateTarget(tx, target, { allowNone: true });
      if (target.sourceId && command.trigger === "source_event") {
        const selected = tx
          .select({ sourceId: scoutSources.sourceId })
          .from(scoutSources)
          .where(
            and(eq(scoutSources.scoutId, scout.id), eq(scoutSources.sourceId, target.sourceId)),
          )
          .get();
        if (!selected)
          throw new RecruitingError(
            "VALIDATION",
            `Source ${target.sourceId} is not selected by Scout ${scout.id}`,
          );
      }
      const existing = tx
        .select()
        .from(scoutRunRequests)
        .where(
          and(
            eq(scoutRunRequests.scoutId, scout.id),
            eq(scoutRunRequests.requestKey, requestKey),
            inArray(scoutRunRequests.status, [...ACTIVE_REQUEST_STATES]),
          ),
        )
        .get();
      const at = this.now();
      if (existing) {
        const value = toRequest(existing);
        writeReceipt(tx, {
          scopeKind: "run-request",
          scopeId: command.scoutId,
          commandKind: "create",
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          status: "succeeded",
          result: JSON.stringify(value),
          errorCode: null,
          createdAt: at,
          completedAt: at,
        });
        return { value, revision: currentRevision(tx), replayed: false };
      }
      const id = randomUUID();
      tx.insert(scoutRunRequests)
        .values({
          id,
          scoutId: scout.id,
          trigger: command.trigger,
          requestKey,
          sourceId: target.sourceId,
          leadId: target.leadId,
          opportunityId: target.opportunityId,
          investigationId: target.investigationId,
          reason: command.reason?.trim() ?? "",
          budget,
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: at,
          runId: null,
          safeFailure: null,
          createdAt: at,
          dispatchedAt: null,
          completedAt: null,
        })
        .run();
      const revision = advanceRevision(tx);
      const value = toRequest(requireRequest(tx, id));
      writeReceipt(tx, {
        scopeKind: "run-request",
        scopeId: command.scoutId,
        commandKind: "create",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(value),
        errorCode: null,
        createdAt: at,
        completedAt: at,
      });
      return { value, revision, replayed: false };
    });
    if (!result.replayed)
      emitChange(result.revision, "request", [result.value.id], "run_requested", this.now());
    return result;
  }

  requestScheduledRefresh(command: RequestScheduledRefreshCommand) {
    return this.requestScoutRun({ ...command, trigger: "scheduled" });
  }

  requestSourceEvent(command: RequestSourceEventCommand) {
    return this.requestScoutRun({ ...command, trigger: "source_event" });
  }

  requestCandidateRun(command: RequestCandidateRunCommand) {
    return this.requestScoutRun({ ...command, trigger: "candidate_request" });
  }

  requestExplicitReconsideration(command: RequestExplicitReconsiderationCommand) {
    return this.requestScoutRun({ ...command, trigger: "explicit_request" });
  }

  listRunRequests(scoutId?: string): ScoutRunRequestSummaryValue[] {
    const rows = scoutId
      ? this.db
          .select()
          .from(scoutRunRequests)
          .where(eq(scoutRunRequests.scoutId, scoutId))
          .orderBy(desc(scoutRunRequests.createdAt), desc(scoutRunRequests.id))
          .all()
      : this.db
          .select()
          .from(scoutRunRequests)
          .orderBy(desc(scoutRunRequests.createdAt), desc(scoutRunRequests.id))
          .all();
    return rows.map(toRequest);
  }

  getRunRequest(id: string): ScoutRunRequestSummaryValue | null {
    const row = this.db.select().from(scoutRunRequests).where(eq(scoutRunRequests.id, id)).get();
    return row ? toRequest(row) : null;
  }

  /** Deliver each due request at most once. A Scout with an active Run is left
   * pending with bounded backoff; a disabled Source is terminally blocked. */
  processRunRequests(): ScoutRunRequestSummaryValue[] {
    const due = this.db
      .select()
      .from(scoutRunRequests)
      .where(
        and(
          inArray(scoutRunRequests.status, [...ACTIVE_REQUEST_STATES]),
          or(
            sql`${scoutRunRequests.nextAttemptAt} IS NULL`,
            lte(scoutRunRequests.nextAttemptAt, this.now()),
          ),
        ),
      )
      .orderBy(asc(scoutRunRequests.createdAt), asc(scoutRunRequests.id))
      .all();
    const delivered: ScoutRunRequestSummaryValue[] = [];
    for (const candidate of due) {
      const sourceBlock = this.sourceBlock(candidate.sourceId);
      if (sourceBlock) {
        this.updateRequest(candidate.id, {
          status: sourceBlock.terminal ? "blocked" : "pending",
          nextAttemptAt: sourceBlock.retryAt,
          safeFailure: sourceBlock.message,
          completedAt: sourceBlock.terminal ? this.now() : null,
        });
        continue;
      }
      const candidateTarget = {
        leadId: candidate.leadId ?? undefined,
        opportunityId: candidate.opportunityId ?? undefined,
        sourceId: candidate.sourceId ?? undefined,
        investigationId: candidate.investigationId ?? undefined,
      };
      if (candidate.trigger !== "explicit_request" && this.isSuppressed?.(candidateTarget)) {
        this.updateRequest(candidate.id, {
          status: "blocked",
          nextAttemptAt: null,
          safeFailure: "Candidate dismissal suppresses ordinary resurfacing",
          completedAt: this.now(),
        });
        continue;
      }
      const claimed = this.claim(candidate.id);
      if (!claimed) continue;
      try {
        const run = this.launchRun({
          scoutId: candidate.scoutId,
          trigger:
            candidate.trigger === "candidate_request"
              ? "explicit_request"
              : (candidate.trigger as LaunchScoutRunCommand["trigger"]),
          budget: parseBudget(candidate.budget),
          idempotencyKey: `run-request:${candidate.id}`,
        });
        const updated = this.updateRequest(candidate.id, {
          status: "dispatched",
          runId: run.value.id,
          nextAttemptAt: null,
          safeFailure: null,
          dispatchedAt: this.now(),
          completedAt: null,
        });
        delivered.push(updated);
        this.deliverWake(candidate.id, candidate.scoutId, run.value.id, candidate.trigger);
      } catch (error) {
        const attempts = candidate.attemptCount + 1;
        const terminal = attempts >= MAX_REQUEST_ATTEMPTS;
        this.updateRequest(candidate.id, {
          status: terminal ? "blocked" : "pending",
          attemptCount: attempts,
          nextAttemptAt: terminal ? null : this.now() + backoffMs(attempts),
          safeFailure: safeMessage(error),
          completedAt: terminal ? this.now() : null,
        });
      }
    }
    return delivered;
  }

  /** Advance due plans and create one keyed request per cadence slot. */
  processDueRevisits(): ScoutRunRequestSummaryValue[] {
    const due = this.db
      .select()
      .from(revisitPlans)
      .where(
        and(
          eq(revisitPlans.state, "active"),
          sql`${revisitPlans.cadence} IS NOT NULL`,
          lte(revisitPlans.dueAt, this.now()),
        ),
      )
      .orderBy(asc(revisitPlans.dueAt), asc(revisitPlans.id))
      .all();
    const requests: ScoutRunRequestSummaryValue[] = [];
    for (const plan of due) {
      const dueAt = plan.dueAt ?? this.now();
      const request = this.requestScoutRun({
        scoutId: plan.scoutId,
        trigger: "revisit",
        sourceId: plan.sourceId ?? undefined,
        leadId: plan.leadId ?? undefined,
        opportunityId: plan.opportunityId ?? undefined,
        investigationId: plan.investigationId ?? undefined,
        reason: `Revisit Plan ${plan.id} is due`,
        requestKey: `revisit:${plan.id}:${dueAt}`,
        idempotencyKey: `revisit:${plan.id}:${dueAt}`,
      });
      requests.push(request.value);
      const cadence = plan.cadence;
      if (cadence) {
        this.db
          .update(revisitPlans)
          .set({ dueAt: dueAt + cadenceMs(cadence), updatedAt: this.now() })
          .where(eq(revisitPlans.id, plan.id))
          .run();
      }
    }
    return requests;
  }

  getScoutRunCenter(scoutId: string): ScoutRunCenterProjectionValue {
    const runs = this.db
      .select()
      .from(scoutRuns)
      .where(eq(scoutRuns.scoutId, scoutId))
      .orderBy(desc(scoutRuns.createdAt), desc(scoutRuns.id))
      .all();
    const lastRun = runs[0] ? this.summarizeRun(runs[0].id) : null;
    const activeRun = runs.find((run) => ACTIVE_RUN_STATES.has(run.status));
    const nextPlan = this.db
      .select({ dueAt: revisitPlans.dueAt })
      .from(revisitPlans)
      .where(and(eq(revisitPlans.scoutId, scoutId), eq(revisitPlans.state, "active")))
      .orderBy(asc(sql`${revisitPlans.dueAt} IS NULL`), asc(revisitPlans.dueAt))
      .get();
    const pendingRequestCount = this.db
      .select({ id: scoutRunRequests.id })
      .from(scoutRunRequests)
      .where(
        and(
          eq(scoutRunRequests.scoutId, scoutId),
          inArray(scoutRunRequests.status, [...ACTIVE_REQUEST_STATES]),
        ),
      )
      .all().length;
    return ScoutRunCenterProjection.parse({
      scoutId,
      lastRun,
      nextRunAt: nextPlan?.dueAt ?? null,
      dueRevisitCount: this.db
        .select({ id: revisitPlans.id })
        .from(revisitPlans)
        .where(
          and(
            eq(revisitPlans.scoutId, scoutId),
            eq(revisitPlans.state, "active"),
            sql`${revisitPlans.dueAt} IS NOT NULL`,
            lte(revisitPlans.dueAt, this.now()),
          ),
        )
        .all().length,
      activeRunId: activeRun?.id ?? null,
      checkpoint: activeRun?.checkpoint ?? lastRun?.checkpoint ?? null,
      pendingRequestCount,
    });
  }

  listScoutRunCenters(): ScoutRunCenterProjectionValue[] {
    return this.db
      .select({ id: scouts.id })
      .from(scouts)
      .where(eq(scouts.lifecycleState, "active"))
      .orderBy(asc(scouts.createdAt), asc(scouts.id))
      .all()
      .map(({ id }) => this.getScoutRunCenter(id));
  }

  private claim(id: string): boolean {
    const row = this.db
      .select()
      .from(scoutRunRequests)
      .where(
        and(
          eq(scoutRunRequests.id, id),
          inArray(scoutRunRequests.status, [...ACTIVE_REQUEST_STATES]),
        ),
      )
      .get();
    if (!row || row.attemptCount >= MAX_REQUEST_ATTEMPTS) return false;
    const result = this.db
      .update(scoutRunRequests)
      .set({ status: "dispatching", attemptCount: row.attemptCount + 1 })
      .where(
        and(
          eq(scoutRunRequests.id, id),
          inArray(scoutRunRequests.status, [...ACTIVE_REQUEST_STATES]),
          eq(scoutRunRequests.attemptCount, row.attemptCount),
        ),
      )
      .run();
    return result.changes === 1;
  }

  private updateRequest(
    id: string,
    patch: Partial<typeof scoutRunRequests.$inferInsert>,
  ): ScoutRunRequestSummaryValue {
    const before = requireRequest(this.db, id);
    const changed = Object.entries(patch).some(
      ([key, value]) => (before as Record<string, unknown>)[key] !== value,
    );
    if (changed) {
      this.db.update(scoutRunRequests).set(patch).where(eq(scoutRunRequests.id, id)).run();
      advanceRevision(this.db);
    }
    const row = requireRequest(this.db, id);
    const revision = currentRevision(this.db);
    emitChange(revision, "request", [id], "run_request_changed", this.now());
    return toRequest(row);
  }

  private sourceBlock(
    sourceId: string | null,
  ): { terminal: boolean; retryAt: number | null; message: string } | null {
    if (!sourceId) return null;
    const source = this.db.select().from(sources).where(eq(sources.id, sourceId)).get();
    if (!source)
      return { terminal: true, retryAt: null, message: "The requested Source no longer exists" };
    if (source.readiness === "candidate_disabled")
      return { terminal: true, retryAt: null, message: "The Candidate disabled this Source" };
    if (source.readiness !== "ready") {
      const access = this.db
        .select({ retryAt: sourceAccess.retryAt })
        .from(sourceAccess)
        .where(eq(sourceAccess.sourceId, sourceId))
        .get();
      return {
        terminal: false,
        retryAt: access?.retryAt ?? this.now() + 60 * 60_000,
        message: `Source is ${source.readiness}; waiting for readiness`,
      };
    }
    return null;
  }

  private deliverWake(requestId: string, scoutId: string, runId: string, trigger: string): void {
    const wake = this.wake;
    if (!wake) return;
    this.db.transaction((tx) => {
      const request = tx
        .select({ id: scoutRunRequests.id })
        .from(scoutRunRequests)
        .where(wakeDeliveryWhere(requestId, runId))
        .get();
      if (!request) return;
      const scout = tx.select().from(scouts).where(eq(scouts.id, scoutId)).get();
      const agentId = scout?.legacyAgentId ?? scoutId;
      wake.enqueue(
        agentId,
        `[OpenRecruit Scout Run ${runId}] ${trigger} request accepted. Resume from the latest committed checkpoint and report a structured final outcome.`,
      );
      tx.update(scoutRunRequests)
        .set({ wakeDeliveredAt: this.now() })
        .where(wakeDeliveryWhere(requestId, runId))
        .run();
    });
  }
}

function wakeDeliveryWhere(requestId: string, runId: string) {
  return and(
    eq(scoutRunRequests.id, requestId),
    eq(scoutRunRequests.status, "dispatched"),
    eq(scoutRunRequests.runId, runId),
    isNull(scoutRunRequests.wakeDeliveredAt),
  );
}

const ACTIVE_RUN_STATES = new Set(["queued", "preflight", "running", "finalizing"]);

function targetOf(
  command: RevisitTarget,
  options: { allowNone?: boolean } = {},
): RevisitTarget & { kind: "source" | "lead" | "opportunity" | "investigation" } {
  const targets = [
    ["source", command.sourceId],
    ["lead", command.leadId],
    ["opportunity", command.opportunityId],
    ["investigation", command.investigationId],
  ] as const;
  const present = targets.filter(([, value]) => Boolean(value?.trim()));
  if (present.length === 0 && options.allowNone)
    return {
      kind: "source",
      sourceId: undefined,
      leadId: undefined,
      opportunityId: undefined,
      investigationId: undefined,
    };
  if (present.length !== 1)
    throw new RecruitingError("VALIDATION", "A Revisit Plan must target exactly one subject");
  const [kind] = present[0];
  return {
    kind,
    sourceId: command.sourceId?.trim() || undefined,
    leadId: command.leadId?.trim() || undefined,
    opportunityId: command.opportunityId?.trim() || undefined,
    investigationId: command.investigationId?.trim() || undefined,
  };
}

function validateTarget(
  db: RevisitDb,
  target: RevisitTarget & { kind?: string },
  options: { allowNone?: boolean } = {},
): void {
  if (!target.kind && options.allowNone) return;
  const checks = [
    [target.sourceId, sources, "Source"],
    [target.leadId, leads, "Lead"],
    [target.opportunityId, opportunities, "Opportunity"],
    [target.investigationId, investigations, "Investigation"],
  ] as const;
  for (const [id, table, label] of checks) {
    if (!id) continue;
    const row = db.select().from(table).where(eq(table.id, id)).get();
    if (!row) throw new RecruitingError("NOT_FOUND", `${label} ${id} was not found`);
  }
}

function normalizeCadence(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const cadence = value.trim().toUpperCase();
  if (
    !/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.test(cadence) ||
    cadence === "P" ||
    cadence === "PT"
  )
    throw new RecruitingError(
      "VALIDATION",
      "Cadence must be an ISO-8601 duration such as PT1H or P1D",
    );
  cadenceMs(cadence);
  return cadence;
}

function cadenceMs(cadence: string): number {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(cadence);
  if (!match) throw new RecruitingError("VALIDATION", `Unsupported cadence ${cadence}`);
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const result = ((days * 24 + hours) * 60 + minutes) * 60_000;
  if (result <= 0 || result > 365 * 24 * 60 * 60_000)
    throw new RecruitingError("VALIDATION", "Cadence must be between one minute and one year");
  return result;
}

function toPlan(row: typeof revisitPlans.$inferSelect): RevisitPlanSummaryValue {
  return RevisitPlanSummary.parse(row);
}

function toRequest(row: typeof scoutRunRequests.$inferSelect): ScoutRunRequestSummaryValue {
  return ScoutRunRequestSummary.parse(row);
}

function requireScout(db: RevisitDb, id: string): typeof scouts.$inferSelect {
  const row = db.select().from(scouts).where(eq(scouts.id, id)).get();
  if (!row || row.lifecycleState !== "active")
    throw new RecruitingError("NOT_FOUND", `Scout ${id} was not found`);
  return row;
}

function requirePlan(db: RevisitDb, id: string): typeof revisitPlans.$inferSelect {
  const row = db.select().from(revisitPlans).where(eq(revisitPlans.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Revisit Plan ${id} was not found`);
  return row;
}

function requireRequest(db: RevisitDb, id: string): typeof scoutRunRequests.$inferSelect {
  const row = db.select().from(scoutRunRequests).where(eq(scoutRunRequests.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Scout Run request ${id} was not found`);
  return row;
}

function currentRevision(db: RevisitDb): number {
  return db.select().from(domainClock).where(eq(domainClock.id, 1)).get()?.revision ?? 0;
}

function advanceRevision(db: RevisitDb): number {
  db.update(domainClock)
    .set({ revision: sql`${domainClock.revision} + 1` })
    .where(eq(domainClock.id, 1))
    .run();
  return currentRevision(db);
}

function receipt(
  db: RevisitDb,
  scopeKind: string,
  scopeId: string,
  commandKind: string,
  key: string,
) {
  return db
    .select({ result: commandReceipts.result, payloadHash: commandReceipts.payloadHash })
    .from(commandReceipts)
    .where(
      and(
        eq(commandReceipts.scopeKind, scopeKind),
        eq(commandReceipts.scopeId, scopeId),
        eq(commandReceipts.commandKind, commandKind),
        eq(commandReceipts.idempotencyKey, key),
      ),
    )
    .get();
}

function writeReceipt(db: RevisitDb, value: Omit<typeof commandReceipts.$inferInsert, "id">): void {
  db.insert(commandReceipts)
    .values({ id: randomUUID(), ...value })
    .run();
}

function idempotencyError(): RecruitingError {
  return new RecruitingError(
    "IDEMPOTENCY_KEY_REUSED",
    "The idempotency key was already used with a different command payload",
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emitChange(
  revision: number,
  kind: "revisit" | "request",
  ids: string[],
  reason: string,
  at: number,
): void {
  bus.emitEvent("recruiting:changed", {
    revision,
    kind: kind === "request" ? "run" : "review",
    ids,
    reason,
    at,
  });
}

function parseBudget(value: string): Partial<RunBudget> {
  try {
    const parsed = JSON.parse(value) as Partial<RunBudget>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function backoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function safeMessage(error: unknown): string {
  if (error instanceof RecruitingError) return error.message;
  return "Scout Run request could not be dispatched; it will be retried safely";
}
