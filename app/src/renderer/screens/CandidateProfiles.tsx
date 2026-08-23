import type { CandidateProfileSummary } from "@shared/recruiting";
import { FileText, Loader2, Plus, Save, UserRound } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";

/** Local Candidate Profile onboarding and review surface. The host remains the
 * only writer; this screen only uses Recruiting tRPC projections/commands. */
export function CandidateProfilesScreen() {
  const utils = trpc.useUtils();
  const profiles = trpc.recruiting.profiles.useQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [roleTarget, setRoleTarget] = useState("");
  const [cvPath, setCvPath] = useState("");
  const [github, setGithub] = useState("");
  const [interests, setInterests] = useState("");
  const [constraints, setConstraints] = useState("");
  const [preferences, setPreferences] = useState("");
  const importProfile = trpc.recruiting.importProfile.useMutation({
    onSuccess: (profile) => {
      setSelectedId(profile.id);
      void utils.recruiting.profiles.invalidate();
    },
  });
  const confirm = trpc.recruiting.confirmProfile.useMutation({
    onSuccess: () => {
      void utils.recruiting.profiles.invalidate();
      if (selectedId) void utils.recruiting.profile.invalidate({ id: selectedId });
    },
  });

  const selected =
    profiles.data?.find((profile) => profile.id === selectedId) ?? profiles.data?.[0];
  const submit = () => {
    importProfile.mutate({
      name,
      roleTarget,
      cvPath: cvPath.trim() || undefined,
      github: github.trim() || undefined,
      careerInterests: interests,
      hardConstraints: splitLines(constraints),
      preferences: splitLines(preferences),
      idempotencyKey: `profile-import-${crypto.randomUUID()}`,
    });
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <div>
          <h1 className="text-lg font-semibold">Candidate Profiles</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Import a local CV, public GitHub profile, and career interests into a reviewable draft.
            Confirmed versions are immutable and saved as readable local Markdown.
          </p>
        </div>
        <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
          <Card className="flex flex-col gap-2 p-3">
            <div className="flex items-center justify-between px-2 pb-1">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Profiles
              </span>
              <UserRound className="size-4 text-muted-foreground" />
            </div>
            {profiles.isLoading && <Loader2 className="mx-auto my-4 size-4 animate-spin" />}
            {profiles.data?.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">No profiles yet.</p>
            )}
            {profiles.data?.map((profile) => (
              <button
                type="button"
                key={profile.id}
                onClick={() => setSelectedId(profile.id)}
                className={cn(
                  "rounded-md px-2 py-2 text-left hover:bg-muted",
                  selected?.id === profile.id && "bg-muted",
                )}
              >
                <span className="block truncate text-sm font-medium">{profile.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {profile.roleTarget} · {profile.state}
                </span>
              </button>
            ))}
          </Card>
          <div className="flex flex-col gap-5">
            <Card className="grid gap-3 p-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <h2 className="text-sm font-medium">Start a profile draft</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  A failed or unavailable import still leaves a draft you can complete manually.
                </p>
              </div>
              <Field label="Profile name" value={name} onChange={setName} placeholder="My search" />
              <Field
                label="Role target"
                value={roleTarget}
                onChange={setRoleTarget}
                placeholder="Staff engineer"
              />
              <Field
                label="Local CV path"
                value={cvPath}
                onChange={setCvPath}
                placeholder="/Users/me/resume.pdf"
              />
              <Field
                label="GitHub URL or handle"
                value={github}
                onChange={setGithub}
                placeholder="octocat or https://github.com/octocat"
              />
              <TextField
                label="Career interests"
                value={interests}
                onChange={setInterests}
                placeholder="One interest per line"
              />
              <TextField
                label="Hard Constraints"
                value={constraints}
                onChange={setConstraints}
                placeholder="One constraint per line"
              />
              <TextField
                label="Preferences"
                value={preferences}
                onChange={setPreferences}
                placeholder="One preference per line"
              />
              <div className="flex items-end justify-end sm:col-span-2">
                <Button
                  type="button"
                  onClick={submit}
                  disabled={importProfile.isPending || !name || !roleTarget}
                >
                  {importProfile.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  Import draft
                </Button>
              </div>
              {importProfile.error && (
                <p className="text-xs text-destructive sm:col-span-2">
                  {importProfile.error.message}
                </p>
              )}
            </Card>
            {selected && (
              <ProfileReview
                profile={selected}
                onConfirm={() =>
                  confirm.mutate({
                    profileId: selected.id,
                    expectedRevision: selected.revision,
                    idempotencyKey: `profile-confirm-${crypto.randomUUID()}`,
                  })
                }
                confirming={confirm.isPending}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function ProfileReview({
  profile,
  onConfirm,
  confirming,
}: {
  profile: CandidateProfileSummary;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const facts = profile.sections.flatMap((section) => section.facts);
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Review: {profile.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {profile.roleTarget} · {profile.state} · revision {profile.revision}
          </p>
        </div>
        {profile.state === "draft" && (
          <Button type="button" size="sm" onClick={onConfirm} disabled={confirming}>
            {confirming ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{" "}
            Confirm version
          </Button>
        )}
      </div>
      {profile.importWarnings.map((warning) => (
        <p key={warning} className="rounded bg-warning/10 p-2 text-xs text-warning">
          {warning}
        </p>
      ))}
      <div className="grid gap-2 sm:grid-cols-2">
        {facts.map((fact) => (
          <div
            key={fact.id}
            className={cn("rounded-md border border-border p-3", fact.conflict && "border-warning")}
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileText className="size-3.5" /> {fact.sourceLabel} · {fact.section}
            </div>
            <p className="mt-1 text-sm">
              <span className="font-medium">{fact.key}:</span> {fact.value}
            </p>
            {fact.conflict && (
              <p className="mt-1 text-xs text-warning">Conflicts with another attributable fact</p>
            )}
          </div>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          View Markdown source of truth
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
          {profile.markdown}
        </pre>
      </details>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
      />
    </div>
  );
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}
