import { beginActivity } from "./activity-store";
import { toast } from "sonner";
import { create } from "zustand";
import { invoke, listen, backend } from "@/lib/backend";

export interface SnapshotInfo {
  id: string;
  message: string;
  timestamp: number;
  author_name?: string;
  author_email?: string;
  parent_ids?: string[];
  labels: string[];
  changed_files: string[];
}
export interface FileDiff {
  file_path: string;
  status: "added" | "modified" | "deleted";
  old_content: string | null;
  new_content: string | null;
}
export interface HistoryStatus {
  includePrompt: boolean;
  warning: string | null;
  pending: number;
  repositoryPath: string;
  archivePath: string | null;
  blockedReason: string | null;
}
interface HistoryState {
  projectRoot: string | null;
  projectId: string | null;
  snapshots: SnapshotInfo[];
  status: HistoryStatus | null;
  error: string | null;
  isLoading: boolean;
  hasMore: boolean;
  selectedSnapshotId: string | null;
  diffResult: FileDiff[] | null;
  isDiffLoading: boolean;
  isRestoring: boolean;
  reviewingSnapshot: SnapshotInfo | null;
  init(root: string): Promise<void>;
  createSnapshot(root: string, message: string): Promise<SnapshotInfo | null>;
  loadSnapshots(root: string): Promise<void>;
  loadMoreSnapshots(root: string): Promise<void>;
  retry(root: string): Promise<void>;
  setIncludePrompt(root: string, enabled: boolean): Promise<void>;
  selectSnapshot(id: string | null): void;
  loadDiff(root: string, fromId: string, toId: string): Promise<void>;
  getFileAt(
    root: string,
    snapshotId: string,
    filePath: string,
  ): Promise<string>;
  restoreSnapshot(root: string, snapshotId: string): Promise<SnapshotInfo>;
  addLabel(root: string, snapshotId: string, label: string): Promise<void>;
  removeLabel(root: string, label: string): Promise<void>;
  startReview(snapshot: SnapshotInfo): void;
  stopReview(): void;
  reset(): void;
}
const PAGE_SIZE = 50;
let generation = 0;
let request = 0;
let subscription: Promise<unknown> | undefined;
const initial = {
  projectRoot: null,
  projectId: null,
  snapshots: [],
  status: null,
  error: null,
  isLoading: false,
  hasMore: true,
  selectedSnapshotId: null,
  diffResult: null,
  isDiffLoading: false,
  isRestoring: false,
  reviewingSnapshot: null,
};
export const useHistoryStore = create<HistoryState>()((set, get) => ({
  ...initial,
  init: async (root) => {
    if (get().projectRoot !== root) {
      generation++;
      set({ ...initial, projectRoot: root });
    }
    const current = generation;
    subscription ??= listen<{ projectId: string; warning?: string | null }>(
      "project-history",
      ({ payload }) => {
        const s = useHistoryStore.getState();
        if (s.projectId === payload.projectId && s.projectRoot) {
          if (payload.warning)
            toast.warning(`Git history needs attention: ${payload.warning}`, {
              id: `history-${s.projectRoot}`,
            });
          void s.loadSnapshots(s.projectRoot);
        }
      },
    ).catch(() => {
      subscription = undefined;
    });
    try {
      const project = await backend.projects.register(root);
      if (generation !== current) return;
      set({ projectId: project.id });
      await invoke("history_init", { projectRoot: root });
    } catch (e) {
      if (generation === current) set({ error: String(e) });
    }
    if (generation === current) await get().loadSnapshots(root);
  },
  createSnapshot: async (root, message) => {
    try {
      return await invoke<SnapshotInfo | null>("history_snapshot", {
        projectRoot: root,
        message,
      });
    } finally {
      if (get().projectRoot === root) await get().loadSnapshots(root);
    }
  },
  loadSnapshots: async (root) => {
    if (get().projectRoot !== root) return;
    const current = generation;
    const ticket = ++request;
    const activity = beginActivity({ projectPath: root }, "history", { group: "build" });
    set({ isLoading: true });
    try {
      const [snapshots, status] = await Promise.all([
        invoke<SnapshotInfo[]>("history_list", {
          projectRoot: root,
          limit: Math.max(PAGE_SIZE, get().snapshots.length),
          offset: 0,
        }),
        invoke<HistoryStatus>("history_status", { projectRoot: root }),
      ]);
      if (current === generation && ticket === request) {
        if (status.warning && status.warning !== get().status?.warning)
          toast.warning(`Git history needs attention: ${status.warning}`, {
            id: `history-${root}`,
          });
        set({
          snapshots,
          status,
          error: null,
          hasMore:
            snapshots.length >= Math.max(PAGE_SIZE, get().snapshots.length),
        });
      }
    } catch (e) {
      if (current === generation && ticket === request)
        set({ error: String(e) });
    } finally {
      activity.finish();
      if (current === generation && ticket === request)
        set({ isLoading: false });
    }
  },
  loadMoreSnapshots: async (root) => {
    if (get().projectRoot !== root || get().isLoading || !get().hasMore) return;
    const current = generation;
    const ticket = ++request;
    set({ isLoading: true });
    try {
      const more = await invoke<SnapshotInfo[]>("history_list", {
        projectRoot: root,
        limit: PAGE_SIZE,
        offset: get().snapshots.length,
      });
      if (current === generation && ticket === request)
        set((s) => ({
          snapshots: [
            ...new Map(
              [...s.snapshots, ...more].map((s) => [s.id, s]),
            ).values(),
          ],
          hasMore: more.length === PAGE_SIZE,
        }));
    } catch (e) {
      if (current === generation && ticket === request)
        set({ error: String(e) });
    } finally {
      if (current === generation && ticket === request)
        set({ isLoading: false });
    }
  },
  retry: async (root) => {
    try {
      await invoke("history_retry", { projectRoot: root });
    } finally {
      await get().loadSnapshots(root);
    }
  },
  setIncludePrompt: async (root, enabled) => {
    await invoke("history_set_prompt", { projectRoot: root, enabled });
    await get().loadSnapshots(root);
  },
  selectSnapshot: (id) => set({ selectedSnapshotId: id, diffResult: null }),
  loadDiff: async (root, fromId, toId) => {
    const current = generation;
    set({ isDiffLoading: true, diffResult: null });
    try {
      const diffResult = await invoke<FileDiff[]>("history_diff", {
        projectRoot: root,
        fromId,
        toId,
      });
      if (current === generation) set({ diffResult });
    } finally {
      if (current === generation) set({ isDiffLoading: false });
    }
  },
  getFileAt: (root, snapshotId, filePath) =>
    invoke("history_file_at", { projectRoot: root, snapshotId, filePath }),
  restoreSnapshot: async (root, snapshotId) => {
    const current = generation;
    set({ isRestoring: true });
    try {
      return await invoke<SnapshotInfo>("history_restore", {
        projectRoot: root,
        snapshotId,
      });
    } finally {
      if (current === generation) {
        set({ isRestoring: false });
        await get().loadSnapshots(root);
      }
    }
  },
  addLabel: async (root, snapshotId, label) => {
    await invoke("history_add_label", { projectRoot: root, snapshotId, label });
    await get().loadSnapshots(root);
  },
  removeLabel: async (root, label) => {
    await invoke("history_remove_label", { projectRoot: root, label });
    await get().loadSnapshots(root);
  },
  startReview: (snapshot) => set({ reviewingSnapshot: snapshot }),
  stopReview: () => set({ reviewingSnapshot: null, diffResult: null }),
  reset: () => {
    generation++;
    set(initial);
  },
}));
