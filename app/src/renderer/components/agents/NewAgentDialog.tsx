import {
  compileScoutSetup,
  createDefaultScoutSetup,
  type HarnessId,
  parseScoutListDraft,
  type ScoutDiscoveryAngle,
  ScoutSetup,
} from "@shared/agent";
import { ArrowLeft, ArrowRight, Check, Clock, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useCreateAgent } from "../../hooks/useCreateAgent";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";
import { HarnessGlyph } from "../icons/HarnessGlyph";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

const STEPS = ["Target", "Sources & freshness", "Behavior & review"] as const;
const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring";
const DISCOVERY_ANGLES: Array<{
  value: ScoutDiscoveryAngle;
  label: string;
  description: string;
}> = [
  {
    value: "direct_openings",
    label: "Direct openings",
    description: "Published roles on company and job sites",
  },
  {
    value: "founder_signals",
    label: "Founder signals",
    description: "Public posts from founders and hiring managers",
  },
  {
    value: "early_stage",
    label: "Early-stage companies",
    description: "Smaller companies and emerging teams",
  },
  {
    value: "new_grad",
    label: "New-grad paths",
    description: "Entry-level and early-career opportunities",
  },
];

/** Guided New Scout dialog. Candidate choices compile into Strategy, Policy,
 * explicit Source Access, harness instructions, and an optional local cadence. */
export function NewAgentDialog() {
  const open = useUIStore((state) => state.newAgentOpen);
  const close = useUIStore((state) => state.closeNewAgent);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[92vh] w-[48rem] max-w-[94vw] gap-0 overflow-hidden p-0 sm:max-w-[48rem]"
      >
        <DialogTitle className="sr-only">New Scout</DialogTitle>
        <DialogDescription className="sr-only">
          Configure a role-targeted Scout, its Sources, freshness, and behavior.
        </DialogDescription>
        {open && <NewAgentForm />}
      </DialogContent>
    </Dialog>
  );
}

function NewAgentForm() {
  const { create, isPending } = useCreateAgent();
  const profiles = trpc.recruiting.profiles.useQuery();
  const sources = trpc.recruiting.sources.useQuery();
  const probes = trpc.onboarding.harnesses.useQuery(undefined, { staleTime: 60_000 });
  const confirmedProfiles = profiles.data?.filter((profile) => profile.state === "confirmed") ?? [];
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [harness, setHarness] = useState<HarnessId>("claude");
  const [setup, setSetup] = useState<ScoutSetup>(() => createDefaultScoutSetup(""));
  const nameEdited = useRef(false);
  const seededProfile = useRef(false);

  useEffect(() => {
    const first = confirmedProfiles[0];
    if (!first || seededProfile.current) return;
    seededProfile.current = true;
    setProfileId(first.id);
    setSetup(createDefaultScoutSetup(first.roleTarget));
    setName(`${first.roleTarget} Scout`);
  }, [confirmedProfiles]);

  const updateSetup = <K extends keyof ScoutSetup>(key: K, value: ScoutSetup[K]) => {
    setSetup((current) => ({ ...current, [key]: value }));
  };
  const chooseProfile = (nextId: string) => {
    setProfileId(nextId);
    const profile = confirmedProfiles.find((item) => item.id === nextId);
    if (!profile) return;
    setSetup((current) => ({
      ...createDefaultScoutSetup(profile.roleTarget),
      sourceIds: current.sourceIds,
    }));
    if (!nameEdited.current) setName(`${profile.roleTarget} Scout`);
  };

  const selectedProfile = confirmedProfiles.find((profile) => profile.id === profileId);
  const selectedSources =
    sources.data?.filter((source) => setup.sourceIds.includes(source.id)) ?? [];
  const targetReady = Boolean(
    profileId && setup.targetRoles.length && setup.discoveryAngles.length,
  );
  const sourcesReady = setup.sourceIds.length > 0;
  const behaviorReady = Boolean(name.trim());
  const setupValid = ScoutSetup.safeParse(setup).success;
  const currentReady = step === 0 ? targetReady : step === 1 ? sourcesReady : behaviorReady;
  const canSubmit = targetReady && sourcesReady && behaviorReady && setupValid && !isPending;
  const preview = compileScoutSetup(
    setup.targetRoles.length ? setup : { ...setup, targetRoles: ["Target role"] },
  );

  const submit = () => {
    if (!canSubmit) return;
    create({
      name: name.trim(),
      template: "dca",
      harness,
      defaultProfileId: profileId,
      scoutSetup: setup,
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (step < STEPS.length - 1) {
          if (currentReady) setStep((current) => current + 1);
        } else submit();
      }}
      onKeyDown={(event) => {
        if (step === 2 && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
      className="flex h-[42rem] max-h-[92vh] min-h-0 flex-col"
    >
      <header className="border-b border-border px-6 pb-4 pt-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Create a Scout</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Define what it should find, where it may look, and how it should behave.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">{step + 1} of 3</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              disabled={index > step}
              onClick={() => index <= step && setStep(index)}
              className="text-left"
            >
              <span
                className={cn(
                  "mb-1.5 block h-1 rounded-full bg-muted",
                  index <= step && "bg-primary",
                )}
              />
              <span
                className={cn(
                  "text-[11px] text-muted-foreground",
                  index === step && "text-foreground",
                )}
              >
                {label}
              </span>
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {step === 0 && (
          <TargetStep
            key={profileId}
            profiles={confirmedProfiles}
            profileId={profileId}
            chooseProfile={chooseProfile}
            setup={setup}
            updateSetup={updateSetup}
            isLoading={profiles.isLoading}
          />
        )}
        {step === 1 && (
          <SourcesStep
            sources={sources.data ?? []}
            isLoading={sources.isLoading}
            setup={setup}
            updateSetup={updateSetup}
          />
        )}
        {step === 2 && (
          <BehaviorStep
            name={name}
            setName={(value) => {
              nameEdited.current = true;
              setName(value);
            }}
            profileName={selectedProfile?.name ?? "Candidate Profile"}
            setup={setup}
            updateSetup={updateSetup}
            selectedSourceNames={selectedSources.map((source) => source.name)}
            harness={harness}
            setHarness={setHarness}
            codexFound={probes.data?.codex.found ?? false}
            generatedInstructions={preview.instructions}
          />
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
        <div>
          {step > 0 && (
            <Button type="button" variant="ghost" onClick={() => setStep((current) => current - 1)}>
              <ArrowLeft className="size-4" /> Back
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {(!currentReady || (step === 2 && !setupValid)) && (
            <span className="text-[11px] text-muted-foreground">
              {step === 0
                ? "Choose a Profile, target role, and angle"
                : step === 1
                  ? "Choose at least one ready Source"
                  : behaviorReady
                    ? "Complete all behavior settings"
                    : "Name this Scout"}
            </span>
          )}
          {step < 2 ? (
            <Button type="submit" disabled={!currentReady}>
              Continue <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button type="submit" disabled={!canSubmit}>
              {isPending ? "Creating…" : "Create Scout"}
              {!isPending && <ArrowRight className="size-4" />}
            </Button>
          )}
        </div>
      </footer>
    </form>
  );
}

type UpdateSetup = <K extends keyof ScoutSetup>(key: K, value: ScoutSetup[K]) => void;

function TargetStep({
  profiles,
  profileId,
  chooseProfile,
  setup,
  updateSetup,
  isLoading,
}: {
  profiles: Array<{ id: string; name: string; roleTarget: string }>;
  profileId: string;
  chooseProfile: (id: string) => void;
  setup: ScoutSetup;
  updateSetup: UpdateSetup;
  isLoading: boolean;
}) {
  const [roleDraft, setRoleDraft] = useState(setup.targetRoles.join(", "));
  const [locationDraft, setLocationDraft] = useState(setup.locations.join(", "));
  return (
    <section className="space-y-5">
      <Intro
        title="Who and what is this Scout searching for?"
        description="The confirmed Candidate Profile anchors fit. This Scout can narrow its role focus."
      />
      <Field label="Candidate Profile" hint="Required and pinned at the start of each Run">
        <select
          value={profileId}
          onChange={(event) => chooseProfile(event.target.value)}
          className={SELECT_CLASS}
          disabled={isLoading || profiles.length === 0}
        >
          <option value="">Select a confirmed Profile</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.roleTarget}
            </option>
          ))}
        </select>
        {!isLoading && profiles.length === 0 && (
          <p className="mt-2 text-xs text-destructive">
            Confirm a Candidate Profile before creating a Scout.
          </p>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Target roles" hint="Comma-separated; these narrow the Profile target">
          <Input
            value={roleDraft}
            onChange={(event) => {
              const parsed = parseScoutListDraft(event.target.value);
              setRoleDraft(parsed.draft);
              updateSetup("targetRoles", parsed.values);
            }}
            placeholder="AI Engineer, ML Engineer"
          />
        </Field>
        <Field label="Location preference" hint="Optional; blank means no location limit">
          <Input
            value={locationDraft}
            onChange={(event) => {
              const parsed = parseScoutListDraft(event.target.value);
              setLocationDraft(parsed.draft);
              updateSetup("locations", parsed.values);
            }}
            placeholder="Remote — US, San Francisco"
          />
        </Field>
      </div>
      <Field label="Discovery angles" hint="Choose one or more enduring search theses">
        <div className="grid gap-2 sm:grid-cols-2">
          {DISCOVERY_ANGLES.map((angle) => {
            const selected = setup.discoveryAngles.includes(angle.value);
            return (
              <ChoiceCard
                key={angle.value}
                selected={selected}
                label={angle.label}
                description={angle.description}
                onClick={() =>
                  updateSetup(
                    "discoveryAngles",
                    selected
                      ? setup.discoveryAngles.filter((value) => value !== angle.value)
                      : [...setup.discoveryAngles, angle.value],
                  )
                }
              />
            );
          })}
        </div>
      </Field>
    </section>
  );
}

function SourcesStep({
  sources,
  isLoading,
  setup,
  updateSetup,
}: {
  sources: Array<{
    id: string;
    name: string;
    kind: string;
    provider: string | null;
    readiness: string;
    nextAction: string | null;
  }>;
  isLoading: boolean;
  setup: ScoutSetup;
  updateSetup: UpdateSetup;
}) {
  return (
    <section className="space-y-5">
      <Intro
        title="Where may this Scout look?"
        description="Source selection grants the listed read-only tools. Unready Sources stay visible but cannot be selected."
      />
      <div className="space-y-2">
        {isLoading && <p className="text-xs text-muted-foreground">Loading Sources…</p>}
        {!isLoading && sources.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
            No Sources are configured. Add one in Scout Run Center or configure Web Search in
            Settings.
          </p>
        )}
        {sources.map((source) => {
          const selected = setup.sourceIds.includes(source.id);
          const ready = source.readiness === "ready";
          return (
            <button
              key={source.id}
              type="button"
              disabled={!ready}
              onClick={() =>
                updateSetup(
                  "sourceIds",
                  selected
                    ? setup.sourceIds.filter((id) => id !== source.id)
                    : [...setup.sourceIds, source.id],
                )
              }
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border border-border p-3.5 text-left",
                ready ? "hover:bg-muted/60" : "cursor-not-allowed opacity-60",
                selected && "border-primary bg-primary/5",
              )}
            >
              <CheckBox selected={selected} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium">{source.name}</span>
                  <span
                    className={cn(
                      "rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground",
                      ready && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {ready ? "Ready" : readable(source.readiness)}
                  </span>
                </span>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  {readable(source.kind)}
                  {source.provider ? ` · ${source.provider}` : ""}
                </span>
                <span className="mt-2 flex flex-wrap gap-1">
                  {toolsForSource(source.kind).map((tool) => (
                    <span
                      key={tool}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                    >
                      {tool}
                    </span>
                  ))}
                </span>
                {!ready && source.nextAction && (
                  <span className="mt-2 block text-[11px] text-muted-foreground">
                    {source.nextAction}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <p className="text-[11px] font-medium">Run tools included</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {[
            "read_run_context",
            "list_selected_sources",
            "record_checkpoint",
            "record_source_outcome",
            "complete_run",
          ].map((tool) => (
            <span key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              {tool}
            </span>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Clock className="size-4 text-muted-foreground" />
          <div>
            <h4 className="text-xs font-medium">Freshness</h4>
            <p className="text-[11px] text-muted-foreground">
              Lookback, verification, and run cadence are different controls.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberSelect
            label="Job listings"
            hint="Maximum listing age"
            value={setup.listingLookbackDays}
            options={[
              [7, "Past 7 days"],
              [14, "Past 14 days"],
              [30, "Past 30 days"],
              [60, "Past 60 days"],
              [90, "Past 90 days"],
            ]}
            onChange={(value) => updateSetup("listingLookbackDays", value)}
          />
          <NumberSelect
            label="Social signals"
            hint="Maximum Signal age"
            value={setup.signalLookbackDays}
            options={[
              [1, "Past 24 hours"],
              [3, "Past 3 days"],
              [7, "Past 7 days"],
              [14, "Past 14 days"],
              [30, "Past 30 days"],
            ]}
            onChange={(value) => updateSetup("signalLookbackDays", value)}
          />
          <NumberSelect
            label="Verify active roles"
            hint="Required re-check age"
            value={setup.verificationHours}
            options={[
              [6, "Within 6 hours"],
              [12, "Within 12 hours"],
              [24, "Within 24 hours"],
              [72, "Within 3 days"],
              [168, "Within 7 days"],
            ]}
            onChange={(value) => updateSetup("verificationHours", value)}
          />
        </div>
      </div>
    </section>
  );
}

function BehaviorStep({
  name,
  setName,
  profileName,
  setup,
  updateSetup,
  selectedSourceNames,
  harness,
  setHarness,
  codexFound,
  generatedInstructions,
}: {
  name: string;
  setName: (name: string) => void;
  profileName: string;
  setup: ScoutSetup;
  updateSetup: UpdateSetup;
  selectedSourceNames: string[];
  harness: HarnessId;
  setHarness: (harness: HarnessId) => void;
  codexFound: boolean;
  generatedInstructions: string;
}) {
  return (
    <section className="space-y-5">
      <Intro
        title="How should this Scout work?"
        description="Presets become an explicit Discovery Strategy and Scout Policy you can edit later."
      />
      <Field label="Scout name">
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <EnumSelect
          label="Search effort"
          hint="How many query variations it attempts"
          value={setup.effort}
          options={[
            ["quick", "Quick"],
            ["balanced", "Balanced"],
            ["thorough", "Thorough"],
          ]}
          onChange={(value) => updateSetup("effort", value as ScoutSetup["effort"])}
        />
        <EnumSelect
          label="Search focus"
          hint="Precision versus discovery breadth"
          value={setup.focus}
          options={[
            ["precision", "High precision"],
            ["balanced", "Balanced"],
            ["broad", "Broad discovery"],
          ]}
          onChange={(value) => updateSetup("focus", value as ScoutSetup["focus"])}
        />
        <Field label="Run cadence" hint="Durable local schedule in this Mac's timezone">
          <div className="flex gap-2">
            <select
              value={setup.runCadence}
              onChange={(event) =>
                updateSetup("runCadence", event.target.value as ScoutSetup["runCadence"])
              }
              className={SELECT_CLASS}
            >
              <option value="manual">Manual only</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly · Monday</option>
            </select>
            {setup.runCadence !== "manual" && (
              <Input
                type="time"
                value={setup.runTime}
                onChange={(event) => updateSetup("runTime", event.target.value)}
                className="w-28"
              />
            )}
          </div>
        </Field>
        <EnumSelect
          label="Revisit promising Leads"
          hint="Policy for follow-up investigations"
          value={setup.revisitCadence}
          options={[
            ["never", "Only when requested"],
            ["weekly", "Weekly"],
            ["monthly", "Monthly"],
          ]}
          onChange={(value) => updateSetup("revisitCadence", value as ScoutSetup["revisitCadence"])}
        />
      </div>
      <label className="flex items-start gap-3 rounded-lg border border-border p-3.5">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={setup.includeInferredOpportunities}
          onChange={(event) => updateSetup("includeInferredOpportunities", event.target.checked)}
        />
        <span>
          <span className="block text-xs font-medium">Include inferred Opportunities</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            Allow evidence-backed employment paths without a formal listing. They must be labeled as
            inferred.
          </span>
        </span>
      </label>
      <div className="rounded-lg border border-border bg-muted/25 p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-xs font-medium">Review</span>
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <Summary label="Profile" value={profileName} />
          <Summary label="Roles" value={setup.targetRoles.join(", ")} />
          <Summary label="Sources" value={selectedSourceNames.join(", ")} />
          <Summary
            label="Freshness"
            value={`${setup.listingLookbackDays}d listings · ${setup.signalLookbackDays}d signals · verify ${setup.verificationHours}h`}
          />
          <Summary
            label="Runs"
            value={
              setup.runCadence === "manual"
                ? "Manual only"
                : `${readable(setup.runCadence)} at ${setup.runTime}`
            }
          />
          <Summary label="External actions" value="Cannot message, post, reply, or apply" />
        </dl>
      </div>
      <details className="rounded-lg border border-border p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium">
          <SlidersHorizontal className="size-4 text-muted-foreground" /> Advanced
        </summary>
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          <Field label="Reasoning harness" hint="Fixed after creation">
            <div className="grid grid-cols-2 gap-2">
              <HarnessChoice
                harness="claude"
                label="Claude Code"
                selected={harness === "claude"}
                onSelect={() => setHarness("claude")}
              />
              <HarnessChoice
                harness="codex"
                label="Codex"
                selected={harness === "codex"}
                disabled={!codexFound}
                hint={codexFound ? undefined : "CLI not found"}
                onSelect={() => setHarness("codex")}
              />
            </div>
          </Field>
          <Field label="Additional guidance" hint="Optional and specific to this search thesis">
            <Textarea
              value={setup.additionalGuidance}
              onChange={(event) => updateSetup("additionalGuidance", event.target.value)}
              rows={3}
              maxLength={2_000}
              placeholder="Prioritize developer-tool companies with small engineering teams."
            />
          </Field>
          <details>
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              Preview generated {harness === "codex" ? "AGENTS.md" : "CLAUDE.md"} specialty
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {generatedInstructions}
            </pre>
          </details>
        </div>
      </details>
    </section>
  );
}

function Intro({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <Label className="text-xs">{label}</Label>
        {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function ChoiceCard({
  selected,
  label,
  description,
  onClick,
}: {
  selected: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:bg-muted/60",
        selected && "border-primary bg-primary/5",
      )}
    >
      <CheckBox selected={selected} />
      <span>
        <span className="block text-xs font-medium">{label}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function CheckBox({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border",
        selected && "border-primary bg-primary text-primary-foreground",
      )}
    >
      {selected && <Check className="size-3" />}
    </span>
  );
}

function NumberSelect({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  options: Array<[number, string]>;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {options.map(([option, labelText]) => (
          <option key={option} value={option}>
            {labelText}
          </option>
        ))}
      </select>
    </Field>
  );
}

function EnumSelect({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([option, labelText]) => (
          <option key={option} value={option}>
            {labelText}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{value || "None"}</dd>
    </div>
  );
}

function HarnessChoice({
  harness,
  label,
  selected,
  disabled,
  hint,
  onSelect,
}: {
  harness: HarnessId;
  label: string;
  selected: boolean;
  disabled?: boolean;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left",
        selected && "border-primary bg-primary/5",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <HarnessGlyph harness={harness} />
      <span className="text-xs">{label}</span>
      {hint && <span className="ml-auto text-[10px] text-muted-foreground">{hint}</span>}
    </button>
  );
}

function readable(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toolsForSource(kind: string): string[] {
  if (kind === "web_search") return ["WebSearch", "WebFetch"];
  if (kind === "x") return ["XSearch", "XRead", "RecordSignal"];
  if (kind === "rss" || kind === "atom") return ["Feed discovery", "Record evidence"];
  return ["Read Source", "Record evidence"];
}
