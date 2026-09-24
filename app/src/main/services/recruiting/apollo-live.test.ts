import { describe, expect, test } from "bun:test";
import { ApolloClient } from "./apollo";

/**
 * Opt-in check against the real Apollo API, outside portable CI. It runs when
 * the host was provisioned with `APOLLO_API_KEY` (test-setup.ts moves it to
 * `OPENRECRUIT_LIVE_APOLLO_API_KEY` so unit tests never see it). People search
 * spends no credits; the one organization lookup may, depending on the plan.
 * `OPENRECRUIT_LIVE_APOLLO_COMPANY` picks the company (default: Anthropic).
 */
const apiKey = process.env.OPENRECRUIT_LIVE_APOLLO_API_KEY;
const company = process.env.OPENRECRUIT_LIVE_APOLLO_COMPANY ?? "Anthropic";

describe("Apollo (live)", () => {
  test.skipIf(!apiKey)(
    `finds ${company} and people there without revealing contact details`,
    async () => {
      const client = new ApolloClient(() => apiKey);
      const organizations = await client.searchOrganizations(company);
      expect(organizations.length).toBeGreaterThan(0);
      const [organization] = organizations;
      console.info("organizations:", organizations);

      const people = await client.searchPeople({
        organizationId: organization.id,
        titles: ["engineering manager", "technical recruiter", "founder"],
        perPage: 10,
      });
      console.info(
        "people:",
        people.map((person) => ({
          name: `${person.firstName} ${person.lastName ?? ""}`,
          masked: person.lastNameMasked,
          title: person.title,
          linkedin: person.linkedinUrl !== null,
        })),
      );
      expect(people.length).toBeGreaterThan(0);
      for (const person of people) {
        expect(person.id).toBeTruthy();
        expect(JSON.stringify(person)).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
      }
    },
    30_000,
  );
});
