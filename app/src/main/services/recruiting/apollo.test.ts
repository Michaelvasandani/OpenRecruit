import { describe, expect, test } from "bun:test";
import { ApolloClient, type ApolloFetch, normalizeDomain } from "./apollo";

type Call = { url: string; init: RequestInit };

function stubFetch(respond: (url: string) => { status: number; body?: unknown }): {
  fetch: ApolloFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const { status, body } = respond(url);
      return new Response(JSON.stringify(body ?? {}), { status });
    },
  };
}

/** Shaped like Apollo's People API Search response on a plan that masks last names. */
const PEOPLE_RESPONSE = {
  total_entries: 3,
  people: [
    {
      id: "p-1",
      first_name: "Maya",
      last_name_obfuscated: "Ch***n",
      title: "Engineering Manager, Infrastructure",
      has_email: true,
      organization: { name: "Acme" },
    },
    {
      id: "p-2",
      first_name: "Sam",
      last_name: "Rivera",
      title: "Technical Recruiter",
      linkedin_url: "http://www.linkedin.com/in/samrivera",
      has_email: false,
    },
    // Unusable rows are dropped, not trusted.
    { id: "p-3", title: "No name" },
    "not a person",
  ],
};

describe("ApolloClient", () => {
  test("searches people by organization with titles, sending the key only as a header", async () => {
    const stub = stubFetch(() => ({ status: 200, body: PEOPLE_RESPONSE }));
    const client = new ApolloClient(() => "apollo-key", stub.fetch);

    const people = await client.searchPeople({
      organizationId: "org-1",
      titles: ["engineering manager", "director of engineering"],
      perPage: 10,
    });

    expect(people).toEqual([
      {
        id: "p-1",
        firstName: "Maya",
        lastName: "Ch***n",
        lastNameMasked: true,
        title: "Engineering Manager, Infrastructure",
        organizationName: "Acme",
        linkedinUrl: null,
        hasEmail: true,
      },
      {
        id: "p-2",
        firstName: "Sam",
        lastName: "Rivera",
        lastNameMasked: false,
        title: "Technical Recruiter",
        organizationName: null,
        linkedinUrl: "https://www.linkedin.com/in/samrivera",
        hasEmail: false,
      },
    ]);
    const [call] = stub.calls;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe("https://api.apollo.io/api/v1/mixed_people/api_search");
    expect(url.searchParams.getAll("organization_ids[]")).toEqual(["org-1"]);
    expect(url.searchParams.getAll("person_titles[]")).toEqual([
      "engineering manager",
      "director of engineering",
    ]);
    expect(url.searchParams.get("include_similar_titles")).toBe("true");
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(call.url).not.toContain("apollo-key");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["x-api-key"]).toBe("apollo-key");
  });

  test("falls back to a company domain when no organization is known", async () => {
    const stub = stubFetch(() => ({ status: 200, body: { people: [] } }));
    const client = new ApolloClient(() => "apollo-key", stub.fetch);
    await client.searchPeople({ domain: "acme.com", titles: [] });
    const url = new URL(stub.calls[0].url);
    expect(url.searchParams.getAll("q_organization_domains_list[]")).toEqual(["acme.com"]);
    expect(url.searchParams.has("include_similar_titles")).toBe(false);
    await expect(client.searchPeople({ titles: ["cto"] })).rejects.toThrow(/needs a company/);
  });

  test("parses organizations from both result arrays, deduplicated, with bare domains", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: {
        organizations: [
          {
            id: "org-1",
            name: "Acme",
            website_url: "http://www.acme.com",
            estimated_num_employees: 42,
            linkedin_url: "http://www.linkedin.com/company/acme",
          },
          { id: "org-2", name: "Acme Robotics", primary_domain: "acmerobotics.io" },
          { name: "missing id" },
        ],
        accounts: [{ id: "org-1", name: "Acme" }],
      },
    }));
    const client = new ApolloClient(() => "apollo-key", stub.fetch);

    expect(await client.searchOrganizations("Acme")).toEqual([
      {
        id: "org-1",
        name: "Acme",
        domain: "acme.com",
        employeeCount: 42,
        linkedinUrl: "https://www.linkedin.com/company/acme",
      },
      {
        id: "org-2",
        name: "Acme Robotics",
        domain: "acmerobotics.io",
        employeeCount: null,
        linkedinUrl: null,
      },
    ]);
    const url = new URL(stub.calls[0].url);
    expect(url.pathname).toBe("/api/v1/mixed_companies/search");
    expect(url.searchParams.get("q_organization_name")).toBe("Acme");
  });

  test("maps provider failures to safe, actionable errors", async () => {
    const cases: Array<[number, RegExp]> = [
      [401, /rejected the configured API key/],
      [403, /refused this search/],
      [429, /rate limited/],
      [422, /rejected the search/],
      [503, /temporarily unavailable/],
    ];
    for (const [status, message] of cases) {
      const client = new ApolloClient(
        () => "apollo-key",
        stubFetch(() => ({ status, body: { error: "secret detail" } })).fetch,
      );
      await expect(client.searchOrganizations("Acme")).rejects.toThrow(message);
    }
    const missing = new ApolloClient(() => undefined, stubFetch(() => ({ status: 200 })).fetch);
    expect(missing.configured()).toBe(false);
    await expect(missing.searchOrganizations("Acme")).rejects.toThrow(/Add an Apollo API key/);
  });

  test("keeps only LinkedIn links and plausible domains", () => {
    expect(normalizeDomain("https://WWW.Acme.com/about")).toBe("acme.com");
    expect(normalizeDomain("acme.co.uk")).toBe("acme.co.uk");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain(42)).toBeNull();
  });
});
