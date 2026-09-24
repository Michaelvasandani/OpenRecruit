import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  type FindPeopleInput,
  type FindPeopleResult,
  type OutreachCategory,
  type OutreachCompany,
  type OutreachContact,
  type OutreachOrganization,
  OutreachPanel,
} from "@shared/outreach";
import type { CandidateProfileSummary, JobBoardRow, ScoutSummary } from "@shared/recruiting";
import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { outreachCompanies, outreachContacts } from "../../db/schema";
import { type ApolloClient, type ApolloPerson, normalizeDomain } from "./apollo";
import { RecruitingError } from "./errors";

/**
 * Candidate-triggered outreach help for one Job Board row: find the people
 * worth contacting about the role, then draft a short LinkedIn note to one of
 * them. OpenRecruit never sends anything; the Candidate opens LinkedIn and
 * decides. Only names and titles are stored — no email or phone is requested.
 *
 * Search spends no Apollo credits. Ranking is deterministic and explainable
 * (every suggestion carries its reason); only the note draft uses a model.
 */

const MAX_CONTACTS = 8;
const PER_SEARCH = 10;
/** Free LinkedIn accounts cap a connection note at 200 characters. */
export const NOTE_MAX_CHARS = 200;
const MAX_PROFILE_CHARS = 6_000;
const MAX_POSTING_CHARS = 2_000;
/** Founders are worth suggesting only while they plausibly still hire directly. */
const FOUNDER_MAX_EMPLOYEES = 200;

export type NoteDraftInput = {
  candidateProfile: string | null;
  role: { title: string; company: string | null; excerpt: string };
  person: { firstName: string; title: string | null; category: OutreachCategory };
  maxChars: number;
  /** Set on a retry after a draft came back too long. */
  previousDraft?: string;
};

export interface NoteDrafter {
  draft(input: NoteDraftInput): Promise<string>;
}

/** The recruiting reads outreach needs, kept narrow so tests can stub them. */
export interface OutreachRecruitingReads {
  jobBoardRow(signalId: string): JobBoardRow | null;
  getScout(id: string): ScoutSummary | null;
  listProfiles(): CandidateProfileSummary[];
}

type RoleFamily = { family: string; match: RegExp; titles: string[] };

/** Titles that lead or staff the team a role joins, by the role's family. The
 * first family whose pattern matches the posting title wins. */
const ROLE_FAMILIES: RoleFamily[] = [
  {
    family: "engineering",
    match:
      /\b(engineer(ing)?|developer|software|swe|sre|devops|ml|machine learning|ai|data|infra(structure)?|platform|back-?end|front-?end|full[- ]?stack|mobile|ios|android|security|firmware|embedded|research(er)?|scientist)\b/i,
    titles: [
      "engineering manager",
      "director of engineering",
      "head of engineering",
      "vp of engineering",
      "staff software engineer",
    ],
  },
  {
    family: "design",
    match: /\b(design(er)?|ux|ui)\b/i,
    titles: ["head of design", "design manager", "design director"],
  },
  {
    family: "product",
    match: /\bproduct\b/i,
    titles: ["head of product", "director of product", "group product manager"],
  },
  {
    family: "go-to-market",
    match:
      /\b(sales|account executive|business development|solutions|customer success|marketing|growth|partnerships)\b/i,
    titles: ["head of sales", "vp of sales", "head of growth", "head of marketing"],
  },
];
const FALLBACK_TEAM_TITLES = ["head of operations", "chief of staff", "general manager"];
const RECRUITING_TITLES = [
  "technical recruiter",
  "recruiter",
  "talent acquisition",
  "talent partner",
  "head of talent",
];
const FOUNDER_TITLES = ["founder", "co-founder", "ceo", "cto"];

const LEADER = /\b(manager|director|head|lead|vp|vice president|chief|cto|ceo|coo)\b/i;
const EXECUTIVE = /\b(vp|vice president|chief|cto|ceo|coo)\b/i;
const FOUNDER = /\b(co-?founder|founder)\b/i;
const RECRUITER = /\b(recruit(er|ing)|talent)\b/i;

/** Posting-title words too generic to say two roles share a specialty. */
const GENERIC_WORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "new",
  "grad",
  "graduate",
  "junior",
  "senior",
  "staff",
  "principal",
  "lead",
  "engineer",
  "engineering",
  "software",
  "developer",
  "manager",
  "intern",
  "internship",
  "early",
  "career",
  "remote",
  "hybrid",
  "full",
  "time",
  "contract",
  "head",
  "director",
  "team",
  "member",
  "technical",
  "level",
]);

export type OutreachServiceOptions = {
  now?: () => number;
  newId?: () => string;
};

export class OutreachService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly db: Db,
    private readonly recruiting: OutreachRecruitingReads,
    private readonly apollo: ApolloClient,
    private readonly drafter: NoteDrafter,
    options: OutreachServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  /** What the People section of a Job Board row shows. Read-only. */
  panel(signalId: string): OutreachPanel {
    const row = this.requireRow(signalId);
    const contacts = this.db
      .select()
      .from(outreachContacts)
      .where(eq(outreachContacts.signalId, signalId))
      .orderBy(desc(outreachContacts.score))
      .all();
    const companyKey = contacts[0]?.companyKey ?? (row.company ? companyKeyFor(row.company) : null);
    const company = companyKey ? this.company(companyKey) : null;
    return OutreachPanel.parse({
      signalId,
      companyName: row.company,
      company,
      contacts: contacts.map((contact) => toContact(contact, company?.companyName ?? row.company)),
      apolloConfigured: this.apollo.configured(),
    });
  }

  /**
   * Resolve the row's company to an Apollo organization (once per company),
   * search the people worth contacting, and keep the best few. A re-run keeps
   * the drafted notes of people it finds again.
   */
  async findPeople(input: FindPeopleInput): Promise<FindPeopleResult> {
    const row = this.requireRow(input.signalId);
    const resolved = await this.resolveCompany(row, input.company);
    if ("needs" in resolved) return resolved.needs;
    const company = resolved.company;

    const plan = searchPlan(row.title, company.employeeCount);
    const target = { organizationId: company.apolloOrganizationId, domain: company.domain };
    const found = new Map<string, Ranked>();
    for (const search of plan) {
      const people = await this.apollo.searchPeople({
        ...target,
        titles: search.titles,
        perPage: PER_SEARCH,
      });
      for (const person of people) {
        const ranked = rankPerson(person, row.title, company.employeeCount);
        if (!ranked) continue;
        const current = found.get(person.id);
        if (!current || ranked.score > current.score) found.set(person.id, ranked);
      }
    }
    const best = [...found.values()]
      .sort(
        (left, right) => right.score - left.score || left.person.id.localeCompare(right.person.id),
      )
      .slice(0, MAX_CONTACTS);

    const foundAt = this.now();
    this.db.transaction((tx) => {
      for (const { person, category, reason, score } of best) {
        const values = {
          companyKey: company.companyKey,
          firstName: person.firstName,
          lastName: person.lastName,
          lastNameMasked: person.lastNameMasked,
          title: person.title,
          category,
          reason,
          score,
          linkedinUrl: person.linkedinUrl,
          foundAt,
        };
        tx.insert(outreachContacts)
          .values({
            id: this.newId(),
            signalId: row.signalId,
            apolloPersonId: person.id,
            ...values,
          })
          .onConflictDoUpdate({
            target: [outreachContacts.signalId, outreachContacts.apolloPersonId],
            set: values,
          })
          .run();
      }
      const keep = best.map((entry) => entry.person.id);
      tx.delete(outreachContacts)
        .where(
          keep.length > 0
            ? and(
                eq(outreachContacts.signalId, row.signalId),
                notInArray(outreachContacts.apolloPersonId, keep),
              )
            : eq(outreachContacts.signalId, row.signalId),
        )
        .run();
    });
    return { status: "found", panel: this.panel(row.signalId) };
  }

  /** Draft (or redraft) a short LinkedIn connection note to one contact. */
  async draftNote(contactId: string): Promise<OutreachContact> {
    const contact = this.db
      .select()
      .from(outreachContacts)
      .where(eq(outreachContacts.id, contactId))
      .get();
    if (!contact) throw new RecruitingError("NOT_FOUND", `Contact ${contactId} was not found`);
    const row = this.requireRow(contact.signalId);
    const input: NoteDraftInput = {
      candidateProfile: this.candidateProfileFor(row),
      role: {
        title: row.title,
        company: row.company,
        excerpt: row.excerpt.slice(0, MAX_POSTING_CHARS),
      },
      person: {
        firstName: contact.firstName,
        title: contact.title,
        category: contact.category as OutreachCategory,
      },
      maxChars: NOTE_MAX_CHARS,
    };
    let note = cleanNote(await this.drafter.draft(input));
    if (note.length > NOTE_MAX_CHARS) {
      note = cleanNote(await this.drafter.draft({ ...input, previousDraft: note }));
    }
    note = fitNote(note, NOTE_MAX_CHARS);
    if (!note) {
      throw new RecruitingError(
        "VALIDATION",
        "The note draft came back empty",
        "malformed_content",
      );
    }
    this.db
      .update(outreachContacts)
      .set({ note, noteDraftedAt: this.now() })
      .where(eq(outreachContacts.id, contactId))
      .run();
    const company = this.company(contact.companyKey);
    const saved = this.db
      .select()
      .from(outreachContacts)
      .where(eq(outreachContacts.id, contactId))
      .get();
    if (!saved) throw new RecruitingError("NOT_FOUND", `Contact ${contactId} was not found`);
    return toContact(saved, company?.companyName ?? row.company);
  }

  private requireRow(signalId: string): JobBoardRow {
    const row = this.recruiting.jobBoardRow(signalId);
    if (!row) throw new RecruitingError("NOT_FOUND", `Job ${signalId} was not found`);
    return row;
  }

  private company(companyKey: string): OutreachCompany | null {
    const row = this.db
      .select()
      .from(outreachCompanies)
      .where(eq(outreachCompanies.companyKey, companyKey))
      .get();
    return row
      ? {
          companyKey: row.companyKey,
          companyName: row.companyName,
          apolloOrganizationId: row.apolloOrganizationId,
          domain: row.domain,
          employeeCount: row.employeeCount,
          linkedinUrl: row.linkedinUrl,
        }
      : null;
  }

  private async resolveCompany(
    row: JobBoardRow,
    choice: FindPeopleInput["company"],
  ): Promise<{ company: OutreachCompany } | { needs: FindPeopleResult }> {
    if (choice?.kind === "domain") {
      const domain = normalizeDomain(choice.domain);
      if (!domain) {
        throw new RecruitingError(
          "VALIDATION",
          "Enter the company's website domain, like acme.com",
          "invalid_input",
        );
      }
      return {
        company: this.saveCompany({
          companyKey: row.company ? companyKeyFor(row.company) : `domain:${domain}`,
          companyName: row.company ?? domain,
          apolloOrganizationId: null,
          domain,
          employeeCount: null,
          linkedinUrl: null,
        }),
      };
    }
    if (choice?.kind === "organization") {
      const organization = choice.organization;
      return {
        company: this.saveCompany({
          companyKey: companyKeyFor(row.company ?? organization.name),
          companyName: row.company ?? organization.name,
          apolloOrganizationId: organization.id,
          domain: organization.domain,
          employeeCount: organization.employeeCount,
          linkedinUrl: organization.linkedinUrl,
        }),
      };
    }

    if (!row.company) {
      return {
        needs: { status: "needs_company", reason: "no_company", companyName: null, matches: [] },
      };
    }
    const companyKey = companyKeyFor(row.company);
    const cached = this.company(companyKey);
    if (cached) return { company: cached };

    const matches = await this.apollo.searchOrganizations(row.company);
    const exact = matches.filter((match) => companyKeyFor(match.name) === companyKey);
    if (exact.length === 1) {
      const [organization] = exact;
      return {
        company: this.saveCompany({
          companyKey,
          companyName: row.company,
          apolloOrganizationId: organization.id,
          domain: organization.domain,
          employeeCount: organization.employeeCount,
          linkedinUrl: organization.linkedinUrl,
        }),
      };
    }
    return {
      needs: {
        status: "needs_company",
        reason: matches.length === 0 ? "not_found" : "ambiguous",
        companyName: row.company,
        matches: matches satisfies OutreachOrganization[],
      },
    };
  }

  private saveCompany(company: OutreachCompany): OutreachCompany {
    const values = { ...company, resolvedAt: this.now() };
    this.db
      .insert(outreachCompanies)
      .values(values)
      .onConflictDoUpdate({ target: outreachCompanies.companyKey, set: values })
      .run();
    return company;
  }

  /** The Profile of the first attributed Scout, else any Profile with a version. */
  private candidateProfileFor(row: JobBoardRow): string | null {
    const profiles = this.recruiting.listProfiles();
    const preferred = row.scouts
      .map((scout) => this.recruiting.getScout(scout.id)?.defaultProfileId ?? null)
      .find((id): id is string => id !== null);
    const profile =
      profiles.find((candidate) => candidate.id === preferred) ??
      profiles.find((candidate) => candidate.state === "confirmed") ??
      profiles[0];
    if (!profile) return null;
    const markdown = (profile.currentVersion?.markdown ?? profile.markdown).trim();
    const text = [
      profile.roleTarget.trim() ? `Target role: ${profile.roleTarget.trim()}` : "",
      markdown.slice(0, MAX_PROFILE_CHARS),
    ]
      .filter(Boolean)
      .join("\n\n");
    return text || null;
  }
}

type Ranked = { person: ApolloPerson; category: OutreachCategory; reason: string; score: number };

/** Normalized company identity: case, punctuation, and legal suffixes ignored. */
export function companyKeyFor(name: string): string {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|pbc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key || name.trim().toLowerCase();
}

/** The free searches to run for a role: its team, its recruiters, and — while
 * the company is small enough — its founders. */
export function searchPlan(
  roleTitle: string,
  employeeCount: number | null,
): Array<{ category: OutreachCategory; titles: string[] }> {
  const family = ROLE_FAMILIES.find((candidate) => candidate.match.test(roleTitle));
  const plan: Array<{ category: OutreachCategory; titles: string[] }> = [
    { category: "team", titles: family?.titles ?? FALLBACK_TEAM_TITLES },
    { category: "recruiting", titles: RECRUITING_TITLES },
  ];
  if (employeeCount === null || employeeCount <= FOUNDER_MAX_EMPLOYEES) {
    plan.push({ category: "founder", titles: FOUNDER_TITLES });
  }
  return plan;
}

function specialtyWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((word) => word.length >= 2 && !GENERIC_WORDS.has(word)),
  );
}

/**
 * Score one person for one role. The category comes from the person's own
 * title, not from which search found them; a title that fits no category is
 * dropped. Higher is better; the reason explains the score in one line.
 */
export function rankPerson(
  person: ApolloPerson,
  roleTitle: string,
  employeeCount: number | null,
): Ranked | null {
  const title = person.title ?? "";
  const size = employeeCount === null ? null : employeeCount;
  let category: OutreachCategory;
  let score: number;
  let reason: string;

  if (FOUNDER.test(title) || (/\b(ceo|cto)\b/i.test(title) && (size ?? 0) <= 50)) {
    category = "founder";
    if (size !== null && size > FOUNDER_MAX_EMPLOYEES) return null;
    score = size === null ? 2 : size <= 50 ? 3.5 : 2.5;
    reason =
      size === null
        ? "Founder — at smaller companies founders often hire directly"
        : `Founder at a ${size}-person company — often hires directly`;
  } else if (RECRUITER.test(title)) {
    category = "recruiting";
    const technical = /\btechnical\b/i.test(title);
    score = technical ? 3 : 2.5;
    reason = technical
      ? "Recruits technical roles — can route you to the hiring manager"
      : "Recruits for the company — can route you to the hiring manager";
  } else if (LEADER.test(title)) {
    category = "team";
    score = 3;
    reason = "Leads a related team — likely in this role's hiring chain";
    if (EXECUTIVE.test(title) && (size ?? 0) > 1_000) {
      score -= 1;
      reason = "Senior leader for this area — may be far from day-to-day hiring";
    }
  } else if (title) {
    category = "team";
    score = 2;
    reason = "Works on a related team — can share context or refer you";
  } else {
    return null;
  }

  const shared = [...specialtyWords(roleTitle)].filter((word) => specialtyWords(title).has(word));
  if (shared.length > 0 && category !== "recruiting") {
    score += Math.min(shared.length, 2) * 0.75;
    reason += ` · also works on ${shared.slice(0, 2).join(" and ")}`;
  }
  return { person, category, reason, score };
}

/** A LinkedIn people search that should surface the person. A masked last name
 * ("Mo***s") would only confuse the search, so it is left out. */
export function linkedinSearchUrl(
  firstName: string,
  lastName: string | null,
  lastNameMasked: boolean,
  companyName: string | null,
): string {
  const keywords = [firstName, lastNameMasked ? null : lastName, companyName]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
}

function toContact(
  row: typeof outreachContacts.$inferSelect,
  companyName: string | null,
): OutreachContact {
  const displayName = [row.firstName, row.lastName].filter(Boolean).join(" ");
  return {
    id: row.id,
    signalId: row.signalId,
    firstName: row.firstName,
    lastName: row.lastName,
    lastNameMasked: row.lastNameMasked,
    displayName,
    title: row.title,
    category: row.category as OutreachCategory,
    reason: row.reason,
    linkedinUrl: row.linkedinUrl,
    linkedinSearchUrl: linkedinSearchUrl(
      row.firstName,
      row.lastName,
      row.lastNameMasked,
      companyName,
    ),
    note: row.note,
    noteDraftedAt: row.noteDraftedAt,
    foundAt: row.foundAt,
  };
}

/** Strip wrapping quotes/fences and collapse whitespace. */
export function cleanNote(raw: string): string {
  return raw
    .replace(/^```[a-z]*\s*|\s*```$/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“'](.*)["”']$/s, "$1")
    .trim();
}

/** Keep a note within the limit, cutting at a sentence, else a word, boundary. */
export function fitNote(note: string, maxChars: number): string {
  if (note.length <= maxChars) return note;
  const head = note.slice(0, maxChars);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (sentence >= maxChars * 0.6) return head.slice(0, sentence + 1);
  const word = head.slice(0, maxChars - 1).lastIndexOf(" ");
  return `${head.slice(0, word > 0 ? word : maxChars - 1).trimEnd()}…`;
}

const CATEGORY_CONTEXT: Record<OutreachCategory, string> = {
  team: "They lead or work on the team this role likely joins.",
  recruiting: "They recruit for the company.",
  founder: "They founded the company, which is small enough that founders often hire directly.",
};

/** The drafting prompt. Everything in it is data for one short note. */
export function buildNotePrompt(input: NoteDraftInput): string {
  return [
    "Write one LinkedIn connection request note from a job candidate.",
    "",
    "Rules:",
    `- At most ${input.maxChars} characters in total. Count carefully.`,
    `- Address the recipient by first name (${input.person.firstName}).`,
    "- Name the specific role, and connect ONE concrete, true detail from the candidate's",
    "  background to it. Never invent experience, employers, schools, or mutual connections.",
    "- End with a light, specific ask (a quick chat, or who is hiring for the role).",
    "- Plain, warm, and direct: no flattery, no emojis, no hashtags, no subject line.",
    "- Output only the note text: no quotes, no preamble, no explanation.",
    ...(input.previousDraft
      ? [
          "",
          `Your previous draft was ${input.previousDraft.length} characters, over the limit.`,
          `Rewrite it shorter, under ${input.maxChars} characters:`,
          input.previousDraft,
        ]
      : []),
    "",
    "<recipient>",
    `First name: ${input.person.firstName}`,
    `Title: ${input.person.title ?? "unknown"}`,
    CATEGORY_CONTEXT[input.person.category],
    "</recipient>",
    "",
    "<role>",
    `Title: ${input.role.title}`,
    `Company: ${input.role.company ?? "unknown"}`,
    `Posting excerpt: ${input.role.excerpt || "none"}`,
    "</role>",
    "",
    "<candidate_profile>",
    input.candidateProfile ?? "No Candidate Profile is available; keep the note about the role.",
    "</candidate_profile>",
  ].join("\n");
}

export type ClaudeRunner = (
  args: string[],
  options: { env: Record<string, string>; cwd: string; timeoutMs: number },
) => Promise<string>;

const runClaude: ClaudeRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      "claude",
      args,
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/**
 * Drafts with the local `claude` CLI in one tool-less, non-persisted print
 * turn, under the same Claude login the Scouts use. It runs from a temp dir so
 * no project CLAUDE.md or agent workspace shapes the note.
 */
export class ClaudeNoteDrafter implements NoteDrafter {
  constructor(
    private readonly env: () => Record<string, string>,
    private readonly run: ClaudeRunner = runClaude,
    private readonly model = "sonnet",
  ) {}

  async draft(input: NoteDraftInput): Promise<string> {
    let stdout: string;
    try {
      stdout = await this.run(
        [
          "-p",
          buildNotePrompt(input),
          "--output-format",
          "json",
          "--model",
          this.model,
          "--tools",
          "",
          "--no-session-persistence",
        ],
        { env: this.env(), cwd: tmpdir(), timeoutMs: 120_000 },
      );
    } catch {
      throw new RecruitingError(
        "VALIDATION",
        "Claude could not draft the note; check that the claude CLI is installed and logged in",
        "provider_failure",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new RecruitingError(
        "VALIDATION",
        "Claude returned an unreadable draft",
        "malformed_content",
      );
    }
    const result =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { result?: unknown; is_error?: unknown })
        : {};
    if (result.is_error === true || typeof result.result !== "string") {
      throw new RecruitingError(
        "VALIDATION",
        "Claude could not draft the note",
        "provider_failure",
      );
    }
    return result.result;
  }
}
