import { describe, expect, test } from "bun:test";
import { type PendingEvidence, PendingEvidenceStore } from "./pending-evidence";

function evidence(overrides: Partial<PendingEvidence> = {}): PendingEvidence {
  return {
    issuer: "ashby",
    item: {
      identityKey: "ashby:job-1",
      providerIdentity: "job-1",
      canonicalUrl: "https://jobs.ashbyhq.com/Roadrunner/job-1",
      title: "Junior Software Engineer",
      content: "Build things.",
      publicationAt: 1_000,
    },
    scoutId: "scout-1",
    runId: "run-1",
    sourceId: "source-ashby",
    sourceAttemptId: "attempt-1",
    issuedAt: 1_000,
    expiresAt: 2_000,
    excludedByPolicy: false,
    ...overrides,
  };
}

describe("pending evidence store", () => {
  test("resolves any issuer's reference from the one store", () => {
    const store = new PendingEvidenceStore();
    const ashby = store.issue(evidence());
    const bird = store.issue(evidence({ issuer: "bird" }));

    expect(ashby).toStartWith("ashby-evidence:");
    expect(bird).toStartWith("bird-evidence:");
    expect(store.resolve(ashby, "scout-1", 1_500).issuer).toBe("ashby");
    expect(store.resolve(bird, "scout-1", 1_500).issuer).toBe("bird");
  });

  test("rejects unknown, expired, cross-Scout, and policy-excluded references", () => {
    const store = new PendingEvidenceStore();
    const reference = store.issue(evidence());
    const excluded = store.issue(evidence({ excludedByPolicy: true }));

    expect(() => store.resolve("ashby-evidence:missing", "scout-1", 1_500)).toThrow(
      /no longer available/,
    );
    expect(() => store.resolve(reference, "scout-2", 1_500)).toThrow(/another Scout/);
    expect(() => store.resolve(excluded, "scout-1", 1_500)).toThrow(/excluded this Ashby posting/);
    expect(() => store.resolve(reference, "scout-1", 2_000)).toThrow(/expired/);
    // An expired reference is dropped, so it then reads as unknown.
    expect(() => store.resolve(reference, "scout-1", 1_500)).toThrow(/no longer available/);
  });

  test("rejects an item mutated after it was issued", () => {
    const store = new PendingEvidenceStore();
    const pending = evidence();
    const reference = store.issue(pending);
    pending.item.content = "Tampered.";

    expect(() => store.resolve(reference, "scout-1", 1_500)).toThrow(/invalid/);
  });

  test("prunes expired references and invalidates a finished Run", () => {
    const store = new PendingEvidenceStore();
    const stale = store.issue(evidence({ expiresAt: 1_200 }));
    const otherRun = store.issue(evidence({ runId: "run-2" }));
    const live = store.issue(evidence());

    store.prune(1_500);
    store.invalidateRun("run-2");

    expect(store.peek(stale)).toBeUndefined();
    expect(store.peek(otherRun)).toBeUndefined();
    expect(store.peek(live)).toBeDefined();
  });
});
