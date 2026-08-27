import { createHash, randomUUID } from "node:crypto";
import {
  type FitConstraintConclusion,
  FitEvaluationResult,
  type FitEvaluationSummary,
  FitEvidenceCitation,
  type OpportunitySummary,
} from "@shared/recruiting";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  commandReceipts,
  domainClock,
  fitEvaluationSignalLinks,
  fitEvaluations,
  leads,
  opportunities,
  profileVersions,
  scoutRuns,
  signalAttributions,
  signals,
} from "../../db/schema";
import { bus } from "../event-bus";
import { RecruitingError } from "./errors";

export type FitConclusionInput = {
  key: string;
  result: FitEvaluationSummary["hardConstraints"][number]["result"];
  explanation: string;
  signalIds?: string[];
  inferred?: boolean;
  evidenceFreshness?: "fresh" | "stale";
};

export type FitEvidenceInput = {
  signalId: string;
  claim: string;
  kind: "fact" | "inference";
  freshness?: "fresh" | "stale";
};

export type CreateFitEvaluationCommand = {
  leadId?: string;
  opportunityId?: string;
  profileVersionId: string;
  runId: string;
  hardConstraints: FitConclusionInput[];
  preferences: FitConclusionInput[];
  evidence?: FitEvidenceInput[];
  conflicts?: string[];
  unknowns?: string[];
  freshness?: "fresh" | "stale";
  nextReconsiderationAt?: number | null;
  idempotencyKey: string;
};

export type PromoteLeadCommand = {
  leadId: string;
  title?: string;
  opportunityId?: string | null;
  expectedRevision?: number;
  idempotencyKey: string;
};

type FitDb = Pick<Db, "select" | "insert" | "update">;
type FitRow = typeof fitEvaluations.$inferSelect;
type OpportunityRow = typeof opportunities.$inferSelect;
type ReceiptLookup = { result: string | null; payloadHash: string };

/**
 * Host-owned transparent evaluation and Promotion boundary. Evaluations are
 * append-only evidence records; only the freshness marker may be updated when
 * a later Profile Version invalidates a current evaluation.
 */
export class FitEvaluationApplication {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly candidateDecisionGuard?: (subjectId: string, at: number) => void,
  ) {}

  createFitEvaluation(command: CreateFitEvaluationCommand): FitEvaluationSummary {
    requireKey(command.idempotencyKey);
    const subject = subjectFor(command);
    const hardConstraints = normalizeConclusions(command.hardConstraints);
    const preferences = normalizeConclusions(command.preferences);
    const evidence = normalizeEvidence(command.evidence ?? []);
    const payloadHash = hashPayload({
      ...command,
      hardConstraints,
      preferences,
      evidence,
      conflicts: command.conflicts ?? [],
      unknowns: command.unknowns ?? [],
      freshness: command.freshness ?? "fresh",
      nextReconsiderationAt: command.nextReconsiderationAt ?? null,
    });
    let notification: { revision: number; at: number; id: string } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "fit_evaluation",
        subject.id,
        "create",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return parseResult<FitEvaluationSummary>(previous.result);
      }

      const profile = tx
        .select()
        .from(profileVersions)
        .where(eq(profileVersions.id, command.profileVersionId))
        .get();
      if (!profile) {
        throw new RecruitingError(
          "NOT_FOUND",
          `Profile Version ${command.profileVersionId} was not found`,
        );
      }
      const run = tx.select().from(scoutRuns).where(eq(scoutRuns.id, command.runId)).get();
      if (!run) throw new RecruitingError("NOT_FOUND", `Scout Run ${command.runId} was not found`);
      if (run.profileVersionId !== command.profileVersionId) {
        throw new RecruitingError(
          "CONFLICT",
          "Fit Evaluation must use the Profile Version pinned by its Scout Run",
        );
      }
      if (subject.kind === "lead") {
        if (!tx.select().from(leads).where(eq(leads.id, subject.id)).get()) {
          throw new RecruitingError("NOT_FOUND", `Lead ${subject.id} was not found`);
        }
      } else if (!tx.select().from(opportunities).where(eq(opportunities.id, subject.id)).get()) {
        throw new RecruitingError("NOT_FOUND", `Opportunity ${subject.id} was not found`);
      }

      const allSignalIds = new Set<string>(evidence.map((item) => item.signalId));
      for (const item of [...hardConstraints, ...preferences]) {
        for (const signalId of item.signalIds) allSignalIds.add(signalId);
      }
      const citedSignals = allSignalIds.size
        ? tx
            .select()
            .from(signals)
            .where(inArray(signals.id, [...allSignalIds]))
            .all()
        : [];
      if (citedSignals.length !== allSignalIds.size) {
        const found = new Set(citedSignals.map((signal) => signal.id));
        const missing = [...allSignalIds].find((id) => !found.has(id));
        throw new RecruitingError("NOT_FOUND", `Signal ${missing} was not found`);
      }
      const attributedSignalIds = new Set(
        citedSignals.length
          ? tx
              .select({ signalId: signalAttributions.signalId })
              .from(signalAttributions)
              .where(inArray(signalAttributions.signalId, [...allSignalIds]))
              .all()
              .map((row) => row.signalId)
          : [],
      );
      const unattributed = [...allSignalIds].find((id) => !attributedSignalIds.has(id));
      if (unattributed) {
        throw new RecruitingError(
          "VALIDATION",
          `Signal ${unattributed} has no attributable Scout Run evidence`,
        );
      }
      const at = this.now();
      const expiredSignalIds = new Set(
        citedSignals
          .filter((signal) => signal.retentionUntil !== null && signal.retentionUntil <= at)
          .map((signal) => signal.id),
      );
      const staleEvidence = new Set(
        evidence
          .filter((item) => item.freshness === "stale" || expiredSignalIds.has(item.signalId))
          .map((item) => item.signalId),
      );
      for (const [category, conclusions] of [
        ["Hard Constraint", hardConstraints],
        ["Preference", preferences],
      ] as const) {
        for (const item of conclusions) {
          if (
            ["satisfied", "contradicted", "conflicted"].includes(item.result) &&
            item.signalIds.length === 0
          ) {
            throw new RecruitingError(
              "VALIDATION",
              `${category} ${item.key} needs attributable Signal evidence`,
            );
          }
        }
      }
      for (const item of hardConstraints) {
        if (
          item.result === "satisfied" &&
          (command.freshness === "stale" ||
            item.evidenceFreshness === "stale" ||
            item.signalIds.some((id) => staleEvidence.has(id) || expiredSignalIds.has(id)))
        ) {
          throw new RecruitingError(
            "VALIDATION",
            `Hard Constraint ${item.key} cannot be satisfied by stale evidence`,
          );
        }
      }

      const effectiveHardConstraints = hardConstraints.map((item) =>
        item.signalIds.some((id) => expiredSignalIds.has(id))
          ? { ...item, evidenceFreshness: "stale" as const }
          : item,
      );
      const effectivePreferences = preferences.map((item) =>
        item.signalIds.some((id) => expiredSignalIds.has(id))
          ? { ...item, evidenceFreshness: "stale" as const }
          : item,
      );
      const effectiveEvidence = evidence.map((item) =>
        expiredSignalIds.has(item.signalId) ? { ...item, freshness: "stale" as const } : item,
      );
      const evaluationFreshness =
        command.freshness === "stale" || expiredSignalIds.size > 0 ? "stale" : "fresh";
      const detail = {
        hardConstraints: effectiveHardConstraints,
        preferences: effectivePreferences,
        evidence: effectiveEvidence.map((item) => withAttribution(tx, item, citedSignals)),
        conflicts: uniqueStrings(command.conflicts ?? []),
        unknowns: uniqueStrings(command.unknowns ?? []),
        freshness: evaluationFreshness,
        nextReconsiderationAt: command.nextReconsiderationAt ?? null,
        strategyMaterial: run.strategySnapshot ?? "",
        policyMaterial: run.policySnapshot ?? "",
        currentProfileVersionId: command.profileVersionId,
      };
      const strategyHash = hashMaterial(run.strategySnapshot);
      const policyHash = hashMaterial(run.policySnapshot);
      const id = randomUUID();
      tx.insert(fitEvaluations)
        .values({
          id,
          leadId: subject.kind === "lead" ? subject.id : null,
          opportunityId: subject.kind === "opportunity" ? subject.id : null,
          profileVersionId: command.profileVersionId,
          runId: command.runId,
          strategyHash,
          policyHash,
          detail: JSON.stringify(detail),
          freshness: detail.freshness,
          staleReason: evaluationFreshness === "stale" ? "evidence_stale" : null,
          staleAt: evaluationFreshness === "stale" ? at : null,
          createdAt: at,
        })
        .run();
      for (const signalId of allSignalIds) {
        tx.insert(fitEvaluationSignalLinks).values({ evaluationId: id, signalId }).run();
      }
      const value = toFitSummary(requireFit(tx, id));
      const revision = advanceRevision(tx);
      writeReceipt(
        tx,
        receiptFor(
          "fit_evaluation",
          subject.id,
          "create",
          command.idempotencyKey,
          payloadHash,
          value,
          at,
        ),
      );
      notification = { revision, at, id };
      return value;
    });
    if (notification) {
      bus.emitEvent("recruiting:changed", {
        revision: notification.revision,
        kind: "review",
        ids: [notification.id],
        reason: "fit_evaluation_created",
        at: notification.at,
      });
    }
    return outcome;
  }

  /** Alias kept explicit for adapters that describe this command as evaluation. */
  evaluateFit(command: CreateFitEvaluationCommand): FitEvaluationSummary {
    return this.createFitEvaluation(command);
  }

  listFitEvaluations(subjectId?: string): FitEvaluationSummary[] {
    let rows = this.db
      .select()
      .from(fitEvaluations)
      .orderBy(desc(fitEvaluations.createdAt), asc(fitEvaluations.id))
      .all();
    if (subjectId)
      rows = rows.filter((row) => row.leadId === subjectId || row.opportunityId === subjectId);
    return rows.map((row) => toFitSummary(row, this.db, this.now()));
  }

  getFitEvaluation(id: string): FitEvaluationSummary | null {
    const row = this.db.select().from(fitEvaluations).where(eq(fitEvaluations.id, id)).get();
    return row ? toFitSummary(row, this.db, this.now()) : null;
  }

  listOpportunities(leadId?: string): OpportunitySummary[] {
    let rows = this.db
      .select()
      .from(opportunities)
      .orderBy(asc(opportunities.createdAt), asc(opportunities.id))
      .all();
    if (leadId) rows = rows.filter((row) => row.leadId === leadId);
    return rows.map(toOpportunitySummary);
  }

  getOpportunity(id: string): OpportunitySummary | null {
    const row = this.db.select().from(opportunities).where(eq(opportunities.id, id)).get();
    return row ? toOpportunitySummary(row) : null;
  }

  promoteLead(command: PromoteLeadCommand): {
    value: OpportunitySummary;
    revision: number;
    replayed: boolean;
  } {
    requireKey(command.idempotencyKey);
    const title = command.title?.trim() ?? "";
    const payloadHash = hashPayload({
      leadId: command.leadId,
      title,
      opportunityId: command.opportunityId ?? null,
      expectedRevision: command.expectedRevision ?? null,
    });
    let notification: { revision: number; at: number; id: string } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(tx, "lead", command.leadId, "promote", command.idempotencyKey);
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        return {
          value: parseResult<OpportunitySummary>(previous.result),
          revision: currentRevision(tx),
          replayed: true,
        };
      }
      const lead = tx.select().from(leads).where(eq(leads.id, command.leadId)).get();
      if (!lead) throw new RecruitingError("NOT_FOUND", `Lead ${command.leadId} was not found`);
      const opportunityTitle = title || lead.title;
      if (command.expectedRevision !== undefined && command.expectedRevision !== lead.revision) {
        throw new RecruitingError(
          "CONFLICT",
          `Lead ${command.leadId} is at revision ${lead.revision}; expected ${command.expectedRevision}`,
        );
      }
      const at = this.now();
      this.candidateDecisionGuard?.(command.leadId, at);
      let row: OpportunityRow | undefined;
      if (command.opportunityId) {
        row = tx
          .select()
          .from(opportunities)
          .where(eq(opportunities.id, command.opportunityId))
          .get();
        if (!row || row.leadId !== command.leadId) {
          throw new RecruitingError("VALIDATION", "Opportunity must belong to the promoted Lead");
        }
      } else {
        const id = randomUUID();
        tx.insert(opportunities)
          .values({
            id,
            leadId: command.leadId,
            title: opportunityTitle,
            state: "active",
            revision: 0,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        row = tx.select().from(opportunities).where(eq(opportunities.id, id)).get();
      }
      if (!row) throw new RecruitingError("VALIDATION", "Opportunity could not be created");
      tx.update(leads)
        .set({ revision: lead.revision + 1, updatedAt: at })
        .where(eq(leads.id, lead.id))
        .run();
      const value = toOpportunitySummary(row);
      const revision = advanceRevision(tx);
      writeReceipt(
        tx,
        receiptFor(
          "lead",
          command.leadId,
          "promote",
          command.idempotencyKey,
          payloadHash,
          value,
          at,
        ),
      );
      notification = { revision, at, id: row.id };
      return { value, revision, replayed: false };
    });
    if (notification) {
      bus.emitEvent("recruiting:changed", {
        revision: notification.revision,
        kind: "lead",
        ids: [command.leadId, notification.id],
        reason: "lead_promoted",
        at: notification.at,
      });
    }
    return outcome;
  }
}

function subjectFor(command: CreateFitEvaluationCommand): {
  kind: "lead" | "opportunity";
  id: string;
} {
  const hasLead = Boolean(command.leadId);
  const hasOpportunity = Boolean(command.opportunityId);
  if (hasLead === hasOpportunity) {
    throw new RecruitingError(
      "VALIDATION",
      "Fit Evaluation must target exactly one Lead or Opportunity",
    );
  }
  return hasLead
    ? { kind: "lead", id: command.leadId as string }
    : { kind: "opportunity", id: command.opportunityId as string };
}

function normalizeConclusions(items: FitConclusionInput[]): FitConstraintConclusion[] {
  return items.map((item) => ({
    key: item.key.trim(),
    result: FitEvaluationResult.parse(item.result),
    explanation: item.explanation.trim(),
    signalIds: [...new Set((item.signalIds ?? []).map((id) => id.trim()).filter(Boolean))],
    inferred: item.inferred ?? false,
    evidenceFreshness: item.evidenceFreshness ?? "fresh",
  }));
}

function normalizeEvidence(items: FitEvidenceInput[]): FitEvidenceCitation[] {
  return items.map((item) =>
    FitEvidenceCitation.parse({
      signalId: item.signalId.trim(),
      claim: item.claim.trim(),
      kind: item.kind,
      freshness: item.freshness ?? "fresh",
    }),
  );
}

function withAttribution(
  db: FitDb,
  item: FitEvidenceCitation,
  citedSignals: Array<typeof signals.$inferSelect>,
): FitEvidenceCitation {
  const signal = citedSignals.find((candidate) => candidate.id === item.signalId);
  if (!signal) return item;
  const attribution = db
    .select()
    .from(signalAttributions)
    .where(eq(signalAttributions.signalId, item.signalId))
    .get();
  if (!attribution) {
    throw new RecruitingError(
      "VALIDATION",
      `Signal ${item.signalId} has no attributable Scout Run evidence`,
    );
  }
  return {
    ...item,
    attribution: {
      sourceId: signal.sourceId,
      runId: signal.runId,
      scoutId: attribution.scoutId,
    },
  };
}

function toFitSummary(row: FitRow, db?: FitDb, at = Date.now()): FitEvaluationSummary {
  const detail = parseDetail(row.detail);
  const expiredSignalIds = db
    ? new Set(
        db
          .select({ signalId: fitEvaluationSignalLinks.signalId })
          .from(fitEvaluationSignalLinks)
          .innerJoin(signals, eq(signals.id, fitEvaluationSignalLinks.signalId))
          .where(
            and(eq(fitEvaluationSignalLinks.evaluationId, row.id), lte(signals.retentionUntil, at)),
          )
          .all()
          .map((item) => item.signalId),
      )
    : new Set<string>();
  const stale = row.freshness === "stale" || expiredSignalIds.size > 0;
  const hardConstraints = detail.hardConstraints.map((item) =>
    item.signalIds.some((id) => expiredSignalIds.has(id))
      ? { ...item, evidenceFreshness: "stale" as const }
      : item,
  );
  const preferences = detail.preferences.map((item) =>
    item.signalIds.some((id) => expiredSignalIds.has(id))
      ? { ...item, evidenceFreshness: "stale" as const }
      : item,
  );
  const evidence = detail.evidence.map((item) =>
    expiredSignalIds.has(item.signalId) ? { ...item, freshness: "stale" as const } : item,
  );
  return {
    id: row.id,
    leadId: row.leadId,
    opportunityId: row.opportunityId,
    profileVersionId: row.profileVersionId,
    runId: row.runId,
    strategyHash: row.strategyHash,
    policyHash: row.policyHash,
    strategyMaterial: detail.strategyMaterial,
    policyMaterial: detail.policyMaterial,
    hardConstraints,
    preferences,
    evidence,
    conflicts: detail.conflicts,
    unknowns: detail.unknowns,
    freshness: stale ? "stale" : detail.freshness,
    staleReason: stale ? (row.staleReason ?? "evidence_stale") : row.staleReason,
    staleAt: stale ? (row.staleAt ?? at) : row.staleAt,
    currentProfileVersionId: detail.currentProfileVersionId ?? row.profileVersionId,
    nextReconsiderationAt: detail.nextReconsiderationAt,
    createdAt: row.createdAt,
  };
}

function parseDetail(value: string): {
  hardConstraints: FitConstraintConclusion[];
  preferences: FitConstraintConclusion[];
  evidence: FitEvidenceCitation[];
  conflicts: string[];
  unknowns: string[];
  freshness: "fresh" | "stale";
  strategyMaterial: string;
  policyMaterial: string;
  currentProfileVersionId?: string;
  nextReconsiderationAt: number | null;
} {
  const parsed = JSON.parse(value) as Partial<ReturnType<typeof parseDetail>>;
  return {
    hardConstraints: parsed.hardConstraints ?? [],
    preferences: parsed.preferences ?? [],
    evidence: parsed.evidence ?? [],
    conflicts: parsed.conflicts ?? [],
    unknowns: parsed.unknowns ?? [],
    freshness: parsed.freshness === "stale" ? "stale" : "fresh",
    strategyMaterial: parsed.strategyMaterial ?? "",
    policyMaterial: parsed.policyMaterial ?? "",
    currentProfileVersionId: parsed.currentProfileVersionId,
    nextReconsiderationAt: parsed.nextReconsiderationAt ?? null,
  };
}

export function markFitEvaluationsStale(
  tx: FitDb,
  profileVersionIds: string[],
  currentProfileVersionId: string,
  at: number,
  reason = "candidate_profile_changed",
): void {
  if (profileVersionIds.length === 0) return;
  const rows = tx
    .select()
    .from(fitEvaluations)
    .where(inArray(fitEvaluations.profileVersionId, profileVersionIds))
    .all();
  for (const row of rows) {
    if (row.staleAt !== null) continue;
    const detail = parseDetail(row.detail);
    tx.update(fitEvaluations)
      .set({
        freshness: "stale",
        staleReason: reason,
        staleAt: at,
        detail: JSON.stringify({ ...detail, freshness: "stale", currentProfileVersionId }),
      })
      .where(eq(fitEvaluations.id, row.id))
      .run();
  }
}

function toOpportunitySummary(row: OpportunityRow): OpportunitySummary {
  return {
    id: row.id,
    leadId: row.leadId,
    title: row.title,
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireFit(db: FitDb, id: string): FitRow {
  const row = db.select().from(fitEvaluations).where(eq(fitEvaluations.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Fit Evaluation ${id} was not found`);
  return row;
}

function requireKey(value: string): void {
  if (!value.trim()) throw new RecruitingError("VALIDATION", "Idempotency key is required");
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashMaterial(value: string | null): string | null {
  return value ? hashPayload(value) : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function findReceipt(
  db: FitDb,
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

function receiptFor(
  scopeKind: string,
  scopeId: string,
  commandKind: string,
  idempotencyKey: string,
  payloadHash: string,
  result: unknown,
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
    result: JSON.stringify(result),
    errorCode: null,
    createdAt: at,
    completedAt: at,
  } as const;
}

function writeReceipt(db: FitDb, receipt: ReturnType<typeof receiptFor>): void {
  db.insert(commandReceipts).values(receipt).run();
}

function currentRevision(db: FitDb): number {
  return db.select().from(domainClock).where(eq(domainClock.id, 1)).get()?.revision ?? 0;
}

function advanceRevision(db: FitDb): number {
  db.update(domainClock)
    .set({ revision: sql`${domainClock.revision} + 1` })
    .where(eq(domainClock.id, 1))
    .run();
  return currentRevision(db);
}
