import { createHash, randomUUID } from "node:crypto";
import {
  type InvestigationAttemptDecision as InvestigationAttemptDecisionValue,
  InvestigationAttemptOutcome,
  type InvestigationAttemptOutcome as InvestigationAttemptOutcomeValue,
  InvestigationAttemptSummary,
  type InvestigationAttemptSummary as InvestigationAttemptSummaryValue,
  InvestigationEvidence,
  type InvestigationEvidence as InvestigationEvidenceValue,
  InvestigationRerunReason,
  type InvestigationRerunReason as InvestigationRerunReasonValue,
  InvestigationStatus,
  InvestigationSummary,
  type InvestigationSummary as InvestigationSummaryValue,
} from "@shared/recruiting";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  commandReceipts,
  domainClock,
  investigationAttempts,
  investigations,
  leads,
  opportunities,
  profileVersions,
  scoutRuns,
  scouts,
} from "../../db/schema";
import { bus } from "../event-bus";
import { assertSafeMaterial } from "./contract";
import { RecruitingError } from "./errors";

export type CreateInvestigationCommand = {
  leadId?: string;
  opportunityId?: string;
  question: string;
  idempotencyKey: string;
};

export type InvestigationEvidenceInput =
  | string
  | {
      signalId: string;
      claim: string;
      kind?: "fact" | "inference";
      freshness?: "fresh" | "stale";
    };

export type StartInvestigationAttemptCommand = {
  investigationId: string;
  scoutId: string;
  runId?: string | null;
  profileVersionId?: string | null;
  questionSnapshot?: string;
  evidence?: InvestigationEvidenceInput[];
  conclusion?: string | null;
  uncertainty?: string | null;
  outcome?: InvestigationAttemptOutcomeValue;
  rerunReason?: InvestigationRerunReasonValue;
  strategySnapshot?: string;
  policySnapshot?: string;
  freshness?: "fresh" | "stale";
  idempotencyKey: string;
};

export type RecordInvestigationAttemptCommand = Omit<
  StartInvestigationAttemptCommand,
  "outcome"
> & {
  outcome: Exclude<InvestigationAttemptOutcomeValue, "in_progress">;
};

export type CompleteInvestigationAttemptCommand = {
  attemptId: string;
  outcome: Exclude<InvestigationAttemptOutcomeValue, "in_progress">;
  conclusion?: string | null;
  uncertainty?: string | null;
  idempotencyKey: string;
};

type CommandResult<T> = {
  value: T;
  revision: number;
  replayed: boolean;
};

export type InvestigationAttemptResult = CommandResult<InvestigationAttemptSummaryValue> & {
  decision: InvestigationAttemptDecisionValue;
};

type AttemptRow = typeof investigationAttempts.$inferSelect;
type InvestigationRow = typeof investigations.$inferSelect;
type InvestigationDb = Pick<Db, "select" | "insert" | "update" | "transaction">;

/** Host-owned shared Investigation and Attempt boundary. Questions are shared
 * across Scouts; raw provider output never enters this service or projection. */
export class InvestigationApplication {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  createInvestigation(
    command: CreateInvestigationCommand,
  ): CommandResult<InvestigationSummaryValue> {
    requireKey(command.idempotencyKey);
    const questionSnapshot = normalizeQuestionSnapshot(command.question);
    const questionKey = normalizeQuestionKey(questionSnapshot);
    const subject = normalizeSubject(command);
    const payloadHash = hashPayload({ subject, questionKey, questionSnapshot });
    let notification: { revision: number; at: number; id: string; subjectId: string } | undefined;

    const result = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        subject.kind === "lead" ? "lead" : "opportunity",
        subject.id,
        "create_investigation",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseReceipt<InvestigationSummaryValue>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }

      validateSubject(tx, subject);
      const existing = tx
        .select()
        .from(investigations)
        .where(
          subject.kind === "lead"
            ? and(
                eq(investigations.leadId, subject.id),
                eq(investigations.questionKey, questionKey),
              )
            : and(
                eq(investigations.opportunityId, subject.id),
                eq(investigations.questionKey, questionKey),
              ),
        )
        .get();
      if (existing) {
        const value = toInvestigationSummary(tx, existing);
        writeReceipt(
          tx,
          receiptFor(
            subject.kind === "lead" ? "lead" : "opportunity",
            subject.id,
            "create_investigation",
            command.idempotencyKey,
            payloadHash,
            value,
            this.now(),
          ),
        );
        return { value, revision: currentRevision(tx), replayed: true };
      }

      const at = this.now();
      const id = randomUUID();
      tx.insert(investigations)
        .values({
          id,
          leadId: subject.kind === "lead" ? subject.id : null,
          opportunityId: subject.kind === "opportunity" ? subject.id : null,
          questionKey,
          questionSnapshot,
          status: "open",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      const value = toInvestigationSummary(tx, requireInvestigation(tx, id));
      const revision = advanceRevision(tx);
      writeReceipt(
        tx,
        receiptFor(
          subject.kind === "lead" ? "lead" : "opportunity",
          subject.id,
          "create_investigation",
          command.idempotencyKey,
          payloadHash,
          value,
          at,
        ),
      );
      notification = { revision, at, id, subjectId: subject.id };
      return { value, revision, replayed: false };
    });
    if (notification) {
      emitChange(
        notification.revision,
        [notification.id, notification.subjectId],
        "investigation_created",
        notification.at,
      );
    }
    return result;
  }

  ensureInvestigation(command: CreateInvestigationCommand) {
    return this.createInvestigation(command);
  }

  getOrCreateInvestigation(command: CreateInvestigationCommand) {
    return this.createInvestigation(command);
  }

  listInvestigations(subjectId?: string): InvestigationSummaryValue[] {
    let rows = this.db
      .select()
      .from(investigations)
      .orderBy(asc(investigations.createdAt), asc(investigations.id))
      .all();
    if (subjectId) {
      rows = rows.filter((row) => row.leadId === subjectId || row.opportunityId === subjectId);
    }
    return rows.map((row) => toInvestigationSummary(this.db, row));
  }

  listInvestigationsForLead(leadId: string): InvestigationSummaryValue[] {
    const lead = this.db.select().from(leads).where(eq(leads.id, leadId)).get();
    if (!lead) return [];
    const canonicalLeadId = resolveCanonicalLeadId(this.db, lead.id);
    const opportunityIds = this.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.leadId, canonicalLeadId))
      .all()
      .map((row) => row.id);
    const rows = this.db
      .select()
      .from(investigations)
      .orderBy(asc(investigations.createdAt), asc(investigations.id))
      .all()
      .filter(
        (row) =>
          row.leadId === canonicalLeadId ||
          (row.opportunityId !== null && opportunityIds.includes(row.opportunityId)),
      );
    return rows.map((row) => toInvestigationSummary(this.db, row));
  }

  getInvestigation(id: string): InvestigationSummaryValue | null {
    const row = this.db.select().from(investigations).where(eq(investigations.id, id)).get();
    return row ? toInvestigationSummary(this.db, row) : null;
  }

  listInvestigationAttempts(investigationId: string): InvestigationAttemptSummaryValue[] {
    return this.db
      .select()
      .from(investigationAttempts)
      .where(eq(investigationAttempts.investigationId, investigationId))
      .orderBy(asc(investigationAttempts.createdAt), asc(investigationAttempts.id))
      .all()
      .map(toAttemptSummary);
  }

  getInvestigationAttempt(id: string): InvestigationAttemptSummaryValue | null {
    const row = this.db
      .select()
      .from(investigationAttempts)
      .where(eq(investigationAttempts.id, id))
      .get();
    return row ? toAttemptSummary(row) : null;
  }

  startInvestigationAttempt(command: StartInvestigationAttemptCommand): InvestigationAttemptResult {
    requireKey(command.idempotencyKey);
    const evidence = normalizeEvidence(command.evidence ?? []);
    const strategySnapshot = normalizeMaterial(
      command.strategySnapshot ?? "",
      "Discovery Strategy",
    );
    const policySnapshot = normalizeMaterial(command.policySnapshot ?? "", "Scout Policy");
    const freshness = command.freshness ?? "fresh";
    const outcome = command.outcome ?? "in_progress";
    InvestigationAttemptOutcome.parse(outcome);
    const rerunReason = command.rerunReason ?? null;
    const payloadHash = hashPayload({
      investigationId: command.investigationId,
      scoutId: command.scoutId,
      runId: command.runId ?? null,
      profileVersionId: command.profileVersionId ?? null,
      questionSnapshot: command.questionSnapshot ?? null,
      evidence,
      conclusion: command.conclusion ?? null,
      uncertainty: command.uncertainty ?? null,
      outcome,
      rerunReason,
      strategySnapshot,
      policySnapshot,
      freshness,
    });
    let notification: { revision: number; at: number; id: string } | undefined;

    const result = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "investigation",
        command.investigationId,
        "start_attempt",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        const saved = parseReceipt<InvestigationAttemptResult>(previous.result);
        return { ...saved, replayed: true };
      }

      const investigation = requireInvestigation(tx, command.investigationId);
      requireScout(tx, command.scoutId);
      if (command.runId) requireRun(tx, command.runId);
      if (command.profileVersionId) requireProfileVersion(tx, command.profileVersionId);
      if (rerunReason) InvestigationRerunReason.parse(rerunReason);
      const latest = latestAttempt(tx, investigation.id);
      const effectiveEvidence =
        command.evidence === undefined && latest ? (parseAttemptEvidence(latest) ?? []) : evidence;
      const effectiveProfileVersionId =
        command.profileVersionId === undefined
          ? (latest?.profileVersionId ?? null)
          : command.profileVersionId;
      if (effectiveProfileVersionId) requireProfileVersion(tx, effectiveProfileVersionId);
      const effectiveStrategySnapshot =
        command.strategySnapshot === undefined
          ? (latest?.strategySnapshot ?? "")
          : strategySnapshot;
      const effectivePolicySnapshot =
        command.policySnapshot === undefined ? (latest?.policySnapshot ?? "") : policySnapshot;
      const effectiveFreshness =
        command.freshness === undefined
          ? latest?.freshness === "stale"
            ? "stale"
            : "fresh"
          : freshness;
      const questionSnapshot = normalizeQuestionSnapshot(
        command.questionSnapshot ?? latest?.questionSnapshot ?? investigation.questionSnapshot,
      );
      if (normalizeQuestionKey(questionSnapshot) !== investigation.questionKey) {
        throw new RecruitingError(
          "VALIDATION",
          "An Attempt question must use the Investigation's normalized question key",
        );
      }
      const active = tx
        .select()
        .from(investigationAttempts)
        .where(
          and(
            eq(investigationAttempts.investigationId, investigation.id),
            eq(investigationAttempts.outcome, "in_progress"),
          ),
        )
        .get();
      if (active) {
        const value = toAttemptSummary(active);
        const response: InvestigationAttemptResult = {
          value,
          decision: "coalesced",
          revision: currentRevision(tx),
          replayed: false,
        };
        writeReceipt(
          tx,
          receiptFor(
            "investigation",
            investigation.id,
            "start_attempt",
            command.idempotencyKey,
            payloadHash,
            response,
            this.now(),
          ),
        );
        return response;
      }

      const sameContext =
        latest &&
        attemptContextMatches(latest, {
          questionSnapshot,
          profileVersionId: effectiveProfileVersionId,
          evidence: effectiveEvidence,
          strategySnapshot: effectiveStrategySnapshot,
          policySnapshot: effectivePolicySnapshot,
          freshness: effectiveFreshness,
        });
      if (latest && sameContext && !rerunReason) {
        const response: InvestigationAttemptResult = {
          value: toAttemptSummary(latest),
          decision: "reused",
          revision: currentRevision(tx),
          replayed: false,
        };
        writeReceipt(
          tx,
          receiptFor(
            "investigation",
            investigation.id,
            "start_attempt",
            command.idempotencyKey,
            payloadHash,
            response,
            this.now(),
          ),
        );
        return response;
      }
      if (latest && !rerunReason) {
        throw new RecruitingError(
          "CONFLICT",
          "A changed Investigation context requires evidence, Profile, policy, Freshness, or explicit-request justification",
        );
      }

      const at = this.now();
      const id = randomUUID();
      const terminal = outcome !== "in_progress";
      tx.insert(investigationAttempts)
        .values({
          id,
          investigationId: investigation.id,
          scoutId: command.scoutId,
          runId: command.runId ?? null,
          profileVersionId: effectiveProfileVersionId,
          questionSnapshot,
          evidence: JSON.stringify(effectiveEvidence),
          conclusion: cleanNarrative(command.conclusion),
          uncertainty: cleanNarrative(command.uncertainty),
          outcome,
          rerunReason,
          strategySnapshot: effectiveStrategySnapshot,
          policySnapshot: effectivePolicySnapshot,
          freshness: effectiveFreshness,
          supersedesAttemptId: latest?.id ?? null,
          completedAt: terminal ? at : null,
          createdAt: at,
        })
        .run();
      tx.update(investigations)
        .set({ revision: investigation.revision + 1, updatedAt: at })
        .where(eq(investigations.id, investigation.id))
        .run();
      const response: InvestigationAttemptResult = {
        value: toAttemptSummary(requireAttempt(tx, id)),
        decision: "started",
        revision: advanceRevision(tx),
        replayed: false,
      };
      writeReceipt(
        tx,
        receiptFor(
          "investigation",
          investigation.id,
          "start_attempt",
          command.idempotencyKey,
          payloadHash,
          response,
          at,
        ),
      );
      notification = { revision: response.revision, at, id };
      return response;
    });
    if (notification)
      emitChange(
        notification.revision,
        [notification.id, command.investigationId],
        "investigation_attempt_started",
        notification.at,
      );
    return result;
  }

  recordInvestigationAttempt(
    command: RecordInvestigationAttemptCommand,
  ): InvestigationAttemptResult {
    return this.startInvestigationAttempt(command);
  }

  completeInvestigationAttempt(
    command: CompleteInvestigationAttemptCommand,
  ): CommandResult<InvestigationAttemptSummaryValue> {
    requireKey(command.idempotencyKey);
    const outcome = command.outcome as InvestigationAttemptOutcomeValue;
    InvestigationAttemptOutcome.parse(outcome);
    if (outcome === "in_progress") {
      throw new RecruitingError(
        "VALIDATION",
        "Completing an Investigation Attempt requires a terminal outcome",
      );
    }
    const payloadHash = hashPayload({
      attemptId: command.attemptId,
      outcome,
      conclusion: command.conclusion ?? null,
      uncertainty: command.uncertainty ?? null,
    });
    let notification:
      | { revision: number; at: number; id: string; investigationId: string }
      | undefined;
    const result = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "investigation_attempt",
        command.attemptId,
        "complete",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseReceipt<InvestigationAttemptSummaryValue>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const attempt = requireAttempt(tx, command.attemptId);
      if (attempt.outcome !== "in_progress") {
        throw new RecruitingError(
          "CONFLICT",
          `Investigation Attempt ${attempt.id} is already complete`,
        );
      }
      const at = this.now();
      tx.update(investigationAttempts)
        .set({
          outcome,
          conclusion: cleanNarrative(command.conclusion),
          uncertainty: cleanNarrative(command.uncertainty),
          completedAt: at,
        })
        .where(eq(investigationAttempts.id, attempt.id))
        .run();
      const investigation = requireInvestigation(tx, attempt.investigationId);
      tx.update(investigations)
        .set({ revision: investigation.revision + 1, updatedAt: at })
        .where(eq(investigations.id, investigation.id))
        .run();
      const value = toAttemptSummary(requireAttempt(tx, attempt.id));
      const revision = advanceRevision(tx);
      writeReceipt(
        tx,
        receiptFor(
          "investigation_attempt",
          command.attemptId,
          "complete",
          command.idempotencyKey,
          payloadHash,
          value,
          at,
        ),
      );
      notification = { revision, at, id: attempt.id, investigationId: attempt.investigationId };
      return { value, revision, replayed: false };
    });
    if (notification)
      emitChange(
        notification.revision,
        [notification.id, notification.investigationId],
        "investigation_attempt_completed",
        notification.at,
      );
    return result;
  }

  /** The Lead projection includes investigations for the canonical Lead and
   * every Opportunity linked to it, without exposing provider payloads. */
  investigationsForLead(leadId: string): InvestigationSummaryValue[] {
    return this.listInvestigationsForLead(leadId);
  }
}

function normalizeSubject(command: {
  leadId?: string;
  opportunityId?: string;
}): { kind: "lead"; id: string } | { kind: "opportunity"; id: string } {
  const leadId = command.leadId?.trim() || null;
  const opportunityId = command.opportunityId?.trim() || null;
  if ((leadId ? 1 : 0) + (opportunityId ? 1 : 0) !== 1) {
    throw new RecruitingError(
      "VALIDATION",
      "An Investigation must target exactly one Lead or Opportunity",
    );
  }
  return leadId
    ? { kind: "lead", id: leadId }
    : { kind: "opportunity", id: opportunityId as string };
}

function validateSubject(
  db: InvestigationDb,
  subject: { kind: "lead" | "opportunity"; id: string },
) {
  if (subject.kind === "lead") {
    const row = db.select().from(leads).where(eq(leads.id, subject.id)).get();
    if (!row) throw new RecruitingError("NOT_FOUND", `Lead ${subject.id} was not found`);
    const canonical = resolveCanonicalLeadId(db, row.id);
    if (canonical !== subject.id) {
      throw new RecruitingError(
        "CONFLICT",
        `Lead ${subject.id} was merged into ${canonical}; use the canonical Lead`,
      );
    }
    return;
  }
  if (!db.select().from(opportunities).where(eq(opportunities.id, subject.id)).get()) {
    throw new RecruitingError("NOT_FOUND", `Opportunity ${subject.id} was not found`);
  }
}

function latestAttempt(db: InvestigationDb, investigationId: string): AttemptRow | undefined {
  return db
    .select()
    .from(investigationAttempts)
    .where(eq(investigationAttempts.investigationId, investigationId))
    .orderBy(desc(investigationAttempts.createdAt), desc(investigationAttempts.id))
    .get();
}

function attemptContextMatches(
  row: AttemptRow,
  context: {
    questionSnapshot: string;
    profileVersionId: string | null;
    evidence: InvestigationEvidenceValue[];
    strategySnapshot: string;
    policySnapshot: string;
    freshness: "fresh" | "stale";
  },
): boolean {
  const evidence = parseAttemptEvidence(row);
  if (!evidence) return false;
  return (
    hashPayload({
      questionSnapshot: row.questionSnapshot,
      profileVersionId: row.profileVersionId,
      evidence,
      strategySnapshot: row.strategySnapshot,
      policySnapshot: row.policySnapshot,
      freshness: row.freshness,
    }) === hashPayload(context)
  );
}

function parseAttemptEvidence(row: AttemptRow): InvestigationEvidenceValue[] | null {
  try {
    return InvestigationEvidence.array().parse(JSON.parse(row.evidence));
  } catch {
    return null;
  }
}

function normalizeEvidence(input: InvestigationEvidenceInput[]): InvestigationEvidenceValue[] {
  const normalized = input.map((item) =>
    typeof item === "string"
      ? {
          signalId: item.trim(),
          claim: `Signal ${item.trim()}`,
          kind: "fact" as const,
          freshness: "fresh" as const,
        }
      : {
          signalId: item.signalId.trim(),
          claim: item.claim.trim(),
          kind: item.kind ?? "fact",
          freshness: item.freshness ?? "fresh",
        },
  );
  const unique = new Map<string, InvestigationEvidenceValue>();
  for (const item of normalized) {
    const parsed = InvestigationEvidence.parse(item);
    if (!parsed.signalId || !parsed.claim)
      throw new RecruitingError("VALIDATION", "Investigation evidence needs a Signal and claim");
    unique.set(`${parsed.signalId}\0${parsed.claim}`, parsed);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.signalId}\0${a.claim}`.localeCompare(`${b.signalId}\0${b.claim}`),
  );
}

function normalizeQuestionSnapshot(question: string): string {
  const snapshot = question.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!snapshot) throw new RecruitingError("VALIDATION", "Investigation question is required");
  if (snapshot.length > 2_000)
    throw new RecruitingError("VALIDATION", "Investigation question is too long");
  return snapshot;
}

export function normalizeQuestionKey(question: string): string {
  return normalizeQuestionSnapshot(question).toLowerCase();
}

function normalizeMaterial(value: string, label: string): string {
  const material = value.normalize("NFKC").trim();
  assertSafeMaterial(material, label);
  if (material.length > 100_000) throw new RecruitingError("VALIDATION", `${label} is too long`);
  return material;
}

function cleanNarrative(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const result = value.normalize("NFKC").trim();
  if (!result) return null;
  if (result.length > 20_000)
    throw new RecruitingError("VALIDATION", "Investigation conclusion is too long");
  return result;
}

function toInvestigationSummary(
  db: InvestigationDb,
  row: InvestigationRow,
): InvestigationSummaryValue {
  const attempts = db
    .select()
    .from(investigationAttempts)
    .where(eq(investigationAttempts.investigationId, row.id))
    .orderBy(asc(investigationAttempts.createdAt), asc(investigationAttempts.id))
    .all()
    .map(toAttemptSummary);
  const conflicts = conflictingAttempts(attempts);
  return InvestigationSummary.parse({
    id: row.id,
    leadId: row.leadId,
    opportunityId: row.opportunityId,
    questionKey: row.questionKey,
    questionSnapshot: row.questionSnapshot,
    status: InvestigationStatus.parse(row.status),
    revision: row.revision,
    latestAttempt: attempts.at(-1) ?? null,
    attempts,
    conflicts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function conflictingAttempts(attempts: InvestigationAttemptSummaryValue[]): string[] {
  const concluded = attempts.filter(
    (attempt) => attempt.conclusion && attempt.outcome !== "cancelled",
  );
  const conflicts: string[] = [];
  for (let index = 1; index < concluded.length; index += 1) {
    const previous = concluded[index - 1];
    const current = concluded[index];
    if (previous && current && previous.conclusion !== current.conclusion) {
      conflicts.push(`${previous.id}:${current.id}`);
    }
  }
  return conflicts;
}

function toAttemptSummary(row: AttemptRow): InvestigationAttemptSummaryValue {
  const evidence = parseAttemptEvidence(row) ?? [];
  return InvestigationAttemptSummary.parse({
    id: row.id,
    investigationId: row.investigationId,
    scoutId: row.scoutId,
    runId: row.runId,
    questionSnapshot: row.questionSnapshot,
    evidence,
    conclusion: row.conclusion,
    uncertainty: row.uncertainty,
    outcome: InvestigationAttemptOutcome.parse(row.outcome),
    rerunReason: row.rerunReason ? InvestigationRerunReason.parse(row.rerunReason) : null,
    profileVersionId: row.profileVersionId,
    strategySnapshot: row.strategySnapshot,
    policySnapshot: row.policySnapshot,
    freshness: row.freshness === "stale" ? "stale" : "fresh",
    supersedesAttemptId: row.supersedesAttemptId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  });
}

function resolveCanonicalLeadId(db: InvestigationDb, id: string): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const row = db
      .select({ mergedInto: leads.mergedInto })
      .from(leads)
      .where(eq(leads.id, current))
      .get();
    if (!row?.mergedInto) return current;
    current = row.mergedInto;
  }
  throw new RecruitingError("CONFLICT", `Lead ${id} has a cyclic merge history`);
}

function requireInvestigation(db: InvestigationDb, id: string): InvestigationRow {
  const row = db.select().from(investigations).where(eq(investigations.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Investigation ${id} was not found`);
  return row;
}

function requireAttempt(db: InvestigationDb, id: string): AttemptRow {
  const row = db.select().from(investigationAttempts).where(eq(investigationAttempts.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Investigation Attempt ${id} was not found`);
  return row;
}

function requireScout(db: InvestigationDb, id: string): void {
  if (!db.select({ id: scouts.id }).from(scouts).where(eq(scouts.id, id)).get()) {
    throw new RecruitingError("NOT_FOUND", `Scout ${id} was not found`);
  }
}

function requireRun(db: InvestigationDb, id: string): void {
  if (!db.select({ id: scoutRuns.id }).from(scoutRuns).where(eq(scoutRuns.id, id)).get()) {
    throw new RecruitingError("NOT_FOUND", `Scout Run ${id} was not found`);
  }
}

function requireProfileVersion(db: InvestigationDb, id: string): void {
  if (
    !db
      .select({ id: profileVersions.id })
      .from(profileVersions)
      .where(eq(profileVersions.id, id))
      .get()
  ) {
    throw new RecruitingError("NOT_FOUND", `Profile Version ${id} was not found`);
  }
}

type ReceiptLookup = { result: string | null; payloadHash: string };

function findReceipt(
  db: InvestigationDb,
  scopeKind: string,
  scopeId: string,
  commandKind: string,
  idempotencyKey: string,
): ReceiptLookup | null {
  return (
    db
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
      .get() ?? null
  );
}

function assertReceiptPayload(receipt: ReceiptLookup, payloadHash: string): void {
  if (receipt.payloadHash !== payloadHash) {
    throw new RecruitingError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was already used for a different payload",
    );
  }
}

function receiptFor(
  scopeKind: string,
  scopeId: string,
  commandKind: string,
  idempotencyKey: string,
  payloadHash: string,
  value: unknown,
  at: number,
) {
  return {
    id: randomUUID(),
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

function writeReceipt(db: InvestigationDb, receipt: typeof commandReceipts.$inferInsert): void {
  db.insert(commandReceipts).values(receipt).run();
}

function advanceRevision(db: InvestigationDb): number {
  const row = db.select().from(domainClock).where(eq(domainClock.id, 1)).get();
  const revision = (row?.revision ?? 0) + 1;
  db.update(domainClock).set({ revision }).where(eq(domainClock.id, 1)).run();
  return revision;
}

function currentRevision(db: InvestigationDb): number {
  return db.select().from(domainClock).where(eq(domainClock.id, 1)).get()?.revision ?? 0;
}

function emitChange(revision: number, ids: string[], reason: string, at: number): void {
  bus.emitEvent("recruiting:changed", {
    revision,
    kind: "review",
    ids: [...new Set(ids)],
    reason,
    at,
  });
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseReceipt<T>(result: string | null): T {
  if (!result) throw new RecruitingError("CONFLICT", "Command receipt has no result");
  return JSON.parse(result) as T;
}

function requireKey(key: string): void {
  if (!key.trim()) throw new RecruitingError("VALIDATION", "Idempotency key is required");
}
