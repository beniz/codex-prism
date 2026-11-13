import { create } from "zustand";
import { usePreviewStore } from "./preview-store";

export interface ReviewFindings {
  id: string;
  title: string;
  report: string;
  status: "pending" | "saved";
  reviewedCommit?: string;
}

interface ReviewFindingsState {
  projectId: string | null;
  tabs: ReviewFindings[];
  activeTab: string;
  open(projectId: string, findings: ReviewFindings): void;
  select(id: string): void;
  close(id: string): void;
  resetForProject(projectId: string | null): void;
}

export const useReviewFindingsStore = create<ReviewFindingsState>((set) => ({
  projectId: null,
  tabs: [],
  activeTab: "pdf",
  open: (projectId, findings) => {
    set((state) => {
      const tabs = state.projectId === projectId ? state.tabs : [];
      return {
        projectId,
        tabs: tabs.some((tab) => tab.id === findings.id)
          ? tabs.map((tab) => (tab.id === findings.id ? findings : tab))
          : [...tabs, findings],
        activeTab: findings.id,
      };
    });
    usePreviewStore.getState().setVisible(true);
  },
  select: (activeTab) => set({ activeTab }),
  close: (id) =>
    set((state) => ({
      tabs: state.tabs.filter((tab) => tab.id !== id),
      activeTab: state.activeTab === id ? "pdf" : state.activeTab,
    })),
  resetForProject: (projectId) =>
    set((state) =>
      state.projectId === projectId
        ? state
        : { projectId, tabs: [], activeTab: "pdf" },
    ),
}));
