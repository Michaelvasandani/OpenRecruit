import { Bell, Bot, Info, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { SettingsRow } from "../components/settings/SettingsRow";
import { SettingsSection } from "../components/settings/SettingsSection";
import { SettingNumber } from "../components/settings/SettingNumber";
import { SettingToggle } from "../components/settings/SettingToggle";
import { Button } from "../components/ui/button";
import { useAgents } from "../hooks/useAgents";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { useUIStore } from "../stores/ui";

type CategoryId = "general" | "agents" | "notifications" | "about";
const CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "agents", label: "Scouts and agents", icon: Bot },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "about", label: "About", icon: Info },
];
const DRAG = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

export function SettingsScreen() {
  const [category, setCategory] = useState<CategoryId>("general");
  const active = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];
  return (
    <div className="flex min-w-0 flex-1 bg-background">
      <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
        <div className="h-10 shrink-0" style={DRAG} />
        <div className="px-3 pb-2 pt-1">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Settings
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2" style={NO_DRAG}>
          {CATEGORIES.map((c) => {
            const Icon = c.icon;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  category === c.id
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {c.label}
              </button>
            );
          })}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-10 shrink-0 items-center border-b border-border px-6 text-sm font-medium"
          style={DRAG}
        >
          {active.label}
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl p-6">
            {category === "general" && <GeneralPanel />}
            {category === "agents" && <AgentsPanel />}
            {category === "notifications" && <NotificationsPanel />}
            {category === "about" && <AboutPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const setView = useUIStore((s) => s.setView);
  const s = settings.data;
  if (!s) return null;
  return (
    <div className="space-y-8">
      <SettingsSection
        title="OpenRecruit"
        description="A local Candidate workspace for private, evidence-backed discovery."
      >
        <SettingsRow label="Show OpenRecruit in the menu bar">
          <SettingToggle
            checked={s.showInMenuBar}
            onChange={(showInMenuBar) => update.mutate({ showInMenuBar })}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Setup">
        <SettingsRow label="Re-run setup" hint="Reopen the local runtime and first Scout setup.">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              update.mutate({ onboardingComplete: false });
              setView("agents");
            }}
          >
            Re-run setup
          </Button>
        </SettingsRow>
      </SettingsSection>
      {window.__opentradeShell && (
        <SettingsSection title="Runtime">
          <SettingsRow
            label="Quit OpenRecruit completely"
            hint="Stops the detached host and all local sessions."
          >
            <Button
              type="button"
              variant="outline"
              onClick={() => void window.__opentradeShell?.quitCompletely()}
            >
              Quit completely
            </Button>
          </SettingsRow>
        </SettingsSection>
      )}
    </div>
  );
}

function AgentsPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  if (!s) return null;
  return (
    <div className="space-y-8">
      <SettingsSection
        title="Background Scout Runs"
        description="Bounded local runtime behavior for scheduled and revisit-triggered Runs."
      >
        <SettingsRow
          label="Background turn limit"
          hint="Pause a local harness after a set number of turns."
        >
          <SettingToggle
            checked={s.headlessTurnLimitEnabled}
            onChange={(headlessTurnLimitEnabled) => update.mutate({ headlessTurnLimitEnabled })}
          />
        </SettingsRow>
        {s.headlessTurnLimitEnabled && (
          <SettingsRow label="Maximum turns" hint="Number of turns available between resets.">
            <SettingNumber
              value={s.maxHeadlessTurns}
              min={1}
              max={1000}
              suffix="turns"
              onCommit={(maxHeadlessTurns) => update.mutate({ maxHeadlessTurns })}
            />
          </SettingsRow>
        )}
        <SettingsRow label="Maximum Run time" hint="Maximum duration of a bounded local Run.">
          <SettingNumber
            value={s.maxHeadlessRunMinutes}
            min={5}
            max={60}
            suffix="minutes"
            onCommit={(maxHeadlessRunMinutes) => update.mutate({ maxHeadlessRunMinutes })}
          />
        </SettingsRow>
      </SettingsSection>
      <AgentList />
    </div>
  );
}

function AgentList() {
  const agents = useAgents();
  return (
    <SettingsSection
      title="Local harnesses"
      description="Claude Code and Codex sessions remain local operational tools; Candidate review lives in Profiles, Scouts, Runs, Sources, and Review."
    >
      <div className="space-y-2 text-sm text-muted-foreground">
        {agents.length === 0
          ? "No local harnesses configured."
          : agents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between rounded border border-border px-3 py-2"
              >
                <span className="text-foreground">{agent.name}</span>
                <span>{agent.harness}</span>
              </div>
            ))}
      </div>
    </SettingsSection>
  );
}

function NotificationsPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  if (!s) return null;
  return (
    <SettingsSection
      title="Notifications"
      description="Local wake and bounded-runtime notifications from OpenRecruit."
    >
      <SettingsRow
        label="Scout wake-ups"
        hint="Notify when a scheduled, Source Event, or revisit wake starts work."
      >
        <SettingToggle
          checked={s.notifyWakes}
          onChange={(notifyWakes) => update.mutate({ notifyWakes })}
        />
      </SettingsRow>
      <SettingsRow
        label="Run limit pauses"
        hint="Notify when a local Scout Run reaches its configured turn limit."
      >
        <SettingToggle
          checked={s.notifyRestricted}
          onChange={(notifyRestricted) => update.mutate({ notifyRestricted })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function AboutPanel() {
  const retention = trpc.system.claudeRetention.useQuery();
  return (
    <SettingsSection
      title="About OpenRecruit"
      description="Source-built local POC. Public release feeds and auto-updates are intentionally disabled."
    >
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          OpenRecruit keeps Candidate Profiles, Source provenance, Scout Runs, and review decisions
          on this Mac.
        </p>
        {retention.data && (
          <p>
            Harness transcript retention: {retention.data.days} days ({retention.data.settingsPath}
            ).
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
