import { createHash, randomUUID } from "node:crypto";
import {
  type ScoutRunPhase as ScoutRunPhaseValue,
  ScoutRunStatus,
  type ScoutRunStatus as ScoutRunStatusValue,
  ScoutRunSummary,
  type ScoutRunSummary as ScoutRunSummaryValue,
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
  sources,
} from "../../db/schema";
import { bus } from "../event-bus";
import { assertSafeMaterial } from "./contract";
import { RecruitingError } from "./errors";

export type CreateSourceCommand = {
  kind: string;
  name: string;
  config?: Record<string, unknown>;
  idempotencyKey: string;
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

/**
 * Host-owned Source and bounded Scout Run operations. Provider adapters receive
 * only the resulting safe projections and snapshots; they never receive a Db or
 * arbitrary transport capability.
 */
export class ScoutRunApplication {
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
      const value = toSourceSummary(requireSource(tx, id));
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

  listSources(): SourceSummaryValue[] {
    return this.db
      .select()
      .from(sources)
      .orderBy(asc(sources.createdAt), asc(sources.id))
      .all()
      .map(toSourceSummary);
  }

  getSource(id: string): SourceSummaryValue | null {
    const row = this.db.select().from(sources).where(eq(sources.id, id)).get();
    return row ? toSourceSummary(row) : null;
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

function toSourceSummary(row: SourceRow): SourceSummaryValue {
  return SourceSummary.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    readiness: SourceReadiness.safeParse(row.readiness).success ? row.readiness : "not_configured",
    safeFailure: row.safeFailure,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

function requireKey(value: string): void {
  if (!value.trim()) throw new RecruitingError("VALIDATION", "Idempotency key is required");
}
