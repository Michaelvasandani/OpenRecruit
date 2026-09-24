import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { CandidateProfileSummary, JobBoardRow, ScoutSummary } from "@shared/recruiting";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import * as schema from "../../db/schema";
import { ApolloClient, type ApolloFetch } from "./apollo";
import {
  buildNotePrompt,
  ClaudeNoteDrafter,
  cleanNote,
  companyKeyFor,
  fitNote,
  NOTE_MAX_CHARS,
  type NoteDrafter,
  type NoteDraftInput,
  OutreachService,
  rankPerson,
  searchPlan,
} from "./outreach";

// Foreign keys stay off: these tests stub the recruiting reads instead of
// recording real Signals, and exercise only the outreach tables.
function makeDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_DDL);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function row(overrides: Partial<JobBoardRow> = {}): JobBoardRow {
  return {
    signalId: "signal-1",
    title: "Infrastructure Engineer, New Grad",
    company: "Acme",
    author: null,
    url: "https://jobs.ashbyhq.com/acme/1",
    excerpt: "Build the platform that runs Acme's inference fleet.",
    sourceId: "source-ashby",
    sourceKind: "ashby",
    sourceName: "Ashby",
    scouts: [{ id: "scout-1", name: "New Grad Scout" }],
    fit: 0.9,
    experienceLevel: "entry_level",
    minimumYears: 0,
    publicationAt: null,
    observedAt: 1,
    freshness: "fresh",
    ...overrides,
  };
}

const PROFILE = {
  id: "profile-1",
  name: "Candidate",
  roleTarget: "Infrastructure engineer",
  state: "confirmed",
  markdown: "draft",
  currentVersion: { markdown: "Built a Kubernetes autoscaler at UCSD." },
} as unknown as CandidateProfileSummary;

function reads(rows: JobBoardRow[]) {
  return {
    jobBoardRow: (id: string) => rows.find((candidate) => candidate.signalId === id) ?? null,
    getScout: () => ({ defaultProfileId: "profile-1" }) as ScoutSummary,
    listProfiles: () => [PROFILE],
  };
}

type Person = { id: string; first_name: string; last_name_obfuscated?: string; title: string };

/** An Apollo stand-in: organizations by name, and people by requested title. */
function apolloStub(options: { organizations: Array<Record<string, unknown>>; people: Person[] }) {
  const calls: URL[] = [];
  const fetch: ApolloFetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname.endsWith("mixed_companies/search")) {
      return Response.json({ organizations: options.organizations });
    }
    const titles = parsed.searchParams.getAll("person_titles[]");
    const people = options.people.filter((person) =>
      titles.some((title) => person.title.toLowerCase().includes(title.split(" ")[0])),
    );
    return Response.json({ people });
  };
  return { client: new ApolloClient(() => "apollo-key", fetch), calls };
}

const ACME = {
  id: "org-acme",
  name: "Acme, Inc.",
  website_url: "https://acme.com",
  estimated_num_employees: 40,
};

const ACME_PEOPLE: Person[] = [
  {
    id: "p-em",
    first_name: "Maya",
    last_name_obfuscated: "Ch***n",
    title: "Engineering Manager, Infrastructure",
  },
  { id: "p-rec", first_name: "Sam", last_name_obfuscated: "Ri***a", title: "Technical Recruiter" },
  { id: "p-founder", first_name: "Ada", last_name_obfuscated: "Lo***e", title: "Co-Founder & CEO" },
];

class StubDrafter implements NoteDrafter {
  readonly inputs: NoteDraftInput[] = [];
  constructor(private readonly replies: string[]) {}
  async draft(input: NoteDraftInput): Promise<string> {
    this.inputs.push(input);
    return this.replies.shift() ?? "";
  }
}

describe("OutreachService", () => {
  test("resolves the company once, ranks team, recruiting, and founder contacts, and keeps notes on re-run", async () => {
    const db = makeDb();
    const apollo = apolloStub({ organizations: [ACME], people: ACME_PEOPLE });
    let id = 0;
    const service = new OutreachService(
      db,
      reads([row()]),
      apollo.client,
      new StubDrafter(["Hi"]),
      {
        now: () => 1_000,
        newId: () => `contact-${++id}`,
      },
    );

    const result = await service.findPeople({ signalId: "signal-1" });
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    const { panel } = result;
    expect(panel.company).toMatchObject({
      companyName: "Acme",
      apolloOrganizationId: "org-acme",
      domain: "acme.com",
      employeeCount: 40,
    });
    // The EM of the role's own specialty first; at a 40-person company the
    // founder, who hires directly, outranks the recruiter.
    expect(panel.contacts.map((contact) => [contact.displayName, contact.category])).toEqual([
      ["Maya Ch***n", "team"],
      ["Ada Lo***e", "founder"],
      ["Sam Ri***a", "recruiting"],
    ]);
    expect(panel.contacts[0].reason).toContain("also works on infrastructure");
    expect(panel.contacts[1].reason).toBe("Founder at a 40-person company — often hires directly");
    // The masked last name never reaches the LinkedIn search.
    expect(panel.contacts[0].linkedinSearchUrl).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=Maya%20Acme",
    );
    // One organization lookup, then team + recruiting + founder searches.
    expect(apollo.calls.map((call) => call.pathname.split("/").pop())).toEqual([
      "search",
      "api_search",
      "api_search",
      "api_search",
    ]);
    expect(apollo.calls[1].searchParams.getAll("organization_ids[]")).toEqual(["org-acme"]);

    const maya = panel.contacts[0];
    await service.draftNote(maya.id);

    // A re-run reuses the cached company, keeps Maya's note, and drops people no longer found.
    const smaller = apolloStub({ organizations: [], people: ACME_PEOPLE.slice(0, 1) });
    const rerun = new OutreachService(db, reads([row()]), smaller.client, new StubDrafter([]));
    const again = await rerun.findPeople({ signalId: "signal-1" });
    if (again.status !== "found") throw new Error("expected found");
    expect(smaller.calls.some((call) => call.pathname.endsWith("mixed_companies/search"))).toBe(
      false,
    );
    expect(again.panel.contacts).toHaveLength(1);
    expect(again.panel.contacts[0]).toMatchObject({ id: maya.id, note: "Hi" });
  });

  test("asks the Candidate to choose when Apollo's matches are ambiguous, then uses the choice", async () => {
    const db = makeDb();
    const apollo = apolloStub({
      organizations: [
        { id: "org-a", name: "Acme Robotics", primary_domain: "acmerobotics.io" },
        { id: "org-b", name: "Acme Health", primary_domain: "acmehealth.com" },
      ],
      people: ACME_PEOPLE,
    });
    const service = new OutreachService(db, reads([row()]), apollo.client, new StubDrafter([]));

    const first = await service.findPeople({ signalId: "signal-1" });
    expect(first).toMatchObject({
      status: "needs_company",
      reason: "ambiguous",
      companyName: "Acme",
    });
    if (first.status !== "needs_company") throw new Error("unreachable");
    expect(first.matches.map((match) => match.id)).toEqual(["org-a", "org-b"]);

    const chosen = await service.findPeople({
      signalId: "signal-1",
      company: { kind: "organization", organization: first.matches[1] },
    });
    expect(chosen.status).toBe("found");
    expect(apollo.calls.at(-1)?.searchParams.getAll("organization_ids[]")).toEqual(["org-b"]);
    // The choice is remembered for the next row at the same company.
    expect(service.panel("signal-1").company?.apolloOrganizationId).toBe("org-b");
  });

  test("searches by a Candidate-entered domain when the row names no company", async () => {
    const db = makeDb();
    const apollo = apolloStub({ organizations: [], people: ACME_PEOPLE });
    const service = new OutreachService(
      db,
      reads([row({ company: null, author: "@founder" })]),
      apollo.client,
      new StubDrafter([]),
    );

    expect(await service.findPeople({ signalId: "signal-1" })).toEqual({
      status: "needs_company",
      reason: "no_company",
      companyName: null,
      matches: [],
    });
    expect(apollo.calls).toHaveLength(0);

    await expect(
      service.findPeople({ signalId: "signal-1", company: { kind: "domain", domain: "nope" } }),
    ).rejects.toThrow(/website domain/);
    const found = await service.findPeople({
      signalId: "signal-1",
      company: { kind: "domain", domain: "https://www.Acme.com" },
    });
    if (found.status !== "found") throw new Error("expected found");
    expect(found.panel.company).toMatchObject({
      companyKey: "domain:acme.com",
      domain: "acme.com",
    });
    expect(apollo.calls[0].searchParams.getAll("q_organization_domains_list[]")).toEqual([
      "acme.com",
    ]);
  });

  test("drafts a note from the Profile and role, retrying once when it runs long", async () => {
    const db = makeDb();
    const apollo = apolloStub({ organizations: [ACME], people: ACME_PEOPLE });
    const long = `"${"I would love to chat about the infrastructure role. ".repeat(6)}"`;
    const drafter = new StubDrafter([
      long,
      "Hi Maya, I built a Kubernetes autoscaler at UCSD and would love to hear how your team runs Acme's inference fleet. Open to a quick chat?",
    ]);
    const service = new OutreachService(db, reads([row()]), apollo.client, drafter);
    const found = await service.findPeople({ signalId: "signal-1" });
    if (found.status !== "found") throw new Error("expected found");
    const maya = found.panel.contacts.find((contact) => contact.firstName === "Maya");
    if (!maya) throw new Error("expected Maya");

    const drafted = await service.draftNote(maya.id);
    expect(drafted.note).toStartWith("Hi Maya, I built a Kubernetes autoscaler");
    expect(drafted.note?.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
    expect(drafted.noteDraftedAt).not.toBeNull();
    expect(drafter.inputs).toHaveLength(2);
    expect(drafter.inputs[0]).toMatchObject({
      candidateProfile:
        "Target role: Infrastructure engineer\n\nBuilt a Kubernetes autoscaler at UCSD.",
      role: { title: "Infrastructure Engineer, New Grad", company: "Acme" },
      person: { firstName: "Maya", category: "team" },
      maxChars: NOTE_MAX_CHARS,
    });
    expect(drafter.inputs[1].previousDraft).toBe(cleanNote(long));
    await expect(service.draftNote("missing")).rejects.toThrow(/not found/);
  });

  test("refuses rows that do not exist", () => {
    const service = new OutreachService(
      makeDb(),
      reads([]),
      apolloStub({ organizations: [], people: [] }).client,
      new StubDrafter([]),
    );
    expect(() => service.panel("missing")).toThrow(/not found/);
  });
});

describe("ranking", () => {
  const person = (title: string) => ({
    id: title,
    firstName: "X",
    lastName: null,
    lastNameMasked: false,
    title,
    organizationName: null,
    linkedinUrl: null,
    hasEmail: null,
  });

  test("plans founder searches only while the company is small", () => {
    expect(searchPlan("Backend Engineer", 40).map((step) => step.category)).toEqual([
      "team",
      "recruiting",
      "founder",
    ]);
    expect(searchPlan("Backend Engineer", 5_000).map((step) => step.category)).toEqual([
      "team",
      "recruiting",
    ]);
    expect(searchPlan("Product Designer", null)[0].titles).toContain("head of design");
    expect(searchPlan("Office Coordinator", null)[0].titles).toContain("chief of staff");
  });

  test("prefers people close to the hiring decision", () => {
    const em = rankPerson(person("Engineering Manager, ML Platform"), "ML Engineer", 3_000);
    const vp = rankPerson(person("VP of Engineering"), "ML Engineer", 3_000);
    const peer = rankPerson(person("Software Engineer"), "ML Engineer", 3_000);
    const bigFounder = rankPerson(person("Founder"), "ML Engineer", 3_000);
    expect(em?.category).toBe("team");
    expect(em?.reason).toContain("also works on ml");
    expect((em?.score ?? 0) > (vp?.score ?? 0)).toBe(true);
    expect((vp?.score ?? 0) >= (peer?.score ?? 0)).toBe(true);
    expect(vp?.reason).toContain("far from day-to-day hiring");
    expect(bigFounder).toBeNull();
    expect(rankPerson({ ...person(""), title: null }, "ML Engineer", 10)).toBeNull();
  });

  test("normalizes company names and keeps notes within the limit", () => {
    expect(companyKeyFor("Acme, Inc.")).toBe(companyKeyFor("ACME"));
    expect(cleanNote('```\n"Hi   there"\n```')).toBe("Hi there");
    expect(fitNote("Short.", 200)).toBe("Short.");
    const fitted = fitNote(`${"word ".repeat(60)}end`, 200);
    expect(fitted.length).toBeLessThanOrEqual(200);
    expect(fitted.endsWith("…")).toBe(true);
    expect(fitNote(`${"A sentence here. ".repeat(20)}`, 200)).toMatch(/\.$/);
  });
});

describe("ClaudeNoteDrafter", () => {
  const input: NoteDraftInput = {
    candidateProfile: "Built things.",
    role: { title: "Backend Engineer", company: "Acme", excerpt: "APIs" },
    person: { firstName: "Maya", title: "Engineering Manager", category: "team" },
    maxChars: 200,
  };

  test("runs one tool-less, non-persisted print turn and returns its result", async () => {
    const seen: string[][] = [];
    const drafter = new ClaudeNoteDrafter(
      () => ({ PATH: "/bin" }),
      async (args) => {
        seen.push(args);
        return JSON.stringify({ type: "result", is_error: false, result: "Hi Maya" });
      },
    );
    expect(await drafter.draft(input)).toBe("Hi Maya");
    const [args] = seen;
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe(buildNotePrompt(input));
    expect(args.slice(2)).toEqual([
      "--output-format",
      "json",
      "--model",
      "sonnet",
      "--tools",
      "",
      "--no-session-persistence",
    ]);
    expect(args[1]).toContain("<candidate_profile>\nBuilt things.");
    expect(args[1]).toContain("At most 200 characters");
  });

  test("turns CLI failures and error results into safe errors", async () => {
    const failing = new ClaudeNoteDrafter(
      () => ({}),
      async () => {
        throw new Error("spawn claude ENOENT");
      },
    );
    await expect(failing.draft(input)).rejects.toThrow(/installed and logged in/);
    const erroring = new ClaudeNoteDrafter(
      () => ({}),
      async () => JSON.stringify({ is_error: true, result: "Credit balance is too low" }),
    );
    await expect(erroring.draft(input)).rejects.toThrow(/could not draft the note/);
    const garbled = new ClaudeNoteDrafter(
      () => ({}),
      async () => "not json",
    );
    await expect(garbled.draft(input)).rejects.toThrow(/unreadable/);
  });
});
