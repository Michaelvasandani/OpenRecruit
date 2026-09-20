import { describe, expect, test } from "bun:test";
import type { SignalSummary } from "@shared/recruiting";
import { deriveCompany, toJobBoardRow } from "./job-board";

function signal(overrides: {
  title?: string;
  content?: string;
  canonicalUrl?: string | null;
  fitJudgment?: SignalSummary["evidence"]["fitJudgment"];
  author?: SignalSummary["evidence"]["author"];
  attributions?: Array<{ scoutId: string }>;
}): SignalSummary {
  return {
    id: "signal-1",
    sourceId: "source-ashby",
    scoutId: "scout-1",
    publicationAt: 1_000,
    observedAt: 2_000,
    freshness: "fresh",
    canonicalUrl: overrides.canonicalUrl ?? null,
    evidence: {
      title: overrides.title ?? "Software Engineer",
      content: overrides.content ?? "About the role",
      canonicalUrl: overrides.canonicalUrl ?? null,
      fitJudgment: overrides.fitJudgment,
      author: overrides.author,
    },
    attributions: (overrides.attributions ?? [{ scoutId: "scout-1" }]).map((a) => ({
      ...a,
      runId: "run-1",
      strategyKey: null,
      strategyMaterial: "",
      createdAt: 2_000,
    })),
  } as unknown as SignalSummary;
}

const lookups = {
  sources: new Map([["source-ashby", { kind: "ashby", name: "Ashby" }]]),
  scouts: new Map([
    ["scout-1", "Please Ashby"],
    ["scout-2", "ASHBY SF"],
  ]),
};

describe("deriveCompany", () => {
  test("reads the organization from an Ashby posting URL", () => {
    expect(deriveCompany("Data Engineer", "https://jobs.ashbyhq.com/retell-ai/161bcfc9")).toBe(
      "Retell Ai",
    );
  });

  test("prefers an explicit '@ Company' title suffix", () => {
    expect(
      deriveCompany(
        "Software Engineer, Early Career (AI) @ Notion",
        "https://jobs.ashbyhq.com/notion/8594",
      ),
    ).toBe("Notion");
  });

  test("reads 'Company (YC X00) Is Hiring' titles", () => {
    expect(
      deriveCompany("Cekura (YC F24) Is Hiring", "https://news.ycombinator.com/item?id=1"),
    ).toBe("Cekura");
  });

  test('reads "At Company ... we\'re hiring" openers', () => {
    expect(
      deriveCompany("At Tether (https://tether.io/) we're hiring! We envision a world", null),
    ).toBe("Tether");
  });

  test("is null when nothing attributable is present", () => {
    expect(deriveCompany("@someone", "https://x.com/someone/status/1")).toBeNull();
  });
});

describe("toJobBoardRow", () => {
  test("projects a judged Ashby Signal into a board row", () => {
    const row = toJobBoardRow(
      signal({
        title: "Applied AI Engineer",
        content: "ABOUT ORPEX\n\nThe next generation of service companies.",
        canonicalUrl: "https://jobs.ashbyhq.com/orpex/af6f",
        fitJudgment: {
          model: "jev-latest",
          requiredExperience: {
            level: "two_years",
            minimumYears: 2,
            confidence: 0.9,
            probabilities: {},
          },
          scoutFitProbability: 0.87,
        },
      }),
      lookups,
    );

    expect(row).toMatchObject({
      signalId: "signal-1",
      title: "Applied AI Engineer",
      company: "Orpex",
      url: "https://jobs.ashbyhq.com/orpex/af6f",
      excerpt: "ABOUT ORPEX The next generation of service companies.",
      sourceKind: "ashby",
      sourceName: "Ashby",
      scouts: [{ id: "scout-1", name: "Please Ashby" }],
      fit: 0.87,
      experienceLevel: "two_years",
      minimumYears: 2,
      publicationAt: 1_000,
      observedAt: 2_000,
    });
  });

  test("leaves fit and experience empty for an unjudged Signal", () => {
    const row = toJobBoardRow(signal({}), lookups);
    expect(row.fit).toBeNull();
    expect(row.experienceLevel).toBeNull();
    expect(row.minimumYears).toBeNull();
  });

  test("lists every Scout that found the Signal once", () => {
    const row = toJobBoardRow(
      signal({
        attributions: [{ scoutId: "scout-1" }, { scoutId: "scout-2" }, { scoutId: "scout-1" }],
      }),
      lookups,
    );
    expect(row.scouts.map((s) => s.name)).toEqual(["Please Ashby", "ASHBY SF"]);
  });

  test("titles an X post by its first line instead of the author handle", () => {
    const row = toJobBoardRow(
      signal({
        title: "@RigneySec",
        content: "SubImage (YC W25) Is Hiring a Founding Engineer in SF https://t.co/x\n\nmore",
        author: { id: "1", username: "RigneySec", name: "Rigney" },
      }),
      lookups,
    );
    expect(row.title).toBe("SubImage (YC W25) Is Hiring a Founding Engineer in SF https://t.co/x");
    expect(row.company).toBe("SubImage");
    expect(row.author).toBe("@RigneySec");
  });

  test("keeps the author handle as the title when the post text is withheld", () => {
    const row = toJobBoardRow(
      signal({
        title: "@RigneySec",
        content: "",
        author: { id: "1", username: "RigneySec", name: null },
      }),
      lookups,
    );
    expect(row.title).toBe("@RigneySec");
  });

  test("moves an '@ Company' title suffix into the company column", () => {
    const row = toJobBoardRow(
      signal({ title: "Software Engineer, Early Career (AI) @ Notion" }),
      lookups,
    );
    expect(row.title).toBe("Software Engineer, Early Career (AI)");
    expect(row.company).toBe("Notion");
  });
});
