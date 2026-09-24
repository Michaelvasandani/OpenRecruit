import type {
  FindPeopleResult,
  OutreachCategory,
  OutreachCompanyChoice,
  OutreachContact,
} from "@shared/outreach";
import type { JobBoardRow } from "@shared/recruiting";
import { Check, Copy, ExternalLink, Loader2, Sparkles, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";

/** Keep in step with NOTE_MAX_CHARS on the host (free LinkedIn note limit). */
const NOTE_MAX_CHARS = 200;

const CATEGORY_LABELS: Record<OutreachCategory, { label: string; tone: string }> = {
  team: { label: "Team", tone: "bg-sky-500/15 text-sky-500" },
  recruiting: { label: "Recruiting", tone: "bg-violet-500/15 text-violet-400" },
  founder: { label: "Founder", tone: "bg-amber-500/15 text-amber-500" },
};

type NeedsCompany = Extract<FindPeopleResult, { status: "needs_company" }>;

/**
 * The People section of an expanded Job Board row: find people worth reaching
 * out to about this role, open them on LinkedIn, and draft a short note.
 * Nothing is ever sent from here.
 */
export function PeoplePanel({ row }: { row: JobBoardRow }) {
  const utils = trpc.useUtils();
  const setView = useUIStore((s) => s.setView);
  const panel = trpc.recruiting.outreach.panel.useQuery({ signalId: row.signalId });
  const [needs, setNeeds] = useState<NeedsCompany | null>(null);
  const [domain, setDomain] = useState("");
  const find = trpc.recruiting.outreach.findPeople.useMutation({
    onSuccess: (result) => {
      if (result.status === "found") {
        setNeeds(null);
        utils.recruiting.outreach.panel.setData({ signalId: row.signalId }, result.panel);
      } else {
        setNeeds(result);
      }
    },
  });

  const search = (company?: OutreachCompanyChoice) =>
    find.mutate({ signalId: row.signalId, ...(company ? { company } : {}) });

  const data = panel.data;
  const contacts = data?.contacts ?? [];
  const searched = data?.company !== null && data?.company !== undefined;

  return (
    <section className="mt-4 max-w-3xl rounded-md border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          People to reach out to
        </h3>
        {data?.company && (
          <span className="text-xs text-muted-foreground">
            at {data.company.companyName}
            {data.company.domain ? ` · ${data.company.domain}` : ""}
            {data.company.employeeCount !== null
              ? ` · ${data.company.employeeCount.toLocaleString()} people`
              : ""}
          </span>
        )}
        {data?.apolloConfigured && (
          <button
            type="button"
            disabled={find.isPending}
            onClick={() => search()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {find.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Users className="size-3" />
            )}
            {searched ? "Search again" : "Find people"}
          </button>
        )}
      </div>

      {panel.isLoading ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : panel.error ? (
        <p className="mt-2 text-xs text-destructive">{panel.error.message}</p>
      ) : !data?.apolloConfigured ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Add an Apollo API key under{" "}
          <button
            type="button"
            onClick={() => setView("settings")}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Settings → People Search
          </button>{" "}
          to find the team leads, recruiters, and founders behind this role. Searches spend no
          Apollo credits.
        </p>
      ) : null}

      {find.error && <p className="mt-2 text-xs text-destructive">{find.error.message}</p>}

      {needs && (
        <div className="mt-3 space-y-2 text-xs">
          <p className="text-muted-foreground">
            {needs.reason === "no_company"
              ? "This posting doesn't name its company. Enter the company's website to search it."
              : needs.reason === "not_found"
                ? `Apollo has no company named “${needs.companyName}”. Enter its website instead.`
                : `Which “${needs.companyName}” is it?`}
          </p>
          {needs.matches.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {needs.matches.map((organization) => (
                <button
                  type="button"
                  key={organization.id}
                  disabled={find.isPending}
                  onClick={() => search({ kind: "organization", organization })}
                  className="rounded-md border border-border px-2.5 py-1 text-left hover:bg-muted disabled:opacity-50"
                >
                  <span className="font-medium">{organization.name}</span>
                  <span className="text-muted-foreground">
                    {organization.domain ? ` · ${organization.domain}` : ""}
                    {organization.employeeCount !== null
                      ? ` · ${organization.employeeCount.toLocaleString()} people`
                      : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (domain.trim()) search({ kind: "domain", domain: domain.trim() });
            }}
          >
            <input
              aria-label="Company website"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="acme.com"
              className="h-7 w-48 rounded-md border border-border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <button
              type="submit"
              disabled={!domain.trim() || find.isPending}
              className="rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
            >
              Search this website
            </button>
          </form>
        </div>
      )}

      {searched && contacts.length === 0 && !needs && (
        <p className="mt-2 text-xs text-muted-foreground">
          Apollo found no team leads, recruiters, or founders here. Try the company's website domain
          if the match looks wrong.
        </p>
      )}

      {contacts.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {contacts.map((contact) => (
            <ContactRow key={contact.id} contact={contact} signalId={row.signalId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ContactRow({ contact, signalId }: { contact: OutreachContact; signalId: string }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(contact.note ?? "");
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(contact.note ?? ""), [contact.note]);
  const draftNote = trpc.recruiting.outreach.draftNote.useMutation({
    onSuccess: () => void utils.recruiting.outreach.panel.invalidate({ signalId }),
  });
  const category = CATEGORY_LABELS[contact.category];
  const profileUrl = contact.linkedinUrl ?? contact.linkedinSearchUrl;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{contact.displayName}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px]", category.tone)}>
          {category.label}
        </span>
        {contact.title && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{contact.title}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <a
            href={profileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
            title={
              contact.linkedinUrl
                ? "Open their LinkedIn profile"
                : "Search LinkedIn for this person at the company"
            }
          >
            {contact.linkedinUrl ? "LinkedIn profile" : "Find on LinkedIn"}
            <ExternalLink className="size-3" />
          </a>
          <button
            type="button"
            disabled={draftNote.isPending}
            onClick={() => draftNote.mutate({ contactId: contact.id })}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {draftNote.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Sparkles className="size-3" />
            )}
            {contact.note ? "Redraft note" : "Draft note"}
          </button>
        </div>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{contact.reason}</p>
      {draftNote.error && (
        <p className="mt-1 text-xs text-destructive">{draftNote.error.message}</p>
      )}
      {contact.note !== null && (
        <div className="mt-2">
          <textarea
            aria-label={`Note to ${contact.firstName}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-sm leading-snug outline-none focus:border-ring"
          />
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn(draft.length > NOTE_MAX_CHARS && "text-warning")}>
              {draft.length}/{NOTE_MAX_CHARS} · fits a free LinkedIn connection note
            </span>
            <button
              type="button"
              onClick={() => void copy()}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 hover:bg-muted"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
