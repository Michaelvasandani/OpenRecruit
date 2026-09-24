import { z } from "zod";

/** Why a person was suggested: someone on or leading the team, someone who
 * recruits for it, or a founder who hires directly at a small company. */
export const OutreachCategory = z.enum(["team", "recruiting", "founder"]);
export type OutreachCategory = z.infer<typeof OutreachCategory>;

export const OutreachOrganization = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  domain: z.string().max(200).nullable(),
  employeeCount: z.number().int().nonnegative().nullable(),
  linkedinUrl: z.string().max(500).nullable(),
});
export type OutreachOrganization = z.infer<typeof OutreachOrganization>;

export const OutreachCompany = z.object({
  companyKey: z.string().min(1),
  companyName: z.string().min(1),
  apolloOrganizationId: z.string().nullable(),
  domain: z.string().nullable(),
  employeeCount: z.number().int().nullable(),
  linkedinUrl: z.string().nullable(),
});
export type OutreachCompany = z.infer<typeof OutreachCompany>;

export const OutreachContact = z.object({
  id: z.string().min(1),
  signalId: z.string().min(1),
  firstName: z.string().min(1),
  /** Apollo masks last names on lower plans ("Mo***s"); `lastNameMasked` says so. */
  lastName: z.string().nullable(),
  lastNameMasked: z.boolean(),
  displayName: z.string().min(1),
  title: z.string().nullable(),
  category: OutreachCategory,
  reason: z.string().min(1),
  /** The person's own LinkedIn profile, when Apollo returned one. */
  linkedinUrl: z.string().nullable(),
  /** A LinkedIn people search that should surface this person. */
  linkedinSearchUrl: z.string().min(1),
  note: z.string().nullable(),
  noteDraftedAt: z.number().int().nullable(),
  foundAt: z.number().int(),
});
export type OutreachContact = z.infer<typeof OutreachContact>;

export const OutreachPanel = z.object({
  signalId: z.string().min(1),
  /** The company name the Job Board row carries, if any. */
  companyName: z.string().nullable(),
  company: OutreachCompany.nullable(),
  contacts: z.array(OutreachContact),
  apolloConfigured: z.boolean(),
});
export type OutreachPanel = z.infer<typeof OutreachPanel>;

/** How the Candidate settled which company to search when the name alone was
 * not enough: a listed Apollo organization, or a company website domain. */
export const OutreachCompanyChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization"), organization: OutreachOrganization }),
  z.object({ kind: z.literal("domain"), domain: z.string().trim().min(3).max(200) }),
]);
export type OutreachCompanyChoice = z.infer<typeof OutreachCompanyChoice>;

export const FindPeopleInput = z.object({
  signalId: z.string().min(1),
  company: OutreachCompanyChoice.optional(),
});
export type FindPeopleInput = z.infer<typeof FindPeopleInput>;

export const FindPeopleResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), panel: OutreachPanel }),
  z.object({
    status: z.literal("needs_company"),
    /** `no_company`: the row names no company. `ambiguous`: several Apollo
     * organizations could be it. `not_found`: Apollo knows none by that name. */
    reason: z.enum(["no_company", "ambiguous", "not_found"]),
    companyName: z.string().nullable(),
    matches: z.array(OutreachOrganization),
  }),
]);
export type FindPeopleResult = z.infer<typeof FindPeopleResult>;
