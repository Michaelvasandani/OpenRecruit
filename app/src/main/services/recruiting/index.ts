import { createHash, randomUUID } from "node:crypto";
import {
  type RecruitingErrorCode,
  type RecruitingInvalidation,
  ScoutHarness,
  type ScoutSummary,
} from "@shared/recruiting";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { commandReceipts, domainClock, scouts } from "../../db/schema";
import { bus } from "../event-bus";

export class RecruitingError extends Error {
  readonly code: RecruitingErrorCode;

  constructor(code: RecruitingErrorCode, message: string) {
    super(message);
    this.name = "RecruitingError";
    this.code = code;
  }
}

export type CreateScoutCommand = {
  name: string;
  harness: ScoutHarness;
  instructionPath: string;
  strategyPath?: string | null;
  defaultProfileId?: string | null;
  resumableSessionRef?: string | null;
  idempotencyKey: string;
};

export type ArchiveScoutCommand = {
  scoutId: string;
  expectedRevision: number;
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

type RecruitingDb = Pick<Db, "select" | "insert" | "update">;

/**
 * The single deep Recruiting write/read boundary. Adapters (tRPC, the future
 * agent API, and the renderer) consume this service rather than touching tables.
 * Each mutation is a short SQLite transaction; post-commit invalidations are
 * published only after the transaction has completed successfully.
 */
export class RecruitingApplication {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  listScouts(): ScoutSummary[] {
    return this.db
      .select()
      .from(scouts)
      .where(eq(scouts.lifecycleState, "active"))
      .orderBy(asc(scouts.createdAt), asc(scouts.id))
      .all()
      .map(toScoutSummary);
  }

  getScout(id: string): ScoutSummary | null {
    const row = this.db.select().from(scouts).where(eq(scouts.id, id)).get();
    return row ? toScoutSummary(row) : null;
  }

  createScout(command: CreateScoutCommand): CommandResult<ScoutSummary> {
    const normalized = {
      name: command.name.trim(),
      harness: ScoutHarness.parse(command.harness),
      instructionPath: command.instructionPath.trim(),
      strategyPath: command.strategyPath ?? null,
      defaultProfileId: command.defaultProfileId ?? null,
      resumableSessionRef: command.resumableSessionRef ?? null,
    };
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
      tx.insert(scouts)
        .values({
          id,
          name: normalized.name,
          harness: normalized.harness,
          instructionPath: normalized.instructionPath,
          strategyPath: normalized.strategyPath,
          defaultProfileId: normalized.defaultProfileId,
          lifecycleState: "active",
          resumableSessionRef: normalized.resumableSessionRef,
          legacyAgentId: null,
          revision: 0,
          createdAt: at,
          archivedAt: null,
        })
        .run();
      const value = toScoutSummary(requireScout(tx, id));
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
      const value = toScoutSummary(requireScout(tx, command.scoutId));
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

function toScoutSummary(row: typeof scouts.$inferSelect): ScoutSummary {
  return {
    id: row.id,
    name: row.name,
    harness: ScoutHarness.parse(row.harness),
    instructionPath: row.instructionPath,
    strategyPath: row.strategyPath,
    defaultProfileId: row.defaultProfileId,
    lifecycleState: row.lifecycleState === "archived" ? "archived" : "active",
    resumableSessionRef: row.resumableSessionRef,
    legacyAgentId: row.legacyAgentId,
    revision: row.revision,
    createdAt: row.createdAt,
  };
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
