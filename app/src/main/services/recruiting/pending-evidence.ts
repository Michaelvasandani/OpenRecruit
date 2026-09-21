import { createHash, randomUUID } from "node:crypto";
import { RecruitingError } from "./errors";
import type { FeedItem } from "./source";

/** The host-owned Source module that read the evidence. */
export type PendingEvidenceIssuer = "bird" | "ashby" | "ats";

export type PendingEvidence = {
  issuer: PendingEvidenceIssuer;
  item: FeedItem;
  scoutId: string;
  runId: string;
  sourceId: string;
  sourceAttemptId: string;
  issuedAt: number;
  expiresAt: number;
  /** The Scout Policy excluded this item; it can be shown but never promoted. */
  excludedByPolicy: boolean;
};

type StoredEvidence = PendingEvidence & { contentFingerprint: string };

const ISSUER_LABEL: Record<PendingEvidenceIssuer, string> = {
  bird: "X",
  ashby: "Ashby",
  ats: "job board",
};

/**
 * The one short-lived store behind every RecordSignal evidence reference. A
 * reference is an opaque host capability: Source modules issue it when they
 * read an item, and RecordSignal resolves it here regardless of which module
 * issued it, so a reference can never be looked up in the wrong place.
 */
export class PendingEvidenceStore {
  private readonly entries = new Map<string, StoredEvidence>();

  issue(evidence: PendingEvidence): string {
    const reference = `${evidence.issuer}-evidence:${randomUUID()}`;
    this.entries.set(reference, { ...evidence, contentFingerprint: fingerprint(evidence.item) });
    return reference;
  }

  /** Read without consuming or validating; for batch pre-checks. */
  peek(reference: string): PendingEvidence | undefined {
    return this.entries.get(reference);
  }

  /** Resolve a reference for promotion by `scoutId` at host time `at`. */
  resolve(reference: string, scoutId: string, at: number): PendingEvidence {
    const pending = this.entries.get(reference);
    if (!pending) {
      throw new RecruitingError(
        "NOT_FOUND",
        "The evidence reference is no longer available; run the read or inspection again",
      );
    }
    const label = ISSUER_LABEL[pending.issuer];
    if (at >= pending.expiresAt) {
      this.entries.delete(reference);
      throw new RecruitingError(
        "NOT_FOUND",
        `The ${label} evidence reference has expired; run the read or inspection again`,
      );
    }
    if (pending.contentFingerprint !== fingerprint(pending.item)) {
      this.entries.delete(reference);
      throw new RecruitingError("VALIDATION", `The ${label} evidence reference is invalid`);
    }
    if (pending.scoutId !== scoutId) {
      throw new RecruitingError(
        "CONFLICT",
        `The ${label} evidence reference belongs to another Scout`,
      );
    }
    if (pending.excludedByPolicy) {
      throw new RecruitingError(
        "CONFLICT",
        `The Scout Policy excluded this ${label} posting; it cannot be promoted to a Signal`,
      );
    }
    return pending;
  }

  delete(reference: string): void {
    this.entries.delete(reference);
  }

  prune(at: number): void {
    for (const [reference, pending] of this.entries) {
      if (pending.expiresAt <= at) this.entries.delete(reference);
    }
  }

  invalidateRun(runId: string): void {
    for (const [reference, pending] of this.entries) {
      if (pending.runId === runId) this.entries.delete(reference);
    }
  }
}

function fingerprint(item: FeedItem): string {
  return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}
