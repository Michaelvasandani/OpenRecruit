import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Db, schema } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import { type MigrationDb, migrate } from "../../db/migrate";
import {
  CandidateProfileApplication,
  type ProfileArtifactStore,
  type ProfileFactInput,
} from "./profile";

function makeDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(SCHEMA_DDL);
  const migration: MigrationDb = {
    exec: (sql) => void sqlite.exec(sql),
    rows: (sql) => sqlite.query(sql).all(),
  };
  migrate(migration, { fresh: true });
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function artifacts(): { store: ProfileArtifactStore; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    store: {
      write(path, contents) {
        files.set(path, contents);
      },
    },
  };
}

describe("CandidateProfileApplication", () => {
  let app: CandidateProfileApplication | undefined;

  afterEach(() => app?.dispose());

  test("imports stable sections and preserves CV precedence while exposing GitHub conflicts", () => {
    const { store } = artifacts();
    app = new CandidateProfileApplication(makeDb(), {
      artifactStore: store,
      artifactPath: (profileId) => `/profiles/${profileId}.md`,
      now: () => 1000,
    });

    const draft = app.importProfile({
      name: "Morgan Candidate",
      roleTarget: "Staff engineer",
      cvText: [
        "Morgan Candidate",
        "Experience",
        "Built resilient TypeScript systems",
        "Skills: TypeScript, SQLite",
      ].join("\n"),
      github: {
        handle: "morgan",
        facts: [
          { section: "portfolio", key: "skills", value: "JavaScript, React" },
          { section: "portfolio", key: "projects", value: "Open source scheduler" },
        ],
      },
      careerInterests: "Developer tools\nDurable local systems",
      hardConstraints: ["Remote only"],
      preferences: ["Small product team"],
      idempotencyKey: "import-1",
    });

    expect(draft.state).toBe("draft");
    expect(draft.sections.map((section) => section.section)).toEqual([
      "cv",
      "portfolio",
      "career_interests",
      "hard_constraints",
      "preferences",
    ]);
    const facts = draft.sections.flatMap((section) => section.facts);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          section: "cv",
          key: "skills",
          value: "TypeScript, SQLite",
          source: "cv",
        }),
        expect.objectContaining({
          section: "portfolio",
          key: "skills",
          value: "JavaScript, React",
          source: "github",
          conflict: true,
        }),
        expect.objectContaining({ source: "github", value: "Open source scheduler" }),
      ]),
    );
    expect(draft.markdown).toContain("## CV Material");
    expect(draft.markdown).toContain("## Public Portfolio References");
    expect(draft.markdown).toContain("## Career Interests");
    expect(draft.markdown).toContain("## Hard Constraints");
    expect(draft.markdown).toContain("## Preferences");
  });

  test("lets review edit, remove, and add facts before confirming an immutable version", () => {
    const { store, files } = artifacts();
    app = new CandidateProfileApplication(makeDb(), {
      artifactStore: store,
      artifactPath: (profileId) => `/profiles/${profileId}.md`,
      now: () => 2000,
    });

    const imported = app.importProfile({
      name: "Morgan Candidate",
      roleTarget: "Staff engineer",
      cvText: "Experience\nBuilt systems",
      careerInterests: "Developer tools",
      idempotencyKey: "import-2",
    });
    const original = imported.sections.flatMap((section) => section.facts);
    const edited = app.updateDraft({
      profileId: imported.id,
      expectedRevision: imported.revision,
      removeFactIds: [original.find((fact) => fact.value === "Built systems")?.id ?? ""],
      addFacts: [
        {
          section: "preferences",
          key: "team",
          value: "Small team",
          source: "manual",
          sourceLabel: "Candidate",
        },
      ],
      idempotencyKey: "edit-1",
    });
    expect(edited.state).toBe("draft");
    expect(edited.sections.flatMap((section) => section.facts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "team", source: "manual" })]),
    );
    expect(edited.sections.flatMap((section) => section.facts)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "Built systems" })]),
    );

    const confirmed = app.confirmProfile({
      profileId: imported.id,
      expectedRevision: edited.revision,
      idempotencyKey: "confirm-1",
    });
    expect(confirmed.state).toBe("confirmed");
    expect(confirmed.currentVersion?.versionNo).toBe(1);
    expect(confirmed.currentVersion?.markdown).toBe(edited.markdown);
    expect(files.get(confirmed.artifactPath)).toBe(edited.markdown);

    const version = app.getVersion(confirmed.currentVersion?.id ?? "");
    expect(version?.immutable).toBe(true);
    expect(version?.facts).toEqual(confirmed.sections.flatMap((section) => section.facts));

    const versionCountBefore = app.listVersions(imported.id).length;
    const retry = app.confirmProfile({
      profileId: imported.id,
      expectedRevision: confirmed.revision,
      idempotencyKey: "confirm-unchanged",
    });
    expect(retry.currentVersion?.id).toBe(confirmed.currentVersion?.id);
    expect(app.listVersions(imported.id)).toHaveLength(versionCountBefore);
  });

  test("re-imports unchanged content without a duplicate and starts a new draft for changes", () => {
    const { store } = artifacts();
    app = new CandidateProfileApplication(makeDb(), {
      artifactStore: store,
      artifactPath: (profileId) => `/profiles/${profileId}.md`,
      now: () => 3000,
    });
    const input = {
      name: "Morgan Candidate",
      roleTarget: "Staff engineer",
      cvText: "Experience\nBuilt systems",
      careerInterests: "Developer tools",
      idempotencyKey: "import-3",
    } as const;
    const first = app.importProfile(input);
    const confirmed = app.confirmProfile({
      profileId: first.id,
      expectedRevision: first.revision,
      idempotencyKey: "confirm-3",
    });
    const unchanged = app.importProfile({ ...input, idempotencyKey: "import-4" });
    expect(unchanged.id).toBe(first.id);
    expect(unchanged.state).toBe("confirmed");
    expect(app.listVersions(first.id)).toHaveLength(1);

    const changed = app.importProfile({
      ...input,
      cvText: "Experience\nBuilt distributed systems",
      idempotencyKey: "import-5",
    });
    expect(changed.id).toBe(confirmed.id);
    expect(changed.state).toBe("draft");
    expect(changed.currentVersion?.id).toBe(confirmed.currentVersion?.id);
    expect(changed.markdown).toContain("Built distributed systems");
    const second = app.confirmProfile({
      profileId: changed.id,
      expectedRevision: changed.revision,
      idempotencyKey: "confirm-5",
    });
    expect(second.currentVersion?.versionNo).toBe(2);
    expect(app.listVersions(first.id)).toHaveLength(2);
    expect(app.getVersion(confirmed.currentVersion?.id ?? "")?.markdown).not.toContain(
      "Built distributed systems",
    );
  });

  test("supports a manual draft when CV and GitHub imports fail or are absent", () => {
    const { store } = artifacts();
    app = new CandidateProfileApplication(makeDb(), {
      artifactStore: store,
      artifactPath: (profileId) => `/profiles/${profileId}.md`,
      now: () => 4000,
    });
    const draft = app.importProfile({
      name: "Manual Candidate",
      roleTarget: "Product engineer",
      github: { handle: "bad handle" },
      careerInterests: "",
      idempotencyKey: "import-4",
    });
    expect(draft.state).toBe("draft");
    expect(draft.importWarnings).toEqual(expect.arrayContaining([expect.stringMatching(/GitHub/)]));
    const manual = app.updateDraft({
      profileId: draft.id,
      expectedRevision: draft.revision,
      addFacts: [
        {
          section: "cv",
          key: "summary",
          value: "Manual summary",
          source: "manual",
          sourceLabel: "Candidate",
        } satisfies ProfileFactInput,
      ],
      idempotencyKey: "manual-1",
    });
    expect(manual.sections.flatMap((section) => section.facts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "Manual summary" })]),
    );
  });
});
