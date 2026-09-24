import { RecruitingError } from "./errors";

/**
 * Host-owned Apollo.io client for Candidate-triggered people search.
 *
 * Only two endpoints are used, and neither reveals contact details:
 *  - Organization Search (`mixed_companies/search`) turns a company name from a
 *    Job Board row into an Apollo organization. The chosen organization is cached
 *    per company, so this runs at most once per company.
 *  - People API Search (`mixed_people/api_search`) lists people at that
 *    organization. It spends no credits and returns names (Apollo masks the last
 *    name on lower plans), titles, and a `has_email` flag — never emails or phones.
 *
 * Enrichment (which reveals emails and costs credits) is deliberately absent:
 * the Candidate finds the person on LinkedIn instead. Response bodies are
 * untrusted and parsed field by field; nothing outside the shapes below crosses
 * this seam.
 */

const APOLLO_API = "https://api.apollo.io/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ORGANIZATION_MATCHES = 5;
const MAX_TEXT = 200;

export type ApolloOrganization = {
  id: string;
  name: string;
  domain: string | null;
  employeeCount: number | null;
  linkedinUrl: string | null;
};

export type ApolloPerson = {
  id: string;
  firstName: string;
  /** Full last name when the plan returns it, else Apollo's masked form ("Mo***s"). */
  lastName: string | null;
  lastNameMasked: boolean;
  title: string | null;
  organizationName: string | null;
  linkedinUrl: string | null;
  hasEmail: boolean | null;
};

export type ApolloPeopleQuery = {
  /** Exactly one of organizationId or domain identifies the company. */
  organizationId?: string | null;
  domain?: string | null;
  titles?: readonly string[];
  seniorities?: readonly string[];
  perPage?: number;
};

export type ApolloFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ApolloClient {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly fetchImpl: ApolloFetch = fetch,
  ) {}

  configured(): boolean {
    return Boolean(this.apiKey());
  }

  async searchOrganizations(name: string): Promise<ApolloOrganization[]> {
    const params = new URLSearchParams();
    params.set("q_organization_name", name.slice(0, MAX_TEXT));
    params.set("page", "1");
    params.set("per_page", String(MAX_ORGANIZATION_MATCHES));
    const body = await this.post(`mixed_companies/search?${params}`);
    const rows = [...array(body, "organizations"), ...array(body, "accounts")];
    const seen = new Set<string>();
    const organizations: ApolloOrganization[] = [];
    for (const row of rows) {
      const organization = parseOrganization(row);
      if (!organization || seen.has(organization.id)) continue;
      seen.add(organization.id);
      organizations.push(organization);
    }
    return organizations.slice(0, MAX_ORGANIZATION_MATCHES);
  }

  async searchPeople(query: ApolloPeopleQuery): Promise<ApolloPerson[]> {
    const params = new URLSearchParams();
    if (query.organizationId) params.append("organization_ids[]", query.organizationId);
    else if (query.domain) params.append("q_organization_domains_list[]", query.domain);
    else throw new RecruitingError("VALIDATION", "People search needs a company", "invalid_input");
    for (const title of query.titles ?? []) params.append("person_titles[]", title);
    if ((query.titles ?? []).length > 0) params.set("include_similar_titles", "true");
    for (const seniority of query.seniorities ?? []) {
      params.append("person_seniorities[]", seniority);
    }
    params.set("page", "1");
    params.set("per_page", String(Math.min(Math.max(query.perPage ?? 10, 1), 25)));
    const body = await this.post(`mixed_people/api_search?${params}`);
    return array(body, "people").flatMap((row) => {
      const person = parsePerson(row);
      return person ? [person] : [];
    });
  }

  private async post(path: string): Promise<unknown> {
    const apiKey = this.apiKey();
    if (!apiKey) {
      throw new RecruitingError(
        "VALIDATION",
        "Add an Apollo API key in Settings to find people",
        "missing_configuration",
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${APOLLO_API}/${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "cache-control": "no-cache",
          "x-api-key": apiKey,
        },
        body: "{}",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new RecruitingError(
        "VALIDATION",
        timedOut ? "Apollo did not answer in time" : "Apollo could not be reached",
        timedOut ? "timed_out" : "provider_failure",
      );
    }
    if (response.status >= 200 && response.status < 300) {
      return response.json().catch(() => {
        throw new RecruitingError(
          "VALIDATION",
          "Apollo returned an unreadable response",
          "malformed_content",
        );
      });
    }
    throw failureFor(response.status);
  }
}

function failureFor(status: number): RecruitingError {
  if (status === 401) {
    return new RecruitingError(
      "VALIDATION",
      "Apollo rejected the configured API key",
      "invalid_authentication",
    );
  }
  if (status === 403) {
    // Apollo answers 403 when the key or plan does not include the endpoint.
    return new RecruitingError(
      "VALIDATION",
      "Apollo refused this search for the configured key; check the key's endpoint access and plan",
      "invalid_authentication",
    );
  }
  if (status === 429) {
    return new RecruitingError("VALIDATION", "Apollo is temporarily rate limited", "rate_limited");
  }
  if (status === 422 || status === 400) {
    return new RecruitingError("VALIDATION", "Apollo rejected the search", "invalid_input");
  }
  return new RecruitingError("VALIDATION", "Apollo is temporarily unavailable", "provider_failure");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(body: unknown, key: string): unknown[] {
  if (!isRecord(body)) return [];
  const value = body[key];
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
}

/** Only public LinkedIn profile or company URLs are kept. */
function linkedinUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    url.protocol = "https:";
    return url.toString();
  } catch {
    return null;
  }
}

/** A bare hostname: `https://www.Acme.com/about` → `acme.com`. */
export function normalizeDomain(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function parseOrganization(row: unknown): ApolloOrganization | null {
  if (!isRecord(row)) return null;
  const id = text(row.id) ?? text(row.organization_id);
  const name = text(row.name);
  if (!id || !name) return null;
  const employees = row.estimated_num_employees;
  return {
    id,
    name,
    domain: normalizeDomain(row.primary_domain) ?? normalizeDomain(row.website_url),
    employeeCount:
      typeof employees === "number" && Number.isFinite(employees) && employees >= 0
        ? Math.round(employees)
        : null,
    linkedinUrl: linkedinUrl(row.linkedin_url),
  };
}

function parsePerson(row: unknown): ApolloPerson | null {
  if (!isRecord(row)) return null;
  const id = text(row.id);
  const firstName = text(row.first_name);
  if (!id || !firstName) return null;
  const fullLastName = text(row.last_name);
  const maskedLastName = text(row.last_name_obfuscated);
  const organization = isRecord(row.organization) ? row.organization : null;
  return {
    id,
    firstName,
    lastName: fullLastName ?? maskedLastName,
    lastNameMasked: fullLastName === null && maskedLastName !== null,
    title: text(row.title),
    organizationName: text(organization?.name),
    linkedinUrl: linkedinUrl(row.linkedin_url),
    hasEmail: typeof row.has_email === "boolean" ? row.has_email : null,
  };
}
