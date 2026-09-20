import { htmlToText } from "./hacker-news";

/**
 * Public applicant-tracking job boards the host can inspect. Each adapter owns
 * only what differs per board: recognizing its URLs, naming the public API
 * request, and normalizing the response. Policy, screening, evidence, and
 * persistence live in JobPostingInspectionApplication.
 */
export const ATS_PROVIDERS = [
  "greenhouse",
  "lever",
  "smartrecruiters",
  "workable",
  "rippling",
  "workday",
] as const;
export type AtsProvider = (typeof ATS_PROVIDERS)[number];

const MAX_DESCRIPTION_CHARS = 60_000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;
const WORKDAY_HOST = /^([a-z0-9][a-z0-9-]{0,62})\.wd\d{1,3}\.myworkdayjobs\.com$/;

export type AtsRequest = { url: string };

export type AtsJobReference = {
  /** The board handle the adapter passes back to its own request builders. */
  board: string;
  jobId: string;
};

/** The provider-neutral posting every adapter normalizes to. */
export type AtsPosting = {
  jobId: string;
  title: string;
  organization: string | null;
  canonicalUrl: string | null;
  applyUrl: string | null;
  location: string | null;
  secondaryLocations: string[];
  employmentType: string | null;
  workplaceType: string | null;
  isRemote: boolean | null;
  department: string | null;
  team: string | null;
  publishedAt: number | null;
  /** `day` when the board only states a publication date. */
  publishedAtPrecision: "instant" | "day";
  isListed: boolean;
  descriptionPlain: string;
  descriptionHtml: string;
  /** The board listing omitted the description; fetch the job for it. */
  needsDetail: boolean;
};

export type AtsAdapter = {
  provider: AtsProvider;
  label: string;
  sourceId: string;
  /** The search operator the harness uses to discover this board's postings. */
  searchSite: string;
  /** A job URL on this board, or null when the URL is not a posting here. */
  parseJobUrl(url: URL): AtsJobReference | null;
  /** A bare handle or any URL under the board; null when unrecognized. */
  parseBoard(input: string): string | null;
  jobRequest(reference: AtsJobReference): AtsRequest;
  /** Null when the board has no public listing that carries publication time. */
  boardRequest(board: string): AtsRequest | null;
  /** Throws when the response is not this board's job shape. */
  parseJob(body: unknown, reference: AtsJobReference): AtsPosting;
  parseBoardListing(body: unknown, board: string): AtsPosting[];
};

export class AtsSchemaError extends Error {}

const greenhouse: AtsAdapter = {
  provider: "greenhouse",
  label: "Greenhouse",
  sourceId: "source-greenhouse",
  searchSite: "job-boards.greenhouse.io",
  parseJobUrl(url) {
    if (!/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname)) return null;
    const parts = pathParts(url);
    if (parts.length < 3 || parts[1] !== "jobs" || !SLUG.test(parts[0]) || !/^\d+$/.test(parts[2]))
      return null;
    return { board: parts[0].toLowerCase(), jobId: parts[2] };
  },
  parseBoard(input) {
    return boardFromInput(input, (url) =>
      /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname)
        ? (pathParts(url)[0] ?? null)
        : null,
    );
  },
  jobRequest: ({ board, jobId }) => ({
    url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${jobId}`,
  }),
  boardRequest: (board) => ({
    url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
  }),
  parseJob(body, reference) {
    return greenhousePosting(requireRecord(body), reference.board);
  },
  parseBoardListing(body, board) {
    const jobs = requireRecord(body).jobs;
    if (!Array.isArray(jobs)) throw new AtsSchemaError("Greenhouse board has no jobs array");
    return jobs.filter(isRecord).flatMap((job) => attempt(() => greenhousePosting(job, board)));
  },
};

function greenhousePosting(job: Record<string, unknown>, board: string): AtsPosting {
  const id = job.id;
  const title = text(job.title);
  if ((typeof id !== "number" && typeof id !== "string") || !title) {
    throw new AtsSchemaError("Greenhouse job is missing id or title");
  }
  // Greenhouse serves the description as entity-escaped HTML.
  const descriptionHtml = decodeEntities(text(job.content) ?? "");
  const offices = Array.isArray(job.offices)
    ? job.offices.filter(isRecord).flatMap((office) => text(office.name) ?? [])
    : [];
  const departments = Array.isArray(job.departments)
    ? job.departments.filter(isRecord).flatMap((department) => text(department.name) ?? [])
    : [];
  const location = isRecord(job.location) ? text(job.location.name) : null;
  return {
    jobId: String(id),
    title,
    organization: text(job.company_name),
    canonicalUrl: `https://job-boards.greenhouse.io/${board}/jobs/${id}`,
    applyUrl: httpsUrl(job.absolute_url),
    location,
    secondaryLocations: offices.filter((office) => office !== location),
    employmentType: null,
    workplaceType: null,
    isRemote: null,
    department: departments[0] ?? null,
    team: null,
    publishedAt: timestamp(job.first_published),
    publishedAtPrecision: "instant",
    isListed: true,
    descriptionPlain: plain(descriptionHtml),
    descriptionHtml,
    needsDetail: false,
  };
}

const lever: AtsAdapter = {
  provider: "lever",
  label: "Lever",
  sourceId: "source-lever",
  searchSite: "jobs.lever.co",
  parseJobUrl(url) {
    if (url.hostname !== "jobs.lever.co") return null;
    const parts = pathParts(url);
    if (parts.length < 2 || !SLUG.test(parts[0]) || !UUID.test(parts[1])) return null;
    return { board: parts[0], jobId: parts[1].toLowerCase() };
  },
  parseBoard(input) {
    return boardFromInput(input, (url) =>
      url.hostname === "jobs.lever.co" ? (pathParts(url)[0] ?? null) : null,
    );
  },
  jobRequest: ({ board, jobId }) => ({
    url: `https://api.lever.co/v0/postings/${encodeURIComponent(board)}/${jobId}`,
  }),
  boardRequest: (board) => ({
    url: `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`,
  }),
  parseJob(body, reference) {
    return leverPosting(requireRecord(body), reference.board);
  },
  parseBoardListing(body, board) {
    if (!Array.isArray(body)) throw new AtsSchemaError("Lever board is not a posting list");
    return body.filter(isRecord).flatMap((job) => attempt(() => leverPosting(job, board)));
  },
};

function leverPosting(job: Record<string, unknown>, board: string): AtsPosting {
  const id = text(job.id);
  const title = text(job.text);
  if (!id || !title) throw new AtsSchemaError("Lever posting is missing id or text");
  const categories = isRecord(job.categories) ? job.categories : {};
  const lists = Array.isArray(job.lists) ? job.lists.filter(isRecord) : [];
  const descriptionHtml = [
    text(job.description) ?? "",
    ...lists.map((list) => `<h3>${text(list.text) ?? ""}</h3><ul>${text(list.content) ?? ""}</ul>`),
    text(job.additional) ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const location = text(categories.location);
  const allLocations = Array.isArray(categories.allLocations)
    ? categories.allLocations.flatMap((value) => text(value) ?? [])
    : [];
  const workplaceType = text(job.workplaceType);
  return {
    jobId: id.toLowerCase(),
    title,
    organization: null,
    canonicalUrl: `https://jobs.lever.co/${board}/${id.toLowerCase()}`,
    applyUrl: httpsUrl(job.applyUrl),
    location,
    secondaryLocations: allLocations.filter((value) => value !== location),
    employmentType: text(categories.commitment),
    workplaceType,
    isRemote: workplaceType === null ? null : workplaceType === "remote",
    department: text(categories.department),
    team: text(categories.team),
    publishedAt: typeof job.createdAt === "number" ? job.createdAt : null,
    publishedAtPrecision: "instant",
    isListed: true,
    descriptionPlain: plain(descriptionHtml),
    descriptionHtml,
    needsDetail: false,
  };
}

const smartrecruiters: AtsAdapter = {
  provider: "smartrecruiters",
  label: "SmartRecruiters",
  sourceId: "source-smartrecruiters",
  searchSite: "jobs.smartrecruiters.com",
  parseJobUrl(url) {
    if (url.hostname !== "jobs.smartrecruiters.com") return null;
    const parts = pathParts(url);
    const id = /^(\d+)(?:-|$)/.exec(parts[1] ?? "")?.[1];
    if (parts.length < 2 || !SLUG.test(parts[0]) || !id) return null;
    return { board: parts[0], jobId: id };
  },
  parseBoard(input) {
    return boardFromInput(input, (url) =>
      ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"].includes(url.hostname)
        ? (pathParts(url)[0] ?? null)
        : null,
    );
  },
  jobRequest: ({ board, jobId }) => ({
    url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings/${jobId}`,
  }),
  boardRequest: (board) => ({
    url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=100`,
  }),
  parseJob(body, reference) {
    return smartRecruitersPosting(requireRecord(body), reference.board);
  },
  parseBoardListing(body, board) {
    const content = requireRecord(body).content;
    if (!Array.isArray(content)) throw new AtsSchemaError("SmartRecruiters has no content array");
    return content
      .filter(isRecord)
      .flatMap((job) => attempt(() => smartRecruitersPosting(job, board)));
  },
};

function smartRecruitersPosting(job: Record<string, unknown>, board: string): AtsPosting {
  const id = text(job.id);
  const title = text(job.name);
  if (!id || !title) throw new AtsSchemaError("SmartRecruiters posting is missing id or name");
  const sections = isRecord(job.jobAd) && isRecord(job.jobAd.sections) ? job.jobAd.sections : null;
  const descriptionHtml = sections
    ? ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
        .flatMap((key) => {
          const section = sections[key];
          if (!isRecord(section) || !text(section.text)) return [];
          return `<h3>${text(section.title) ?? ""}</h3>${text(section.text)}`;
        })
        .join("\n")
    : "";
  const place = isRecord(job.location) ? job.location : {};
  const location =
    [text(place.city), text(place.region), text(place.country)?.toUpperCase()]
      .filter(Boolean)
      .join(", ") || null;
  const company = isRecord(job.company) ? job.company : {};
  return {
    jobId: id,
    title,
    organization: text(company.name),
    canonicalUrl: `https://jobs.smartrecruiters.com/${board}/${id}`,
    applyUrl: httpsUrl(job.applyUrl),
    location,
    secondaryLocations: [],
    employmentType: label(job.typeOfEmployment),
    workplaceType: place.remote === true ? "remote" : place.hybrid === true ? "hybrid" : null,
    isRemote: typeof place.remote === "boolean" ? place.remote : null,
    department: label(job.department),
    team: label(job.function),
    publishedAt: timestamp(job.releasedDate),
    publishedAtPrecision: "instant",
    // The listing only returns public postings; the detail states it outright.
    isListed: job.active !== false,
    descriptionPlain: plain(descriptionHtml),
    descriptionHtml,
    needsDetail: sections === null,
  };
}

const workable: AtsAdapter = {
  provider: "workable",
  label: "Workable",
  sourceId: "source-workable",
  searchSite: "apply.workable.com",
  parseJobUrl(url) {
    if (url.hostname !== "apply.workable.com") return null;
    const parts = pathParts(url);
    if (parts.length < 3 || parts[1] !== "j" || !SLUG.test(parts[0])) return null;
    if (!/^[A-Za-z0-9]{6,20}$/.test(parts[2])) return null;
    return { board: parts[0], jobId: parts[2].toUpperCase() };
  },
  parseBoard(input) {
    return boardFromInput(input, (url) => {
      if (url.hostname !== "apply.workable.com") return null;
      const handle = pathParts(url)[0] ?? null;
      return handle === "j" || handle === "api" ? null : handle;
    });
  },
  jobRequest: ({ board, jobId }) => ({
    url: `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(board)}/jobs/${jobId}`,
  }),
  boardRequest: (board) => ({
    url: `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}?details=true`,
  }),
  parseJob(body, reference) {
    const job = requireRecord(body);
    const shortcode = text(job.shortcode);
    const title = text(job.title);
    if (!shortcode || !title)
      throw new AtsSchemaError("Workable job is missing shortcode or title");
    const descriptionHtml = [text(job.description), text(job.requirements), text(job.benefits)]
      .filter(Boolean)
      .join("\n");
    const locations = Array.isArray(job.locations)
      ? job.locations.filter(isRecord).flatMap((value) => workablePlace(value) ?? [])
      : [];
    const location = (isRecord(job.location) ? workablePlace(job.location) : null) ?? locations[0];
    const workplace = text(job.workplace);
    return {
      jobId: shortcode.toUpperCase(),
      title,
      organization: null,
      canonicalUrl: `https://apply.workable.com/${reference.board}/j/${shortcode.toUpperCase()}/`,
      applyUrl: `https://apply.workable.com/${reference.board}/j/${shortcode.toUpperCase()}/apply/`,
      location: location ?? null,
      secondaryLocations: locations.filter((value) => value !== location),
      employmentType: text(job.type),
      workplaceType: workplace,
      isRemote: typeof job.remote === "boolean" ? job.remote : null,
      department: Array.isArray(job.department) ? (text(job.department[0]) ?? null) : null,
      team: null,
      publishedAt: timestamp(job.published),
      publishedAtPrecision: "day",
      isListed: job.state === "published",
      descriptionPlain: plain(descriptionHtml),
      descriptionHtml,
      needsDetail: false,
    };
  },
  parseBoardListing(body, board) {
    const account = requireRecord(body);
    if (!Array.isArray(account.jobs)) throw new AtsSchemaError("Workable account has no jobs");
    const organization = text(account.name);
    return account.jobs.filter(isRecord).flatMap((job) =>
      attempt((): AtsPosting => {
        const shortcode = text(job.shortcode);
        const title = text(job.title);
        if (!shortcode || !title) throw new AtsSchemaError("Workable job is missing shortcode");
        const descriptionHtml = text(job.description) ?? "";
        const locations = Array.isArray(job.locations)
          ? job.locations.filter(isRecord).flatMap((value) => workablePlace(value) ?? [])
          : [];
        return {
          jobId: shortcode.toUpperCase(),
          title,
          organization,
          canonicalUrl: `https://apply.workable.com/${board}/j/${shortcode.toUpperCase()}/`,
          applyUrl: httpsUrl(job.application_url),
          location: locations[0] ?? null,
          secondaryLocations: locations.slice(1),
          employmentType: text(job.employment_type),
          workplaceType: null,
          isRemote: typeof job.telecommuting === "boolean" ? job.telecommuting : null,
          department: text(job.department),
          team: null,
          publishedAt: timestamp(job.published_on),
          publishedAtPrecision: "day",
          isListed: true,
          descriptionPlain: plain(descriptionHtml),
          descriptionHtml,
          needsDetail: false,
        };
      }),
    );
  },
};

function workablePlace(place: Record<string, unknown>): string | null {
  return (
    [text(place.city), text(place.region), text(place.country)].filter(Boolean).join(", ") || null
  );
}

const rippling: AtsAdapter = {
  provider: "rippling",
  label: "Rippling",
  sourceId: "source-rippling",
  searchSite: "ats.rippling.com",
  parseJobUrl(url) {
    if (url.hostname !== "ats.rippling.com") return null;
    const parts = pathParts(url).filter((part, index) => !(index === 0 && LOCALE.test(part)));
    if (parts.length < 3 || parts[1] !== "jobs" || !SLUG.test(parts[0]) || !UUID.test(parts[2]))
      return null;
    return { board: parts[0], jobId: parts[2].toLowerCase() };
  },
  parseBoard: () => null,
  jobRequest: ({ board, jobId }) => ({
    url: `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(board)}/jobs/${jobId}`,
  }),
  // The public board listing carries no publication time or description.
  boardRequest: () => null,
  parseJob(body, reference) {
    const job = requireRecord(body);
    const id = text(job.uuid);
    const title = text(job.name);
    if (!id || !title) throw new AtsSchemaError("Rippling job is missing uuid or name");
    const description = isRecord(job.description) ? job.description : {};
    const descriptionHtml = [text(description.company), text(description.role)]
      .filter(Boolean)
      .join("\n");
    const locations = Array.isArray(job.workLocations)
      ? job.workLocations.flatMap((value) => text(value) ?? [])
      : [];
    const department = isRecord(job.department) ? job.department : {};
    return {
      jobId: id.toLowerCase(),
      title,
      organization: text(job.companyName),
      canonicalUrl: `https://ats.rippling.com/${reference.board}/jobs/${id.toLowerCase()}`,
      applyUrl: null,
      location: locations[0] ?? null,
      secondaryLocations: locations.slice(1),
      employmentType: isRecord(job.employmentType) ? text(job.employmentType.id) : null,
      workplaceType: null,
      isRemote: null,
      department: text(department.base_department) ?? text(department.name),
      team: text(department.name),
      publishedAt: timestamp(job.createdOn),
      publishedAtPrecision: "instant",
      isListed: job.unlistedFromSearch !== true,
      descriptionPlain: plain(descriptionHtml),
      descriptionHtml,
      needsDetail: false,
    };
  },
  parseBoardListing: () => [],
};

const workday: AtsAdapter = {
  provider: "workday",
  label: "Workday",
  sourceId: "source-workday",
  searchSite: "myworkdayjobs.com",
  parseJobUrl(url) {
    if (!WORKDAY_HOST.test(url.hostname)) return null;
    const parts = pathParts(url).filter((part, index) => !(index === 0 && LOCALE.test(part)));
    const jobAt = parts.indexOf("job");
    if (jobAt !== 1 || !SLUG.test(parts[0])) return null;
    const rest = parts.slice(2);
    const applyAt = rest.indexOf("apply");
    const jobPath = applyAt === -1 ? rest : rest.slice(0, applyAt);
    if (jobPath.length < 1 || jobPath.length > 3) return null;
    return { board: `${url.hostname}/${parts[0]}`, jobId: jobPath.join("/") };
  },
  parseBoard: () => null,
  jobRequest({ board, jobId }) {
    const [host, site] = board.split("/");
    const tenant = WORKDAY_HOST.exec(host)?.[1] ?? "";
    const path = jobId.split("/").map(encodeURIComponent).join("/");
    return { url: `https://${host}/wday/cxs/${tenant}/${encodeURIComponent(site)}/job/${path}` };
  },
  // Workday boards are searched, not listed; discovery stays with the harness.
  boardRequest: () => null,
  parseJob(body, reference) {
    const envelope = requireRecord(body);
    const job = isRecord(envelope.jobPostingInfo) ? envelope.jobPostingInfo : null;
    const title = job ? text(job.title) : null;
    if (!job || !title) throw new AtsSchemaError("Workday job is missing jobPostingInfo");
    const descriptionHtml = text(job.jobDescription) ?? "";
    const organization = isRecord(envelope.hiringOrganization)
      ? text(envelope.hiringOrganization.name)
      : null;
    const remoteType = text(job.remoteType);
    const [host, site] = reference.board.split("/");
    return {
      jobId: reference.jobId,
      title,
      organization,
      canonicalUrl: httpsUrl(job.externalUrl) ?? `https://${host}/${site}/job/${reference.jobId}`,
      applyUrl: null,
      location: text(job.location),
      secondaryLocations: Array.isArray(job.additionalLocations)
        ? job.additionalLocations.flatMap((value) => text(value) ?? [])
        : [],
      employmentType: text(job.timeType),
      workplaceType: remoteType,
      isRemote: remoteType === null ? null : /remote/i.test(remoteType),
      department: null,
      team: null,
      publishedAt: timestamp(job.startDate),
      publishedAtPrecision: "day",
      isListed: job.posted !== false,
      descriptionPlain: plain(descriptionHtml),
      descriptionHtml,
      needsDetail: false,
    };
  },
  parseBoardListing: () => [],
};

export const ATS_ADAPTERS: Record<AtsProvider, AtsAdapter> = {
  greenhouse,
  lever,
  smartrecruiters,
  workable,
  rippling,
  workday,
};

export const ATS_SOURCE_IDS: readonly string[] = ATS_PROVIDERS.map(
  (provider) => ATS_ADAPTERS[provider].sourceId,
);

export function isAtsProvider(value: unknown): value is AtsProvider {
  return typeof value === "string" && (ATS_PROVIDERS as readonly string[]).includes(value);
}

/** Route a posting URL to the adapter that recognizes it. */
export function routeJobUrl(
  input: string,
):
  | { ok: true; adapter: AtsAdapter; reference: AtsJobReference }
  | { ok: false; code: "invalid_url" | "unsupported_host"; message: string } {
  const url = safeUrl(input);
  if (!url) {
    return {
      ok: false,
      code: "invalid_url",
      message: "Job URL must use HTTPS without credentials or a custom port",
    };
  }
  let hostMatched = false;
  for (const provider of ATS_PROVIDERS) {
    const adapter = ATS_ADAPTERS[provider];
    const reference = adapter.parseJobUrl(url);
    if (reference) return { ok: true, adapter, reference };
    hostMatched ||= url.hostname.endsWith(adapter.searchSite);
  }
  return hostMatched
    ? { ok: false, code: "invalid_url", message: "URL is not a job posting on a supported board" }
    : { ok: false, code: "unsupported_host", message: "Job URL uses an unsupported host" };
}

/** Route a board URL to the adapter that can enumerate it. */
export function routeBoard(input: string):
  | { ok: true; adapter: AtsAdapter; board: string }
  | {
      ok: false;
      code: "invalid_url" | "unsupported_host" | "enumeration_unsupported";
      message: string;
    } {
  const url = safeUrl(input);
  if (!url) {
    return {
      ok: false,
      code: "invalid_url",
      message: "Board reference must be an HTTPS board URL",
    };
  }
  for (const provider of ATS_PROVIDERS) {
    const adapter = ATS_ADAPTERS[provider];
    const board = adapter.parseBoard(input);
    if (board && adapter.boardRequest(board)) return { ok: true, adapter, board };
    if (url.hostname.endsWith(adapter.searchSite)) {
      return {
        ok: false,
        code: "enumeration_unsupported",
        message: `${adapter.label} boards cannot be enumerated; pass posting URLs instead`,
      };
    }
  }
  return { ok: false, code: "unsupported_host", message: "Board URL uses an unsupported host" };
}

function boardFromInput(input: string, fromUrl: (url: URL) => string | null): string | null {
  const url = safeUrl(input);
  const handle = url ? fromUrl(url) : null;
  return handle && SLUG.test(handle) ? handle : null;
}

function safeUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

function pathParts(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function attempt<T>(build: () => T): T[] {
  try {
    return [build()];
  } catch {
    return [];
  }
}

/** Board descriptions are full documents; keep list items and blocks apart. */
function plain(html: string): string {
  return htmlToText(
    html
      .replace(/<(?:script|style)\b[^>]*>.*?<\/(?:script|style)>/gis, "")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(?:p|div|h[1-6]|ul|ol|li|tr)>/gi, "\n")
      .replace(/<(?:p|div|h[1-6])\b[^>]*>/gi, "\n\n")
      .replace(/&nbsp;/g, " "),
    MAX_DESCRIPTION_CHARS,
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = safeUrl(value);
  if (!url) return null;
  url.hash = "";
  return url.toString();
}

function label(value: unknown): string | null {
  return isRecord(value) ? text(value.label) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AtsSchemaError("Response is not a JSON object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
