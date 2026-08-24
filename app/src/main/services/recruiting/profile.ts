import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CandidateProfileSummary,
  CandidateProfileVersion,
  type ProfileFact,
  ProfileFact as ProfileFactSchema,
  type ProfileFactSection,
  ProfileFactSection as ProfileFactSectionSchema,
  type ProfileFactSource,
  ProfileFactSource as ProfileFactSourceSchema,
  type ProfileSection,
} from "@shared/recruiting";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { commandReceipts, domainClock, profiles, profileVersions } from "../../db/schema";
import { bus } from "../event-bus";
import { RecruitingError } from "./errors";
import { markFitEvaluationsStale } from "./fit";

export interface ProfileArtifactStore {
  write(path: string, contents: string): void;
}

const diskArtifactStore: ProfileArtifactStore = {
  write(path, contents) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  },
};

export type GitHubFactInput = {
  section?: "portfolio";
  key: string;
  value: string;
  sourceRef?: string;
};

export type GitHubImportInput = {
  url?: string;
  handle?: string;
  facts?: GitHubFactInput[];
};

export type ImportProfileCommand = {
  name: string;
  roleTarget: string;
  cvPath?: string;
  cvText?: string;
  github?: string | GitHubImportInput;
  careerInterests: string;
  hardConstraints?: string[];
  preferences?: string[];
  idempotencyKey: string;
};

export type ProfileFactInput = {
  id?: string;
  section: ProfileFactSection;
  key: string;
  value: string;
  source: ProfileFactSource;
  sourceLabel: string;
  sourceRef?: string | null;
};

export type UpdateDraftCommand = {
  profileId: string;
  expectedRevision: number;
  removeFactIds?: string[];
  addFacts?: ProfileFactInput[];
  replaceFacts?: ProfileFactInput[];
  idempotencyKey: string;
};

export type ConfirmProfileCommand = {
  profileId: string;
  expectedRevision: number;
  idempotencyKey: string;
};

type ProfileServiceOptions = {
  artifactStore?: ProfileArtifactStore;
  artifactPath?: (profileId: string, name: string) => string;
  now?: () => number;
};

type StructuredDraft = {
  name: string;
  roleTarget: string;
  facts: ProfileFact[];
  importWarnings: string[];
};

type ProfileDb = Pick<Db, "select" | "insert" | "update">;
type ProfileRow = typeof profiles.$inferSelect;
type VersionRow = typeof profileVersions.$inferSelect;

/**
 * Candidate Profile import/review boundary. It deliberately accepts generic
 * text and optional structured public GitHub facts: no provider transcript or
 * authentication material is persisted, and the Markdown artifact remains the
 * human-readable source of truth.
 */
export class CandidateProfileApplication {
  private readonly artifactStore: ProfileArtifactStore;
  private readonly artifactPath: (profileId: string, name: string) => string;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    options: ProfileServiceOptions = {},
  ) {
    this.artifactStore = options.artifactStore ?? diskArtifactStore;
    this.artifactPath =
      options.artifactPath ??
      ((profileId, name) => {
        const safeName = slug(name) || "candidate-profile";
        const root = process.env.OPENTRADE_HOME ?? join(homedir(), ".opentrade");
        return join(root, "profiles", `${safeName}-${profileId}.md`);
      });
    this.now = options.now ?? Date.now;
  }

  /** Kept for callers that own a service lifecycle; the artifact store is sync. */
  dispose(): void {}

  listProfiles(): CandidateProfileSummary[] {
    return this.db
      .select()
      .from(profiles)
      .orderBy(asc(profiles.createdAt), asc(profiles.id))
      .all()
      .map((row) => this.toSummary(this.db, row));
  }

  getProfile(id: string): CandidateProfileSummary | null {
    const row = this.db.select().from(profiles).where(eq(profiles.id, id)).get();
    return row ? this.toSummary(this.db, row) : null;
  }

  listVersions(profileId: string): CandidateProfileVersion[] {
    return this.db
      .select()
      .from(profileVersions)
      .where(eq(profileVersions.profileId, profileId))
      .orderBy(asc(profileVersions.versionNo))
      .all()
      .map((row) => this.toVersion(row));
  }

  getVersion(id: string): CandidateProfileVersion | null {
    const row = this.db.select().from(profileVersions).where(eq(profileVersions.id, id)).get();
    return row ? this.toVersion(row) : null;
  }

  importProfile(command: ImportProfileCommand): CandidateProfileSummary {
    const normalized = normalizeImport(command);
    const imported = buildDraft(normalized);
    const payloadHash = hashPayload({ ...normalized, imported });
    let artifact: { path: string; markdown: string } | undefined;
    let notification: { id: string; revision: number; at: number } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(tx, "profile", "root", "import", command.idempotencyKey);
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        const summary = parseReceipt<CandidateProfileSummary>(previous.result);
        artifact = { path: summary.artifactPath, markdown: summary.markdown };
        return { summary, changed: false };
      }

      const candidates = tx
        .select()
        .from(profiles)
        .where(
          and(eq(profiles.name, normalized.name), eq(profiles.roleTarget, normalized.roleTarget)),
        )
        .all();
      const same = candidates.find((row) => row.contentHash === imported.contentHash);
      const at = this.now();
      if (same) {
        const summary = this.toSummary(tx, same);
        writeReceipt(tx, {
          scopeKind: "profile",
          scopeId: "root",
          commandKind: "import",
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          status: "succeeded",
          result: JSON.stringify(summary),
          createdAt: at,
          completedAt: at,
        });
        artifact = { path: summary.artifactPath, markdown: summary.markdown };
        return { summary, changed: false };
      }

      const row = candidates[0];
      const id = row?.id ?? randomUUID();
      const path = row?.artifactPath ?? this.artifactPath(id, normalized.name);
      if (row) {
        tx.update(profiles)
          .set({
            roleTarget: normalized.roleTarget,
            state: "draft",
            artifactPath: path,
            contentHash: imported.contentHash,
            draftMarkdown: imported.markdown,
            draftStructured: JSON.stringify(imported.structured),
            draftProvenance: JSON.stringify(imported.provenance),
            revision: row.revision + 1,
            updatedAt: at,
          })
          .where(eq(profiles.id, row.id))
          .run();
      } else {
        tx.insert(profiles)
          .values({
            id,
            name: normalized.name,
            roleTarget: normalized.roleTarget,
            artifactPath: path,
            state: "draft",
            currentVersionId: null,
            contentHash: imported.contentHash,
            draftMarkdown: imported.markdown,
            draftStructured: JSON.stringify(imported.structured),
            draftProvenance: JSON.stringify(imported.provenance),
            revision: 0,
            createdAt: at,
            updatedAt: at,
          })
          .run();
      }
      const saved = requireProfile(tx, id);
      const revision = advanceRevision(tx);
      const summary = this.toSummary(tx, saved);
      writeReceipt(tx, {
        scopeKind: "profile",
        scopeId: "root",
        commandKind: "import",
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        status: "succeeded",
        result: JSON.stringify(summary),
        createdAt: at,
        completedAt: at,
      });
      artifact = { path, markdown: imported.markdown };
      notification = { id, revision, at };
      return { summary, changed: true };
    });
    if (artifact) this.artifactStore.write(artifact.path, artifact.markdown);
    if (notification) this.emitChanged(notification);
    return outcome.summary;
  }

  updateDraft(command: UpdateDraftCommand): CandidateProfileSummary {
    requireKey(command.idempotencyKey);
    const payloadHash = hashPayload({
      profileId: command.profileId,
      expectedRevision: command.expectedRevision,
      removeFactIds: command.removeFactIds ?? [],
      addFacts: command.addFacts ?? [],
      replaceFacts: command.replaceFacts ?? null,
    });
    let artifact: { path: string; markdown: string } | undefined;
    let notification: { id: string; revision: number; at: number } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "profile",
        command.profileId,
        "update_draft",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        const summary = parseReceipt<CandidateProfileSummary>(previous.result);
        artifact = { path: summary.artifactPath, markdown: summary.markdown };
        return summary;
      }
      const row = requireProfile(tx, command.profileId);
      assertProfileRevision(row, command.expectedRevision);
      const current = this.effectiveDraft(tx, row);
      const remove = new Set(command.removeFactIds ?? []);
      let facts = command.replaceFacts
        ? command.replaceFacts.map(toFact)
        : current.structured.facts.filter((fact) => !remove.has(fact.id));
      if (command.addFacts) facts = mergeManualFacts(facts, command.addFacts.map(toFact));
      const draft = makeDraft(
        { name: row.name, roleTarget: row.roleTarget },
        facts,
        current.structured.importWarnings,
      );
      const at = this.now();
      const currentHash = row.state === "confirmed" ? current.contentHash : row.contentHash;
      if (draft.contentHash === currentHash && row.state === "confirmed") {
        const summary = this.toSummary(tx, row);
        writeReceipt(
          tx,
          receiptFor(
            "profile",
            command.profileId,
            "update_draft",
            command.idempotencyKey,
            payloadHash,
            summary,
            at,
          ),
        );
        return summary;
      }
      tx.update(profiles)
        .set({
          state: "draft",
          contentHash: draft.contentHash,
          draftMarkdown: draft.markdown,
          draftStructured: JSON.stringify(draft.structured),
          draftProvenance: JSON.stringify(draft.provenance),
          revision: row.revision + 1,
          updatedAt: at,
        })
        .where(eq(profiles.id, row.id))
        .run();
      const saved = requireProfile(tx, row.id);
      const revision = advanceRevision(tx);
      const summary = this.toSummary(tx, saved);
      writeReceipt(
        tx,
        receiptFor(
          "profile",
          command.profileId,
          "update_draft",
          command.idempotencyKey,
          payloadHash,
          summary,
          at,
        ),
      );
      artifact = { path: saved.artifactPath, markdown: draft.markdown };
      notification = { id: row.id, revision, at };
      return summary;
    });
    if (artifact) this.artifactStore.write(artifact.path, artifact.markdown);
    if (notification) this.emitChanged(notification);
    return outcome;
  }

  /** Explicitly named alias for retention/deletion controls in the desktop adapter. */
  deleteProfileContent(
    command: Omit<UpdateDraftCommand, "addFacts" | "replaceFacts">,
  ): CandidateProfileSummary {
    return this.updateDraft(command);
  }

  confirmProfile(command: ConfirmProfileCommand): CandidateProfileSummary {
    requireKey(command.idempotencyKey);
    const payloadHash = hashPayload(command);
    let artifact: { path: string; markdown: string } | undefined;
    let notification: { id: string; revision: number; at: number } | undefined;
    const outcome = this.db.transaction((tx) => {
      const previous = findReceipt(
        tx,
        "profile",
        command.profileId,
        "confirm",
        command.idempotencyKey,
      );
      if (previous) {
        assertReceiptPayload(previous, payloadHash);
        const summary = parseReceipt<CandidateProfileSummary>(previous.result);
        artifact = { path: summary.artifactPath, markdown: summary.markdown };
        return summary;
      }
      const row = requireProfile(tx, command.profileId);
      assertProfileRevision(row, command.expectedRevision);
      const draft = this.effectiveDraft(tx, row);
      const at = this.now();
      const current = row.currentVersionId
        ? tx
            .select()
            .from(profileVersions)
            .where(eq(profileVersions.id, row.currentVersionId))
            .get()
        : undefined;

      if (row.state === "confirmed" && !row.draftStructured && current) {
        const summary = this.toSummary(tx, row);
        writeReceipt(
          tx,
          receiptFor(
            "profile",
            command.profileId,
            "confirm",
            command.idempotencyKey,
            payloadHash,
            summary,
            at,
          ),
        );
        artifact = { path: summary.artifactPath, markdown: summary.markdown };
        return summary;
      }

      let version = current;
      const sameAsCurrent = current?.contentHash === draft.contentHash;
      if (!sameAsCurrent) {
        const last = tx
          .select()
          .from(profileVersions)
          .where(eq(profileVersions.profileId, row.id))
          .orderBy(desc(profileVersions.versionNo))
          .get();
        const versionId = randomUUID();
        tx.insert(profileVersions)
          .values({
            id: versionId,
            profileId: row.id,
            versionNo: (last?.versionNo ?? 0) + 1,
            markdownSnapshot: draft.markdown,
            structuredSnapshot: JSON.stringify(draft.structured),
            provenance: JSON.stringify(draft.provenance),
            contentHash: draft.contentHash,
            confirmedAt: at,
            createdAt: at,
          })
          .run();
        version = tx.select().from(profileVersions).where(eq(profileVersions.id, versionId)).get();
        const previousVersionIds = tx
          .select({ id: profileVersions.id })
          .from(profileVersions)
          .where(
            and(eq(profileVersions.profileId, row.id), sql`${profileVersions.id} <> ${versionId}`),
          )
          .all()
          .map((item) => item.id);
        markFitEvaluationsStale(tx, previousVersionIds, versionId, at);
      }
      if (!version) throw new RecruitingError("VALIDATION", "Profile draft could not be confirmed");
      tx.update(profiles)
        .set({
          state: "confirmed",
          currentVersionId: version.id,
          contentHash: version.contentHash,
          draftMarkdown: null,
          draftStructured: null,
          draftProvenance: null,
          revision: row.revision + 1,
          updatedAt: at,
        })
        .where(eq(profiles.id, row.id))
        .run();
      const saved = requireProfile(tx, row.id);
      const revision = advanceRevision(tx);
      const summary = this.toSummary(tx, saved);
      writeReceipt(
        tx,
        receiptFor(
          "profile",
          command.profileId,
          "confirm",
          command.idempotencyKey,
          payloadHash,
          summary,
          at,
        ),
      );
      artifact = { path: saved.artifactPath, markdown: version.markdownSnapshot };
      notification = { id: row.id, revision, at };
      return summary;
    });
    if (artifact) this.artifactStore.write(artifact.path, artifact.markdown);
    if (notification) this.emitChanged(notification);
    return outcome;
  }

  private toSummary(db: ProfileDb, row: ProfileRow): CandidateProfileSummary {
    const currentVersionRow = row.currentVersionId
      ? db.select().from(profileVersions).where(eq(profileVersions.id, row.currentVersionId)).get()
      : undefined;
    const currentVersion = currentVersionRow ? this.toVersion(currentVersionRow) : null;
    const data =
      row.state === "draft" && row.draftStructured
        ? parseStructured(row.draftStructured)
        : currentVersion
          ? {
              name: row.name,
              roleTarget: row.roleTarget,
              facts: currentVersion.facts,
              importWarnings: [],
            }
          : { name: row.name, roleTarget: row.roleTarget, facts: [], importWarnings: [] };
    const markdown =
      row.state === "draft" && row.draftMarkdown
        ? row.draftMarkdown
        : (currentVersion?.markdown ?? renderMarkdown(data));
    return CandidateProfileSummary.parse({
      id: row.id,
      name: row.name,
      roleTarget: row.roleTarget,
      artifactPath: row.artifactPath,
      state: row.state === "confirmed" ? "confirmed" : "draft",
      currentVersion,
      sections: groupSections(data.facts),
      markdown,
      importWarnings: data.importWarnings,
      revision: row.revision,
      updatedAt: row.updatedAt,
    });
  }

  private toVersion(row: VersionRow): CandidateProfileVersion {
    const data = parseStructured(row.structuredSnapshot);
    return CandidateProfileVersion.parse({
      id: row.id,
      profileId: row.profileId,
      versionNo: row.versionNo,
      markdown: row.markdownSnapshot,
      facts: data.facts,
      provenance: parseStringArray(row.provenance),
      contentHash: row.contentHash,
      confirmedAt: row.confirmedAt,
      immutable: true,
    });
  }

  private effectiveDraft(db: ProfileDb, row: ProfileRow): ReturnType<typeof makeDraft> {
    if (row.state === "draft" && row.draftStructured && row.draftMarkdown && row.contentHash) {
      const structured = parseStructured(row.draftStructured);
      return {
        structured,
        markdown: row.draftMarkdown,
        provenance: parseStringArray(row.draftProvenance ?? "[]"),
        contentHash: row.contentHash,
      };
    }
    if (row.currentVersionId) {
      const version = db
        .select()
        .from(profileVersions)
        .where(eq(profileVersions.id, row.currentVersionId))
        .get();
      if (version) {
        const structured = parseStructured(version.structuredSnapshot);
        return {
          structured,
          markdown: version.markdownSnapshot,
          provenance: parseStringArray(version.provenance),
          contentHash: version.contentHash,
        };
      }
    }
    return makeDraft({ name: row.name, roleTarget: row.roleTarget }, [], []);
  }

  private emitChanged(change: { id: string; revision: number; at: number }): void {
    bus.emitEvent("recruiting:changed", {
      revision: change.revision,
      kind: "review",
      ids: [change.id],
      reason: "profile_changed",
      at: change.at,
    });
  }
}

function normalizeImport(
  command: ImportProfileCommand,
): ImportProfileCommand & { name: string; roleTarget: string } {
  requireKey(command.idempotencyKey);
  const name = command.name.trim();
  const roleTarget = command.roleTarget.trim();
  if (!name || !roleTarget) {
    throw new RecruitingError("VALIDATION", "Profile name and role target are required");
  }
  return { ...command, name, roleTarget, careerInterests: command.careerInterests.trim() };
}

function buildDraft(command: ImportProfileCommand): {
  structured: StructuredDraft;
  markdown: string;
  provenance: string[];
  contentHash: string;
} {
  const warnings: string[] = [];
  const cvText = command.cvText?.trim() || (command.cvPath ? readCv(command.cvPath, warnings) : "");
  const facts: ProfileFact[] = [];
  if (cvText) facts.push(...parseCvFacts(cvText, command.cvPath, command.name));

  const github = normalizeGithub(command.github, warnings);
  if (github) {
    facts.push({
      id: factId("portfolio", "profile", github.url, "github"),
      section: "portfolio",
      key: "profile",
      value: github.url,
      source: "github",
      sourceLabel: "GitHub",
      sourceRef: github.url,
      conflict: false,
      conflictWith: [],
    });
    for (const fact of github.facts) {
      const key = normalizeKey(fact.key);
      const value = fact.value.trim();
      if (!key || !value) continue;
      facts.push({
        id: factId("portfolio", key, value, "github"),
        section: "portfolio",
        key,
        value,
        source: "github",
        sourceLabel: "GitHub",
        sourceRef: fact.sourceRef ?? github.url,
        conflict: false,
        conflictWith: [],
      });
    }
  }
  facts.push(
    ...parseListFacts("career_interests", command.careerInterests, "career_interests", "Candidate"),
  );
  facts.push(
    ...parseArrayFacts("hard_constraints", command.hardConstraints ?? [], "manual", "Candidate"),
  );
  facts.push(...parseArrayFacts("preferences", command.preferences ?? [], "manual", "Candidate"));
  const merged = mergeImportedFacts(facts);
  return makeDraft({ name: command.name, roleTarget: command.roleTarget }, merged, warnings);
}

function makeDraft(
  identity: { name: string; roleTarget: string },
  facts: ProfileFact[],
  importWarnings: string[],
): { structured: StructuredDraft; markdown: string; provenance: string[]; contentHash: string } {
  const structured: StructuredDraft = {
    name: identity.name,
    roleTarget: identity.roleTarget,
    facts: mergeImportedFacts(facts),
    importWarnings: [...new Set(importWarnings)],
  };
  const contentHash = hashPayload({
    name: identity.name,
    roleTarget: identity.roleTarget,
    facts: structured.facts,
  });
  return {
    structured,
    markdown: renderMarkdown(structured),
    provenance: [
      ...new Set(structured.facts.map((fact) => `${fact.source}:${fact.sourceLabel}`)),
    ].sort(),
    contentHash,
  };
}

function parseCvFacts(text: string, sourceRef?: string, candidateName?: string): ProfileFact[] {
  const result: ProfileFact[] = [];
  let heading = "cv";
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/^\s*[-•*]\s*/, "").trim();
    if (!line) continue;
    if (candidateName && line.toLowerCase() === candidateName.toLowerCase()) continue;
    const normalizedHeading = normalizeKey(line.replace(/:$/, ""));
    if (CV_HEADINGS.has(normalizedHeading)) {
      heading = normalizedHeading;
      continue;
    }
    const colon = line.match(/^([^:]{2,48}):\s*(.+)$/);
    const key = normalizeKey(colon?.[1] ?? (heading === "cv" ? "experience" : heading));
    const value = (colon?.[2] ?? line).trim();
    if (!value || value.length < 2) continue;
    result.push({
      id: factId("cv", key, value, "cv"),
      section: "cv",
      key,
      value,
      source: "cv",
      sourceLabel: "CV",
      sourceRef: sourceRef ?? null,
      conflict: false,
      conflictWith: [],
    });
  }
  return result;
}

function parseListFacts(
  section: ProfileFactSection,
  text: string,
  source: ProfileFactSource,
  sourceLabel: string,
): ProfileFact[] {
  return parseArrayFacts(section, text.split(/[\n,]/), source, sourceLabel);
}

function parseArrayFacts(
  section: ProfileFactSection,
  values: string[],
  source: ProfileFactSource,
  sourceLabel: string,
): ProfileFact[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const key = `${section}-${normalizeKey(value)}`;
      return {
        id: factId(section, key, value, source),
        section,
        key,
        value,
        source,
        sourceLabel,
        sourceRef: null,
        conflict: false,
        conflictWith: [],
      } satisfies ProfileFact;
    });
}

function mergeImportedFacts(facts: ProfileFact[]): ProfileFact[] {
  const result: ProfileFact[] = [];
  const byKey = new Map<string, ProfileFact[]>();
  for (const fact of facts) {
    const key = normalizeKey(fact.key);
    const existing = result.find(
      (item) => normalizeKey(item.key) === key && item.value === fact.value,
    );
    if (existing) {
      if (!existing.sourceRef && fact.sourceRef) existing.sourceRef = fact.sourceRef;
      continue;
    }
    result.push({ ...fact, key });
    byKey.set(key, [...(byKey.get(key) ?? []), result[result.length - 1]]);
  }
  for (const sameKey of byKey.values()) {
    const values = new Set(sameKey.map((fact) => fact.value.toLowerCase()));
    if (values.size < 2) continue;
    for (const fact of sameKey) {
      fact.conflict = true;
      fact.conflictWith = sameKey.filter((other) => other.id !== fact.id).map((other) => other.id);
    }
  }
  // CV assertions are the first/authoritative assertion for a conflicting key;
  // preserve every other attributable assertion after it for review.
  return result.sort((a, b) => {
    const sourceRank = (source: ProfileFactSource) =>
      source === "cv" ? 0 : source === "github" ? 1 : 2;
    return (
      sourceRank(a.source) - sourceRank(b.source) ||
      a.section.localeCompare(b.section) ||
      a.id.localeCompare(b.id)
    );
  });
}

function mergeManualFacts(existing: ProfileFact[], additions: ProfileFact[]): ProfileFact[] {
  return mergeImportedFacts([...existing, ...additions]);
}

function normalizeGithub(
  input: ImportProfileCommand["github"],
  warnings: string[],
): { url: string; facts: GitHubFactInput[] } | null {
  if (!input) return null;
  const value = typeof input === "string" ? { handle: input } : input;
  const rawUrl = value.url?.trim();
  const handle = value.handle?.trim().replace(/^@/, "");
  let url = rawUrl;
  if (!url && handle && /^[A-Za-z0-9-]+$/.test(handle)) url = `https://github.com/${handle}`;
  if (!url) {
    warnings.push("GitHub import was unavailable; review or add portfolio facts manually.");
    return null;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      !parsed.pathname.split("/").filter(Boolean)[0]
    ) {
      throw new Error("invalid GitHub URL");
    }
    return {
      url: `https://github.com/${parsed.pathname.split("/").filter(Boolean)[0]}`,
      facts: value.facts ?? [],
    };
  } catch {
    warnings.push("GitHub import was unavailable; review or add portfolio facts manually.");
    return null;
  }
}

function readCv(path: string, warnings: string[]): string {
  try {
    if (path.toLowerCase().endsWith(".pdf")) {
      try {
        return execFileSync("pdftotext", ["-layout", path, "-"], {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        }).trim();
      } catch {
        const printable =
          readFileSync(path)
            .toString("latin1")
            .match(/[ -~]{4,}/g)
            ?.join("\n") ?? "";
        if (printable) return printable;
      }
    }
    return readFileSync(path, "utf8").trim();
  } catch {
    warnings.push("CV import was unavailable; review or add CV facts manually.");
    return "";
  }
}

function toFact(input: ProfileFactInput): ProfileFact {
  const section = ProfileFactSectionSchema.parse(input.section);
  const source = ProfileFactSourceSchema.parse(input.source);
  const key = normalizeKey(input.key);
  const value = input.value.trim();
  if (!key || !value)
    throw new RecruitingError("VALIDATION", "Profile facts require a key and value");
  return ProfileFactSchema.parse({
    id: input.id?.trim() || factId(section, key, value, source),
    section,
    key,
    value,
    source,
    sourceLabel: input.sourceLabel.trim() || "Candidate",
    sourceRef: input.sourceRef?.trim() || null,
    conflict: false,
    conflictWith: [],
  });
}

function groupSections(facts: ProfileFact[]): ProfileSection[] {
  return (ProfileFactSectionSchema.options as ProfileFactSection[]).map((section) => ({
    section,
    facts: facts.filter((fact) => fact.section === section),
  }));
}

function renderMarkdown(data: Pick<StructuredDraft, "name" | "roleTarget" | "facts">): string {
  const labels: Record<ProfileFactSection, string> = {
    cv: "CV Material",
    portfolio: "Public Portfolio References",
    career_interests: "Career Interests",
    hard_constraints: "Hard Constraints",
    preferences: "Preferences",
  };
  const lines = [`# Candidate Profile: ${data.name}`, "", `Role target: ${data.roleTarget}`, ""];
  for (const section of ProfileFactSectionSchema.options) {
    lines.push(`## ${labels[section]}`, "");
    const sectionFacts = data.facts.filter((fact) => fact.section === section);
    if (sectionFacts.length === 0) lines.push("_None recorded._", "");
    for (const fact of sectionFacts) {
      const conflict = fact.conflict ? "; conflict remains visible" : "";
      const ref = fact.sourceRef ? `; ${fact.sourceRef}` : "";
      lines.push(
        `- **${fact.key}**: ${fact.value} _(Source: ${fact.sourceLabel}${ref}${conflict})_`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function parseStructured(value: string): StructuredDraft {
  try {
    const parsed = JSON.parse(value) as Partial<StructuredDraft>;
    if (!parsed.name || !parsed.roleTarget || !Array.isArray(parsed.facts))
      throw new Error("invalid profile snapshot");
    return {
      name: parsed.name,
      roleTarget: parsed.roleTarget,
      facts: parsed.facts.map((fact) => ProfileFactSchema.parse(fact)),
      importWarnings: Array.isArray(parsed.importWarnings)
        ? parsed.importWarnings.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    throw new RecruitingError("VALIDATION", "Profile snapshot is invalid");
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function slug(value: string): string {
  return normalizeKey(value).slice(0, 48);
}

function factId(section: string, key: string, value: string, source: string): string {
  return `fact-${createHash("sha256").update(`${section}\0${key}\0${value}\0${source}`).digest("hex").slice(0, 20)}`;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireKey(value: string): void {
  if (!value.trim()) throw new RecruitingError("VALIDATION", "Idempotency key is required");
}

function requireProfile(db: ProfileDb, id: string): ProfileRow {
  const row = db.select().from(profiles).where(eq(profiles.id, id)).get();
  if (!row) throw new RecruitingError("NOT_FOUND", `Profile ${id} was not found`);
  return row;
}

function assertProfileRevision(row: ProfileRow, expected: number): void {
  if (row.revision !== expected) {
    throw new RecruitingError(
      "CONFLICT",
      `Profile ${row.id} is at revision ${row.revision}; expected ${expected}`,
    );
  }
}

function currentRevision(db: ProfileDb): number {
  return db.select().from(domainClock).where(eq(domainClock.id, 1)).get()?.revision ?? 0;
}

function advanceRevision(db: ProfileDb): number {
  db.update(domainClock)
    .set({ revision: sql`${domainClock.revision} + 1` })
    .where(eq(domainClock.id, 1))
    .run();
  return currentRevision(db);
}

type ReceiptLookup = { result: string | null; payloadHash: string };

function findReceipt(
  db: ProfileDb,
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
  db: ProfileDb,
  receipt: Omit<typeof commandReceipts.$inferInsert, "id">,
): void {
  db.insert(commandReceipts)
    .values({ id: randomUUID(), ...receipt })
    .run();
}

const CV_HEADINGS = new Set([
  "summary",
  "profile",
  "about",
  "experience",
  "employment",
  "education",
  "skills",
  "projects",
  "certifications",
  "publications",
  "links",
]);
