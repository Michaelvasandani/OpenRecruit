import { create } from "zustand";

/** Top-level pane: the agent workspace, the full-screen Scheduled view, or Settings. */
export type AppView = "agents" | "scheduled" | "settings" | "profiles" | "runs";

interface UIState {
  selectedAgentId: string | null;
  selectedScoutId: string | null;
  view: AppView;
  /** Whether the New Agent configuration dialog is open. */
  newAgentOpen: boolean;
  select: (id: string | null) => void;
  selectScout: (id: string | null) => void;
  setView: (view: AppView) => void;
  openNewAgent: () => void;
  closeNewAgent: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedAgentId: null,
  selectedScoutId: null,
  view: "agents",
  newAgentOpen: false,
  select: (id) => set({ selectedAgentId: id }),
  selectScout: (id) => set({ selectedScoutId: id }),
  setView: (view) => set({ view }),
  openNewAgent: () => set({ newAgentOpen: true }),
  closeNewAgent: () => set({ newAgentOpen: false }),
}));
