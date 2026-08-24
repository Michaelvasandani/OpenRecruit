import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  candidateDecisions,
  commandReceipts,
  domainClock,
  fitEvaluations,
  leadSignalLinks,
  leads,
  opportunities,
  signals,
} from "../../db/schema";
import { bus } from "../event-bus";
import { RecruitingError } from "./errors";

export const CANDIDATE_DECISION_KINDS = [
  "correction",
  "prohibition",
  "dismissal",
  "reversal",
  "review_outcome",
  "reconsideration",
] as const;
export type CandidateDecisionKind = (typeof CANDIDATE_DECISION_KINDS)[number];

export type CandidateDecisionDetail = Record<string, unknown>;

export type RecordCandidateDecisionCommand = {
  leadId?: string;
  opportunityId?: string;
  /** `decision` is accepted as a compatibility spelling for local adapters. */
  kind?: CandidateDecisionKind | "correct" | "dismiss" | "reverse" | "review" | "prohibit";
  decision?: CandidateDecisionKind | "correct" | "dismiss" | "reverse" | "review" | "prohibit";
  decisionKind?: CandidateDecisionKind;
  detail?: CandidateDecisionDetail;
  reason?: string;
  evidenceSignalIds?: string[];
  expectedRevision: number;
  idempotencyKey: string;
};

export type RequestCandidateReconsiderationCommand = Omit<
  RecordCandidateDecisionCommand,
  "kind" | "decision"
> & {
  evidenceSignalIds: string[];
  reason?: string;
};

export type CandidateDecisionSummary = {
  id: string;
  leadId: string | null;
  opportunityId: string | null;
  kind: CandidateDecisionKind;
  detail: CandidateDecisionDetail;
  expectedRevision: number;
  createdAt: number;
};

export type CandidateDecisionState = {
  resurfacingSuppressed: boolean;
  latestDismissalId: string | null;
  reconsiderationRequested: boolean;
  protectedCorrectionIds: string[];
  explicitProhibitionIds: string[];
};

type CandidateDb = Pick<Db, "select" | "insert" | "update">;
type DecisionRow = typeof candidateDecisions.$inferSelect;
type ReceiptLookup = { result: string | null; payloadHash: string };

/**
 * Candidate-authored review is append-only. This application is deliberately
 * independent of the Fit and Scout services: decisions are evidence about the
 * Candidate's intent, not a mutable status column on a Lead.
 */
export class CandidateDecisionApplication {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  recordCandidateDecision(command: RecordCandidateDecisionCommand): {
    value: CandidateDecisionSummary;
    revision: number;
    replayed: boolean;
  } {
    const target = subjectFor(command);
    const kind = normalizeKind(command.kind ?? command.decision ?? command.decisionKind);
    if (!kind || !CANDIDATE_DECISION_KINDS.includes(kind)) {
      throw new RecruitingError("VALIDATION", "A Candidate Decision kind is required");
    }
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new RecruitingError("VALIDATION", "Expected revision is required");
    }
    requireKey(command.idempotencyKey);
    const detail = normalizeDetail({
      ...(command.detail ?? {}),
      ...(command.reason ? { reason: command.reason } : {}),
      ...(command.evidenceSignalIds ? { evidenceSignalIds: command.evidenceSignalIds } : {}),
    });
    const payloadHash = hashPayload({
      ...target,
      kind,
      detail,
      expectedRevision: command.expectedRevision,
    });
    let notification: { revision: number; at: number; leadId: string; id: string } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        target.kind,
        target.id,
        "candidate_decision",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseResult<CandidateDecisionSummary>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }

      const subject = requireSubject(tx, target);
      if (subject.revision !== command.expectedRevision) {
        throw new RecruitingError(
          "CONFLICT",
          `${target.kind === "lead" ? "Lead" : "Opportunity"} ${target.id} is at revision ${subject.revision}; expected ${command.expectedRevision}`,
        );
      }
      validateDecision(tx, target, kind, detail, this.now());
      const at = this.now();
      const id = randomUUID();
      tx.insert(candidateDecisions)
        .values({
          id,
          leadId: target.kind === "lead" ? target.id : null,
          opportunityId: target.kind === "opportunity" ? target.id : null,
          kind,
          detail: JSON.stringify(detail),
          expectedRevision: command.expectedRevision,
          createdAt: at,
        })
        .run();
      const nextRevision = subject.revision + 1;
      if (target.kind === "lead") {
        tx.update(leads)
          .set({ revision: nextRevision, updatedAt: at })
          .where(eq(leads.id, target.id))
          .run();
      } else {
        tx.update(opportunities)
          .set({ revision: nextRevision, updatedAt: at })
          .where(eq(opportunities.id, target.id))
          .run();
      }
      const value = toSummary(tx, id);
      const revision = advanceRevision(tx);
      writeReceipt(tx, {
        scopeKind: target.kind,
        scopeId: target.id,
        commandKind: "candidate_decision",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(value),
        createdAt: at,
        completedAt: at,
      });
      notification = { revision, at, leadId: subject.leadId, id };
      return { value, revision, replayed: false };
    });
    if (notification) {
      bus.emitEvent("recruiting:changed", {
        revision: notification.revision,
        kind: "review",
        ids: [notification.leadId, notification.id],
        reason: "candidate_decision_recorded",
        at: notification.at,
      });
    }
    return outcome;
  }

  recordDecision(command: RecordCandidateDecisionCommand) {
    return this.recordCandidateDecision(command);
  }

  requestCandidateReconsideration(command: RequestCandidateReconsiderationCommand): {
    value: CandidateDecisionSummary;
    revision: number;
    replayed: boolean;
  } {
    const detail: CandidateDecisionDetail = {
      ...(command.detail ?? {}),
      reason: command.reason?.trim() || command.detail?.reason || "Strong new evidence",
      evidenceSignalIds: [
        ...new Set(command.evidenceSignalIds.map((id) => id.trim()).filter(Boolean)),
      ],
      material: "strong_new_evidence",
    };
    return this.recordCandidateDecision({ ...command, kind: "reconsideration", detail });
  }

  listCandidateDecisions(subjectId: string): CandidateDecisionSummary[] {
    const isOpportunity = this.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.id, subjectId))
      .get();
    return this.db
      .select()
      .from(candidateDecisions)
      .where(
        isOpportunity
          ? eq(candidateDecisions.opportunityId, subjectId)
          : eq(candidateDecisions.leadId, subjectId),
      )
      .orderBy(asc(candidateDecisions.createdAt), asc(candidateDecisions.id))
      .all()
      .map((row) => toSummaryRow(row))
      .sort(compareDecisions);
  }

  listDecisions(subjectId: string): CandidateDecisionSummary[] {
    const rows = this.db
      .select()
      .from(candidateDecisions)
      .where(
        // Callers asking for an Opportunity receive only exact-target history.
        eq(candidateDecisions.opportunityId, subjectId),
      )
      .orderBy(asc(candidateDecisions.createdAt), asc(candidateDecisions.id))
      .all();
    if (rows.length > 0) return rows.map((row) => toSummaryRow(row)).sort(compareDecisions);
    return this.db
      .select()
      .from(candidateDecisions)
      .where(eq(candidateDecisions.leadId, subjectId))
      .orderBy(asc(candidateDecisions.createdAt), asc(candidateDecisions.id))
      .all()
      .map((row) => toSummaryRow(row))
      .sort(compareDecisions);
  }

  listForLead(leadId: string): CandidateDecisionSummary[] {
    const opportunityIds = this.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.leadId, leadId))
      .all()
      .map((row) => row.id);
    const rows = opportunityIds.length
      ? this.db
          .select()
          .from(candidateDecisions)
          .where(inArray(candidateDecisions.opportunityId, opportunityIds))
          .all()
      : [];
    const leadRows = this.db
      .select()
      .from(candidateDecisions)
      .where(eq(candidateDecisions.leadId, leadId))
      .all();
    return [...leadRows, ...rows].map((row) => toSummaryRow(row)).sort(compareDecisions);
  }

  getCandidateDecision(id: string): CandidateDecisionSummary | null {
    const row = this.db
      .select()
      .from(candidateDecisions)
      .where(eq(candidateDecisions.id, id))
      .get();
    return row ? toSummaryRow(row) : null;
  }

  getDecisionState(subjectId: string): CandidateDecisionState {
    const rows = this.listDecisions(subjectId);
    let suppressed = false;
    let latestDismissalId: string | null = null;
    let reconsiderationRequested = false;
    const protectedCorrectionIds: string[] = [];
    const explicitProhibitionIds: string[] = [];
    for (const row of rows) {
      if (row.kind === "dismissal") {
        suppressed = row.detail.suppressesResurfacing !== false;
        latestDismissalId = row.id;
        reconsiderationRequested = false;
      } else if (row.kind === "reconsideration") {
        reconsiderationRequested = true;
      } else if (row.kind === "reversal") {
        suppressed = false;
        latestDismissalId = null;
        reconsiderationRequested = false;
      }
      if (
        (row.kind === "correction" || row.kind === "prohibition") &&
        (row.detail.protected === true ||
          row.detail.prohibition === true ||
          row.kind === "prohibition")
      ) {
        protectedCorrectionIds.push(row.id);
        if (row.kind === "prohibition" || row.detail.prohibition === true) {
          explicitProhibitionIds.push(row.id);
        }
      }
    }
    return {
      resurfacingSuppressed: suppressed,
      latestDismissalId,
      reconsiderationRequested,
      protectedCorrectionIds,
      explicitProhibitionIds,
    };
  }

  /** Used by Promotion to keep a dismissed Lead from being promoted on stale evidence. */
  requireCurrentSupportingEvidence(subjectId: string, at: number): void {
    const state = this.getDecisionState(subjectId);
    const decisions = this.listDecisions(subjectId);
    const latestReversal = [...decisions].reverse().find((row) => row.kind === "reversal");
    if (!state.resurfacingSuppressed && !latestReversal) return;
    const rows = this.db
      .select()
      .from(fitEvaluations)
      .where(
        subjectId === findLeadId(this.db, subjectId)
          ? eq(fitEvaluations.leadId, subjectId)
          : eq(fitEvaluations.opportunityId, subjectId),
      )
      .all()
      .filter((row) => row.freshness === "fresh" && row.staleAt === null && row.createdAt <= at);
    const latestDismissal = state.latestDismissalId
      ? this.getCandidateDecision(state.latestDismissalId)
      : latestReversal;
    const supported = rows.some((row) => {
      if (latestDismissal && row.createdAt <= latestDismissal.createdAt) return false;
      const detail = parseDetail(row.detail);
      const evidence = Array.isArray(detail.evidence) ? detail.evidence : [];
      return evidence.length > 0 && !hasContradictedHardConstraint(detail);
    });
    if (!supported) {
      throw new RecruitingError(
        "CONFLICT",
        "Promotion requires current supporting evidence after the Candidate dismissal",
      );
    }
  }
}

function subjectFor(command: RecordCandidateDecisionCommand): {
  kind: "lead" | "opportunity";
  id: string;
} {
  const hasLead = Boolean(command.leadId?.trim());
  const hasOpportunity = Boolean(command.opportunityId?.trim());
  if (hasLead === hasOpportunity) {
    throw new RecruitingError(
      "VALIDATION",
      "Candidate Decision must target exactly one Lead or Opportunity",
    );
  }
  return hasLead
    ? { kind: "lead", id: command.leadId as string }
    : { kind: "opportunity", id: command.opportunityId as string };
}

function normalizeKind(
  value: RecordCandidateDecisionCommand["kind"] | RecordCandidateDecisionCommand["decision"],
): CandidateDecisionKind | undefined {
  if (!value) return undefined;
  const aliases: Record<string, CandidateDecisionKind> = {
    correct: "correction",
    dismiss: "dismissal",
    reverse: "reversal",
    review: "review_outcome",
    prohibit: "prohibition",
  };
  return aliases[value] ?? value;
}

function requireSubject(
  db: CandidateDb,
  target: { kind: "lead" | "opportunity"; id: string },
): { revision: number; leadId: string } {
  if (target.kind === "lead") {
    const row = db.select().from(leads).where(eq(leads.id, target.id)).get();
    if (!row) throw new RecruitingError("NOT_FOUND", `Lead ${target.id} was not found`);
    return { revision: row.revision, leadId: row.id };
  }
  const row = db.select().from(opportunities).where(eq(opportunities.id, target.id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Opportunity ${target.id} was not found`);
  return { revision: row.revision, leadId: row.leadId };
}

function validateDecision(
  db: CandidateDb,
  target: { kind: "lead" | "opportunity"; id: string },
  kind: CandidateDecisionKind,
  detail: CandidateDecisionDetail,
  at: number,
): void {
  if (kind !== "reconsideration") return;
  const prior = db
    .select()
    .from(candidateDecisions)
    .where(
      target.kind === "lead"
        ? eq(candidateDecisions.leadId, target.id)
        : eq(candidateDecisions.opportunityId, target.id),
    )
    .all()
    .map(toSummaryRow);
  const dismissal = [...prior].reverse().find((row) => row.kind === "dismissal");
  if (!dismissal)
    throw new RecruitingError("VALIDATION", "Only a dismissed subject can be reconsidered");
  const protectedCorrection = prior.some(
    (row) =>
      (row.kind === "correction" || row.kind === "prohibition") &&
      (row.detail.protected === true ||
        row.detail.prohibition === true ||
        row.kind === "prohibition"),
  );
  if (protectedCorrection && detail.changesProtected !== true) {
    throw new RecruitingError(
      "CONFLICT",
      "Protected factual corrections and prohibitions require an explicit Candidate change",
    );
  }
  const ids = Array.isArray(detail.evidenceSignalIds)
    ? detail.evidenceSignalIds.filter((id): id is string => typeof id === "string")
    : [];
  if (ids.length === 0) {
    throw new RecruitingError("VALIDATION", "Reconsideration requires strong new evidence");
  }
  const evidence = db.select().from(signals).where(inArray(signals.id, ids)).all();
  if (
    evidence.length !== new Set(ids).size ||
    evidence.some((signal) => signal.createdAt <= dismissal.createdAt || signal.createdAt > at)
  ) {
    throw new RecruitingError(
      "CONFLICT",
      "Reconsideration evidence must be material and newer than dismissal",
    );
  }
  const targetLeadId =
    target.kind === "lead"
      ? target.id
      : db
          .select({ leadId: opportunities.leadId })
          .from(opportunities)
          .where(eq(opportunities.id, target.id))
          .get()?.leadId;
  if (!targetLeadId) throw new RecruitingError("NOT_FOUND", "Decision subject was not found");
  const linked = db
    .select({ signalId: leadSignalLinks.signalId })
    .from(leadSignalLinks)
    .where(and(eq(leadSignalLinks.leadId, targetLeadId), inArray(leadSignalLinks.signalId, ids)))
    .all();
  if (linked.length !== new Set(ids).size) {
    throw new RecruitingError(
      "VALIDATION",
      "Reconsideration evidence must support the Decision subject",
    );
  }
}

function normalizeDetail(detail: CandidateDecisionDetail | undefined): CandidateDecisionDetail {
  if (detail === undefined) return {};
  if (!detail || Array.isArray(detail) || typeof detail !== "object") {
    throw new RecruitingError("VALIDATION", "Candidate Decision detail must be an object");
  }
  return JSON.parse(JSON.stringify(detail)) as CandidateDecisionDetail;
}

function toSummary(db: CandidateDb, id: string): CandidateDecisionSummary {
  const row = db.select().from(candidateDecisions).where(eq(candidateDecisions.id, id)).get();
  if (!row) throw new RecruitingError("VALIDATION", "Candidate Decision was not persisted");
  return toSummaryRow(row);
}

function toSummaryRow(row: DecisionRow): CandidateDecisionSummary {
  return {
    id: row.id,
    leadId: row.leadId,
    opportunityId: row.opportunityId,
    kind: row.kind as CandidateDecisionKind,
    detail: parseDetail(row.detail),
    expectedRevision: row.expectedRevision ?? 0,
    createdAt: row.createdAt,
  };
}

function compareDecisions(left: CandidateDecisionSummary, right: CandidateDecisionSummary): number {
  return (
    left.createdAt - right.createdAt ||
    left.expectedRevision - right.expectedRevision ||
    left.id.localeCompare(right.id)
  );
}

function parseDetail(value: string): CandidateDecisionDetail {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CandidateDecisionDetail)
      : {};
  } catch {
    return {};
  }
}

function findLeadId(db: CandidateDb, subjectId: string): string {
  const lead = db.select({ id: leads.id }).from(leads).where(eq(leads.id, subjectId)).get();
  if (lead) return lead.id;
  const opportunity = db
    .select({ leadId: opportunities.leadId })
    .from(opportunities)
    .where(eq(opportunities.id, subjectId))
    .get();
  return opportunity?.leadId ?? "";
}

function hasContradictedHardConstraint(detail: CandidateDecisionDetail): boolean {
  const constraints = Array.isArray(detail.hardConstraints) ? detail.hardConstraints : [];
  return constraints.some(
    (item) =>
      item && typeof item === "object" && (item as { result?: unknown }).result === "contradicted",
  );
}

function requireKey(value: string): void {
  if (!value.trim()) throw new RecruitingError("VALIDATION", "Idempotency key is required");
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function findReceipt(
  db: CandidateDb,
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

function currentRevision(db: CandidateDb): number {
  return db.select().from(domainClock).where(eq(domainClock.id, 1)).get()?.revision ?? 0;
}

function advanceRevision(db: CandidateDb): number {
  const revision = currentRevision(db) + 1;
  db.insert(domainClock)
    .values({ id: 1, revision })
    .onConflictDoUpdate({ target: domainClock.id, set: { revision } })
    .run();
  return revision;
}

function writeReceipt(
  db: CandidateDb,
  value: Omit<typeof commandReceipts.$inferInsert, "id">,
): void {
  db.insert(commandReceipts)
    .values({ id: randomUUID(), ...value })
    .run();
}
