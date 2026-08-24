import { AlertTriangle, ArrowRight, Check, Loader2, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { FeatureShowcase } from "../components/onboarding/FeatureShowcase";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useTrackEvent } from "../hooks/useAnalytics";
import { useUpdateSettings } from "../hooks/useSettings";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { useUIStore } from "../stores/ui";

type Step = "runtime" | "showcase" | "agent";
const STEPS: Step[] = ["runtime", "showcase", "agent"];
const STEP_LABELS: Record<Step, string> = {
  runtime: "Local runtime",
  showcase: "Recruiting workflow",
  agent: "First Scout",
};

export function Onboarding() {
  const [step, setStep] = useState<Step>("runtime");
  const finishSettings = useUpdateSettings();
  const track = useTrackEvent();

  useEffect(() => {
    track({ event: "onboarding_started" });
  }, [track]);

  const finish = () => {
    track({ event: "onboarding_completed" });
    finishSettings.mutate({ onboardingComplete: true });
  };
  const next = () => {
    track({ event: "onboarding_step_completed", props: { step } });
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
    else finish();
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-8">
      <div className={cn("w-[30rem]", step === "showcase" && "w-full max-w-5xl")}>
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">OpenRecruit</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A private, local workspace for Candidate Profiles and Scout Runs.
          </p>
        </div>
        <Stepper current={step} />
        {step === "showcase" ? (
          <FeatureShowcase onNext={next} className="mt-10" />
        ) : (
          <Card className="mt-6 rounded-lg p-5">
            {step === "runtime" && <RuntimeStep onNext={next} />}
            {step === "agent" && <AgentStep onDone={finish} pending={finishSettings.isPending} />}
          </Card>
        )}
        <button
          type="button"
          onClick={finish}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          Skip setup
        </button>
      </div>
    </div>
  );
}

function Stepper({ current }: { current: Step }) {
  const currentIdx = STEPS.indexOf(current);
  return (
    <div className="flex items-center justify-center gap-2">
      {STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-xs font-medium",
              i < currentIdx && "bg-success text-white",
              i === currentIdx && "bg-primary text-primary-foreground",
              i > currentIdx && "bg-muted text-muted-foreground",
            )}
          >
            {i < currentIdx ? <Check className="size-3.5" /> : i + 1}
          </div>
          <span
            className={cn(
              "text-xs",
              i === currentIdx ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {STEP_LABELS[s]}
          </span>
          {i < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function RuntimeStep({ onNext }: { onNext: () => void }) {
  const probe = trpc.onboarding.harnesses.useQuery();
  const anyFound = probe.data?.claude.found || probe.data?.codex.found;
  const row = (label: string, r?: { found: boolean; version: string | null }) => (
    <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {probe.isLoading ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking…
        </span>
      ) : r?.found ? (
        <span className="flex items-center gap-2 text-success">
          <Check className="size-4" /> {r.version}
        </span>
      ) : (
        <span className="flex items-center gap-2 text-warning">
          <AlertTriangle className="size-4" /> Not found
        </span>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Terminal className="mt-0.5 size-5 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">Local agent runtime</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            OpenRecruit keeps Candidate data on this Mac and uses Claude Code or Codex only as a
            local reasoning harness.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {row("Claude Code", probe.data?.claude)}
        {row("Codex", probe.data?.codex)}
      </div>
      {!anyFound && !probe.isLoading && (
        <p className="text-xs text-muted-foreground">
          Install one supported CLI before starting a Scout. You can continue and configure it
          later.
        </p>
      )}
      <div className="flex justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => probe.refetch()}
          className="text-muted-foreground"
        >
          Re-check
        </Button>
        <Button type="button" onClick={onNext}>
          Continue <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function AgentStep({ onDone, pending }: { onDone: () => void; pending: boolean }) {
  const [name, setName] = useState("My first Scout");
  const select = useUIStore((s) => s.select);
  const create = trpc.agents.create.useMutation({
    onSuccess: (agent) => {
      select(agent.id);
      onDone();
    },
  });
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    create.mutate({ name: trimmed, template: "default" });
  };
  const busy = create.isPending || pending;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">Create your first Scout</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A Scout will use your confirmed Candidate Profile and selected Sources to find employment
          paths. You can configure it from the Scout workspace.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-agent-name">Name</Label>
        <Input
          id="onboarding-agent-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          maxLength={80}
          className="px-2"
        />
      </div>
      {create.isError && <p className="text-xs text-destructive">Couldn’t create the Scout.</p>}
      <div className="flex justify-end">
        <Button type="button" onClick={submit} disabled={busy || !name.trim()}>
          {busy && <Loader2 className="size-4 animate-spin" />} Create Scout
        </Button>
      </div>
    </div>
  );
}
