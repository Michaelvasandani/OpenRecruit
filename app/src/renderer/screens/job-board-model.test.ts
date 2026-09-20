import { describe, expect, test } from "bun:test";
import type { JobBoardRow } from "@shared/recruiting";
import {
  compactWhen,
  experienceLabel,
  groupByScout,
  sourceOptions,
  viewRows,
} from "./job-board-model";

function row(overrides: Partial<JobBoardRow> & { signalId: string }): JobBoardRow {
  return {
    title: "Software Engineer",
    company: null,
    author: null,
    url: null,
    excerpt: "",
    sourceId: "source-ashby",
    sourceKind: "ashby",
    sourceName: "Ashby",
    scouts: [{ id: "scout-1", name: "Please Ashby" }],
    fit: null,
    experienceLevel: null,
    minimumYears: null,
    publicationAt: null,
    observedAt: 0,
    freshness: "fresh",
    ...overrides,
  };
}

const rows = [
  row({ signalId: "a", title: "Data Engineer", company: "Campfire", fit: 0.6, observedAt: 30 }),
  row({ signalId: "b", title: "Applied AI Engineer", company: "Orpex", fit: 0.9, observedAt: 10 }),
  row({
    signalId: "c",
    title: "Founding Engineer",
    sourceId: "source-hn",
    sourceKind: "hacker_news",
    sourceName: "Hacker News",
    scouts: [{ id: "scout-2", name: "HN SCOUT 2" }],
    observedAt: 20,
  }),
];
const all = { query: "", sourceId: null };

describe("viewRows", () => {
  test("sorts by fit descending with unjudged rows last", () => {
    const sorted = viewRows(rows, all, { key: "fit", direction: "desc" });
    expect(sorted.map((r) => r.signalId)).toEqual(["b", "a", "c"]);
  });

  test("keeps unjudged rows last when the fit sort is reversed", () => {
    const sorted = viewRows(rows, all, { key: "fit", direction: "asc" });
    expect(sorted.map((r) => r.signalId)).toEqual(["a", "b", "c"]);
  });

  test("sorts text columns case-insensitively", () => {
    const sorted = viewRows(rows, all, { key: "title", direction: "asc" });
    expect(sorted.map((r) => r.signalId)).toEqual(["b", "a", "c"]);
  });

  test("filters by Source and by a query over title, company, Scout, and excerpt", () => {
    const sort = { key: "observedAt", direction: "desc" } as const;
    expect(
      viewRows(rows, { query: "", sourceId: "source-hn" }, sort).map((r) => r.signalId),
    ).toEqual(["c"]);
    expect(viewRows(rows, { query: "orpex", sourceId: null }, sort).map((r) => r.signalId)).toEqual(
      ["b"],
    );
    expect(
      viewRows(rows, { query: "hn scout", sourceId: null }, sort).map((r) => r.signalId),
    ).toEqual(["c"]);
  });
});

test("sourceOptions lists each Source once with its row count", () => {
  expect(sourceOptions(rows)).toEqual([
    { id: "source-ashby", name: "Ashby", count: 2 },
    { id: "source-hn", name: "Hacker News", count: 1 },
  ]);
});

test("groupByScout keeps row order and files a shared Signal under each Scout", () => {
  const shared = row({
    signalId: "d",
    scouts: [
      { id: "scout-1", name: "Please Ashby" },
      { id: "scout-2", name: "HN SCOUT 2" },
    ],
  });
  const groups = groupByScout([...rows, shared]);
  expect(groups.map((g) => [g.name, g.rows.map((r) => r.signalId)])).toEqual([
    ["Please Ashby", ["a", "b", "d"]],
    ["HN SCOUT 2", ["c", "d"]],
  ]);
});

test("experienceLabel is readable and blank when unjudged", () => {
  expect(experienceLabel("entry_level")).toBe("Entry level");
  expect(experienceLabel("five_plus_years")).toBe("5+ years");
  expect(experienceLabel("not_stated")).toBe("Not stated");
  expect(experienceLabel(null)).toBe("—");
});

test("compactWhen stays short enough for a narrow column", () => {
  const now = new Date("2026-09-19T12:00:00").getTime();
  expect(compactWhen(null, now)).toBe("—");
  expect(compactWhen(now - 5 * 60_000, now)).toBe("5m ago");
  expect(compactWhen(now - 3 * 3_600_000, now)).toBe("3h ago");
  expect(compactWhen(now - 16 * 86_400_000, now)).toBe("16d ago");
  expect(compactWhen(new Date("2026-06-29T11:11:00").getTime(), now)).toBe("Jun 29");
  expect(compactWhen(new Date("2025-12-02T09:00:00").getTime(), now)).toBe("Dec 2, 2025");
});
