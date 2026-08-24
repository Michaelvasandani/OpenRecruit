import { createHash, randomUUID } from "node:crypto";
import {
  type EvidenceDeletionSummary,
  EvidenceInspectionSummary,
  type EvidenceInspectionSummary as EvidenceInspectionSummaryValue,
  type EvidenceScope,
  EvidenceScope as EvidenceScopeSchema,
  InvestigationEvidence,
  type SignalEvidence,
} from "@shared/recruiting";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  candidateDecisions,
  commandReceipts,
  domainClock,
  fitEvaluationSignalLinks,
  fitEvaluations,
  investigationAttempts,
  investigations,
  leadAliases,
  leadSignalLinks,
  leads,
  opportunities,
  signalAttributions,
  signals,
  sourceItems,
  sources,
} from "../../db/schema";
import { bus } from "../event-bus";
import { RecruitingError } from "./errors";

const DELETED_EVIDENCE_EXPLANATION = "Unknown: the Candidate deleted the supporting evidence.";

export type InspectEvidenceCommand = {
  scope?: EvidenceScope;
};

export type DeleteEvidenceCommand = {
  scope: EvidenceScope;
  expectedRevision?: number;
  idempotencyKey: string;
};

type EvidenceDb = Pick<Db, "select" | "insert" | "update" | "delete">;
type ReceiptLookup = { result: string | null; payloadHash: string };

/**
 * Candidate-owned evidence controls. Source Item identities are intentionally
 * retained as the smallest possible deletion marker, while Signals, raw
 * normalized content, and dependent conclusions are recalculated in one
 * transaction. Provider payloads and transcripts never enter this service.
 */
export class EvidenceApplication {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  inspectEvidence(command: InspectEvidenceCommand = {}): EvidenceInspectionSummaryValue {
    const scope = command.scope
      ? EvidenceScopeSchema.parse(command.scope)
      : ({ kind: "all" } as const);
    let rows = this.db
      .select()
      .from(signals)
      .orderBy(asc(signals.observedAt), asc(signals.id))
      .all();
    if (scope.kind === "item") {
      rows = rows.filter((row) => row.sourceItemId === scope.sourceItemId);
    } else if (scope.kind === "source") {
      rows = rows.filter((row) => row.sourceId === scope.sourceId);
    }
    const inspectedAt = this.now();
    return EvidenceInspectionSummary.parse({
      scope,
      revision: currentRevision(this.db),
      items: rows.flatMap((row) => {
        const sourceItem = this.db
          .select()
          .from(sourceItems)
          .where(eq(sourceItems.id, row.sourceItemId))
          .get();
        if (!sourceItem) return [];
        const evidence = parseEvidence(row.evidence);
        return [
          {
            sourceItemId: row.sourceItemId,
            signalId: row.id,
            sourceId: row.sourceId,
            sourceAttemptId: row.sourceAttemptId,
            canonicalUrl: sourceItem.canonicalUrl,
            providerIdentity: sourceItem.providerIdentity,
            fingerprint: row.fingerprint,
            evidence,
            retentionUntil: row.retentionUntil,
            retentionState:
              row.retentionUntil !== null && row.retentionUntil <= inspectedAt
                ? "expired"
                : "retained",
            observedAt: row.observedAt,
            createdAt: row.createdAt,
          },
        ];
      }),
      rawCapturesRetained: false,
      providerTranscriptsRetained: false,
    });
  }

  listEvidence(command: InspectEvidenceCommand = {}) {
    return this.inspectEvidence(command);
  }

  deleteEvidence(command: DeleteEvidenceCommand): {
    value: EvidenceDeletionSummary;
    revision: number;
    replayed: boolean;
  } {
    const scope = EvidenceScopeSchema.parse(command.scope);
    requireKey(command.idempotencyKey);
    if (
      command.expectedRevision !== undefined &&
      (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0)
    ) {
      throw new RecruitingError("VALIDATION", "Expected revision must be a non-negative integer");
    }
    const payloadHash = hashPayload({
      scope,
      expectedRevision: command.expectedRevision ?? null,
    });
    let notification: { revision: number; at: number; ids: string[] } | undefined;
    const outcome = this.db.transaction((tx) => {
      const scopeId = scopeIdFor(scope);
      const previous = findReceipt(tx, "evidence", scopeId, "delete", command.idempotencyKey);
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseResult<EvidenceDeletionSummary>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }

      const revisionBefore = currentRevision(tx);
      if (command.expectedRevision !== undefined && command.expectedRevision !== revisionBefore) {
        throw new RecruitingError(
          "CONFLICT",
          `Evidence projection is at revision ${revisionBefore}; expected ${command.expectedRevision}`,
        );
      }
      if (scope.kind === "source") {
        const source = tx.select().from(sources).where(eq(sources.id, scope.sourceId)).get();
        if (!source)
          throw new RecruitingError("NOT_FOUND", `Source ${scope.sourceId} was not found`);
      }
      if (scope.kind === "item") {
        const sourceItem = tx
          .select()
          .from(sourceItems)
          .where(eq(sourceItems.id, scope.sourceItemId))
          .get();
        if (!sourceItem) {
          throw new RecruitingError("NOT_FOUND", `Source Item ${scope.sourceItemId} was not found`);
        }
      }

      const scopedSourceItems = sourceItemsForScope(tx, scope);
      const sourceItemIds = scopedSourceItems.map((row) => row.id);
      const scopedSignals = signalsForScope(tx, scope, sourceItemIds);
      const deletedSignalIds = scopedSignals.map((row) => row.id);
      const deletedSignalSet = new Set(deletedSignalIds);
      const affectedLeadIds = unique(
        deletedSignalIds.length
          ? tx
              .select({ leadId: leadSignalLinks.leadId })
              .from(leadSignalLinks)
              .where(inArray(leadSignalLinks.signalId, deletedSignalIds))
              .all()
              .map((row) => row.leadId)
          : [],
      );
      const affectedOpportunityIds = unique(
        affectedLeadIds.length
          ? tx
              .select({ id: opportunities.id })
              .from(opportunities)
              .where(inArray(opportunities.leadId, affectedLeadIds))
              .all()
              .map((row) => row.id)
          : [],
      );
      const affectedFitEvaluationIds = unique(
        deletedSignalIds.length
          ? tx
              .select({ evaluationId: fitEvaluationSignalLinks.evaluationId })
              .from(fitEvaluationSignalLinks)
              .where(inArray(fitEvaluationSignalLinks.signalId, deletedSignalIds))
              .all()
              .map((row) => row.evaluationId)
          : [],
      );
      const allAttempts = tx.select().from(investigationAttempts).all();
      const affectedInvestigationIds = unique(
        allAttempts
          .filter((attempt) => {
            if (deletedSignalSet.size === 0) return false;
            const evidence = parseInvestigationEvidence(attempt.evidence);
            return (
              evidence.some((item) => deletedSignalSet.has(item.signalId)) ||
              affectedLeadIds.includes(
                tx
                  .select({ leadId: investigations.leadId })
                  .from(investigations)
                  .where(eq(investigations.id, attempt.investigationId))
                  .get()?.leadId ?? "",
              ) ||
              affectedOpportunityIds.includes(
                tx
                  .select({ opportunityId: investigations.opportunityId })
                  .from(investigations)
                  .where(eq(investigations.id, attempt.investigationId))
                  .get()?.opportunityId ?? "",
              )
            );
          })
          .map((attempt) => attempt.investigationId),
      );
      const at = this.now();

      for (const sourceItem of scopedSourceItems) {
        const latestSignal = scopedSignals
          .filter((signal) => signal.sourceItemId === sourceItem.id)
          .sort(
            (left, right) => right.observedAt - left.observedAt || right.id.localeCompare(left.id),
          )[0];
        tx.update(sourceItems)
          .set({
            // latestFingerprint is retained as the marker's fingerprint. A
            // future materially changed observation clears the marker.
            latestFingerprint: sourceItem.latestFingerprint ?? latestSignal?.fingerprint ?? null,
            latestSignalId: null,
            deletionMarkerAt: at,
            updatedAt: at,
          })
          .where(eq(sourceItems.id, sourceItem.id))
          .run();
      }

      for (const evaluationId of affectedFitEvaluationIds) {
        const evaluation = tx
          .select()
          .from(fitEvaluations)
          .where(eq(fitEvaluations.id, evaluationId))
          .get();
        if (!evaluation) continue;
        const detail = recalculateFitDetail(evaluation.detail, deletedSignalSet);
        tx.update(fitEvaluations)
          .set({
            detail: JSON.stringify(detail),
            freshness: "stale",
            staleReason: "evidence_deleted",
            staleAt: at,
          })
          .where(eq(fitEvaluations.id, evaluationId))
          .run();
      }

      for (const attempt of allAttempts) {
        const detail = recalculateInvestigationAttempt(
          attempt.evidence,
          attempt.conclusion,
          deletedSignalSet,
        );
        if (!detail.changed) continue;
        tx.update(investigationAttempts)
          .set({
            evidence: JSON.stringify(detail.evidence),
            conclusion: detail.conclusion,
            uncertainty: detail.uncertainty,
            outcome: detail.outcome,
            freshness: "stale",
          })
          .where(eq(investigationAttempts.id, attempt.id))
          .run();
        tx.update(investigations)
          .set({ revision: revisionBefore + 1, updatedAt: at })
          .where(eq(investigations.id, attempt.investigationId))
          .run();
      }

      // Candidate-authored decisions survive. Any evidence references inside
      // their detail are removed so preserving the decision cannot disclose the
      // deleted Signal or its content.
      const decisions = tx.select().from(candidateDecisions).all();
      for (const decision of decisions) {
        const detail = redactDeletedEvidence(parseObject(decision.detail), deletedSignalSet);
        if (JSON.stringify(detail) !== decision.detail) {
          tx.update(candidateDecisions)
            .set({ detail: JSON.stringify(detail) })
            .where(eq(candidateDecisions.id, decision.id))
            .run();
        }
      }

      if (deletedSignalIds.length > 0) {
        tx.delete(fitEvaluationSignalLinks)
          .where(inArray(fitEvaluationSignalLinks.signalId, deletedSignalIds))
          .run();
        tx.delete(leadSignalLinks).where(inArray(leadSignalLinks.signalId, deletedSignalIds)).run();
        tx.delete(signalAttributions)
          .where(inArray(signalAttributions.signalId, deletedSignalIds))
          .run();
        tx.delete(signals).where(inArray(signals.id, deletedSignalIds)).run();
      }

      for (const leadId of affectedLeadIds) recalculateLead(tx, leadId, at);
      for (const opportunityId of affectedOpportunityIds) {
        const opportunity = tx
          .select()
          .from(opportunities)
          .where(eq(opportunities.id, opportunityId))
          .get();
        if (!opportunity) continue;
        const supported = tx
          .select({ signalId: leadSignalLinks.signalId })
          .from(leadSignalLinks)
          .where(eq(leadSignalLinks.leadId, opportunity.leadId))
          .limit(1)
          .get();
        if (!supported) {
          tx.update(opportunities)
            .set({
              title: "Evidence deleted",
              state: "unknown",
              revision: opportunity.revision + 1,
              updatedAt: at,
            })
            .where(eq(opportunities.id, opportunityId))
            .run();
        }
      }

      const revision = advanceRevision(tx);
      const value = {
        scope,
        deletedSignalIds,
        affectedSourceItemIds: sourceItemIds,
        affectedLeadIds,
        affectedOpportunityIds,
        affectedInvestigationIds,
        affectedFitEvaluationIds,
        revision,
      } satisfies EvidenceDeletionSummary;
      writeReceipt(tx, {
        id: randomUUID(),
        scopeKind: "evidence",
        scopeId,
        commandKind: "delete",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(value),
        createdAt: at,
        completedAt: at,
      });
      notification = {
        revision,
        at,
        ids: [...deletedSignalIds, ...affectedLeadIds, ...affectedFitEvaluationIds],
      };
      return { value, revision, replayed: false };
    });
    if (notification) {
      bus.emitEvent("recruiting:changed", {
        revision: notification.revision,
        kind: "review",
        ids: unique(notification.ids),
        reason: "evidence_deleted",
        at: notification.at,
      });
    }
    return outcome;
  }

  removeEvidence(command: DeleteEvidenceCommand) {
    return this.deleteEvidence(command);
  }
}

function sourceItemsForScope(db: EvidenceDb, scope: EvidenceScope) {
  if (scope.kind === "item") {
    return db.select().from(sourceItems).where(eq(sourceItems.id, scope.sourceItemId)).all();
  }
  if (scope.kind === "source") {
    return db.select().from(sourceItems).where(eq(sourceItems.sourceId, scope.sourceId)).all();
  }
  return db.select().from(sourceItems).all();
}

function signalsForScope(db: EvidenceDb, scope: EvidenceScope, sourceItemIds: string[]) {
  if (scope.kind === "source") {
    return db.select().from(signals).where(eq(signals.sourceId, scope.sourceId)).all();
  }
  if (sourceItemIds.length === 0) return [];
  return db.select().from(signals).where(inArray(signals.sourceItemId, sourceItemIds)).all();
}

function recalculateLead(db: EvidenceDb, leadId: string, at: number): void {
  const row = db.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!row) return;
  const latest = db
    .select({ signal: signals, linkCreatedAt: leadSignalLinks.createdAt })
    .from(leadSignalLinks)
    .innerJoin(signals, eq(signals.id, leadSignalLinks.signalId))
    .where(eq(leadSignalLinks.leadId, leadId))
    .orderBy(desc(signals.observedAt), desc(signals.id))
    .get();
  if (!latest) {
    db.delete(leadAliases).where(eq(leadAliases.leadId, leadId)).run();
    db.update(leads)
      .set({
        title: "Evidence deleted",
        summary: null,
        identityState: "settled",
        conflict: null,
        revision: row.revision + 1,
        updatedAt: at,
      })
      .where(eq(leads.id, leadId))
      .run();
    return;
  }
  const evidence = parseEvidence(latest.signal.evidence);
  db.update(leads)
    .set({
      title: evidence.title || row.title,
      summary: evidence.content || null,
      revision: row.revision + 1,
      updatedAt: at,
    })
    .where(eq(leads.id, leadId))
    .run();
}

function recalculateFitDetail(value: string, deleted: Set<string>): Record<string, unknown> {
  const detail = parseObject(value);
  const rewrite = (items: unknown): unknown[] => {
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const candidate = item as Record<string, unknown>;
      const ids = arrayOfStrings(candidate.signalIds);
      const remaining = ids.filter((id) => !deleted.has(id));
      if (ids.some((id) => deleted.has(id))) {
        return {
          ...candidate,
          signalIds: remaining,
          result: remaining.length > 0 ? candidate.result : "unknown",
          explanation:
            remaining.length > 0
              ? "Conclusion recalculated from independently supported evidence."
              : DELETED_EVIDENCE_EXPLANATION,
          evidenceFreshness: "stale",
        };
      }
      return candidate;
    });
  };
  const evidence = Array.isArray(detail.evidence)
    ? detail.evidence.filter(
        (item) =>
          Boolean(item) &&
          typeof item === "object" &&
          !deleted.has(String((item as Record<string, unknown>).signalId ?? "")),
      )
    : [];
  const next: Record<string, unknown> = {
    ...detail,
    hardConstraints: rewrite(detail.hardConstraints),
    preferences: rewrite(detail.preferences),
    evidence,
  };
  const unknowns = arrayOfStrings(detail.unknowns);
  next.unknowns = unique([...unknowns, DELETED_EVIDENCE_EXPLANATION]);
  next.freshness = "stale";
  next.nextReconsiderationAt = detail.nextReconsiderationAt ?? null;
  return next;
}

function recalculateInvestigationAttempt(
  value: string,
  conclusion: string | null,
  deleted: Set<string>,
): {
  changed: boolean;
  evidence: unknown[];
  conclusion: string | null;
  uncertainty: string | null;
  outcome: string;
} {
  const parsed = parseInvestigationEvidence(value);
  const evidence = parsed.filter((item) => !deleted.has(item.signalId));
  if (evidence.length === parsed.length) {
    return {
      changed: false,
      evidence: parsed,
      conclusion,
      uncertainty: null,
      outcome: "unknown",
    };
  }
  return {
    changed: true,
    evidence,
    conclusion: evidence.length > 0 ? conclusion : null,
    uncertainty:
      evidence.length > 0
        ? "Recalculated after Candidate evidence deletion."
        : DELETED_EVIDENCE_EXPLANATION,
    outcome: evidence.length > 0 ? "succeeded" : "unknown",
  };
}

function redactDeletedEvidence(
  value: Record<string, unknown>,
  deleted: Set<string>,
): Record<string, unknown> {
  const visit = (current: unknown, key?: string): unknown => {
    if (Array.isArray(current)) {
      const values = current
        .filter((item) => !(typeof item === "string" && deleted.has(item)))
        .map((item) => visit(item, key));
      return values;
    }
    if (current && typeof current === "object") {
      const next: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(current)) {
        next[childKey] = visit(childValue, childKey);
      }
      return next;
    }
    if (typeof current === "string" && deleted.has(current)) return undefined;
    return current;
  };
  return visit(value) as Record<string, unknown>;
}

function parseEvidence(value: string): SignalEvidence {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyEvidence();
    const candidate = parsed as Record<string, unknown>;
    return {
      title: typeof candidate.title === "string" ? candidate.title : "",
      content: typeof candidate.content === "string" ? candidate.content : "",
      canonicalUrl: typeof candidate.canonicalUrl === "string" ? candidate.canonicalUrl : null,
      providerIdentity:
        typeof candidate.providerIdentity === "string" ? candidate.providerIdentity : null,
      sourceIdentity:
        typeof candidate.sourceIdentity === "string" ? candidate.sourceIdentity : null,
      author:
        candidate.author && typeof candidate.author === "object"
          ? (candidate.author as SignalEvidence["author"])
          : null,
      editHistory: Array.isArray(candidate.editHistory)
        ? candidate.editHistory.filter((item): item is string => typeof item === "string")
        : undefined,
      withheld: candidate.withheld ?? null,
      protected: candidate.protected === true,
    };
  } catch {
    return emptyEvidence();
  }
}

function emptyEvidence(): SignalEvidence {
  return {
    title: "",
    content: "",
    canonicalUrl: null,
    providerIdentity: null,
    sourceIdentity: null,
  };
}

function parseInvestigationEvidence(
  value: string,
): Array<{ signalId: string; [key: string]: unknown }> {
  try {
    const parsed = InvestigationEvidence.array().parse(JSON.parse(value));
    return parsed as Array<{ signalId: string; [key: string]: unknown }>;
  } catch {
    return [];
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function scopeIdFor(scope: EvidenceScope): string {
  if (scope.kind === "item") return `item:${scope.sourceItemId}`;
  if (scope.kind === "source") return `source:${scope.sourceId}`;
  return "all";
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function requireKey(value: string): void {
  if (!value.trim()) throw new RecruitingError("VALIDATION", "Idempotency key is required");
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function currentRevision(db: EvidenceDb): number {
  return (
    db
      .select({ revision: domainClock.revision })
      .from(domainClock)
      .where(eq(domainClock.id, 1))
      .get()?.revision ?? 0
  );
}

function advanceRevision(db: EvidenceDb): number {
  const revision = currentRevision(db) + 1;
  db.update(domainClock).set({ revision }).where(eq(domainClock.id, 1)).run();
  return revision;
}

function findReceipt(
  db: EvidenceDb,
  scopeKind: string,
  scopeId: string,
  commandKind: string,
  idempotencyKey: string,
): ReceiptLookup | undefined {
  const row = db
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
  return row ?? undefined;
}

function assertReceiptPayload(receipt: ReceiptLookup, payloadHash: string): void {
  if (receipt.payloadHash !== payloadHash) {
    throw new RecruitingError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was reused with a different payload",
    );
  }
}

function parseResult<T>(value: string | null): T {
  if (!value) throw new RecruitingError("CONFLICT", "Command receipt has no result");
  return JSON.parse(value) as T;
}

function writeReceipt(db: EvidenceDb, value: typeof commandReceipts.$inferInsert): void {
  db.insert(commandReceipts).values(value).run();
}
