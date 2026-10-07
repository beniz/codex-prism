import { migrateStorageKey } from "@/lib/legacy-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

interface ProjectState {
  recentProjects: RecentProject[];
  lastProjectFolder: string | null;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  renameRecentProject: (oldPath: string, newPath: string) => void;
  setLastProjectFolder: (path: string) => void;
}

const MAX_RECENT = 10;

function normalizeRecentPath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function recentProjectName(path: string): string {
  const normalized = normalizeRecentPath(path);
  return normalized.split(/[/\\]/).pop() || normalized;
}

function isSameProjectPath(a: string, b: string): boolean {
  return (
    normalizeRecentPath(a).toLowerCase() ===
    normalizeRecentPath(b).toLowerCase()
  );
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      recentProjects: [],
      lastProjectFolder: null,

      setLastProjectFolder: (path) => set({ lastProjectFolder: path }),

      addRecentProject: (path) => {
        const normalizedPath = normalizeRecentPath(path);
        const name = recentProjectName(normalizedPath);
        set((state) => {
          const filtered = state.recentProjects.filter(
            (p) => !isSameProjectPath(p.path, normalizedPath),
          );
          return {
            recentProjects: [
              { path: normalizedPath, name, lastOpened: Date.now() },
              ...filtered,
            ].slice(0, MAX_RECENT),
          };
        });
      },

      removeRecentProject: (path) => {
        set((state) => ({
          recentProjects: state.recentProjects.filter(
            (p) => !isSameProjectPath(p.path, path),
          ),
        }));
      },

      renameRecentProject: (oldPath, newPath) => {
        const normalizedNewPath = normalizeRecentPath(newPath);
        const name = recentProjectName(normalizedNewPath);
        set((state) => ({
          recentProjects: [
            { path: normalizedNewPath, name, lastOpened: Date.now() },
            ...state.recentProjects.filter(
              (p) =>
                !isSameProjectPath(p.path, oldPath) &&
                !isSameProjectPath(p.path, normalizedNewPath),
            ),
          ].slice(0, MAX_RECENT),
        }));
      },
    }),
    {
      name: migrateStorageKey("codex-prism-projects"),
      partialize: (state) => ({
        recentProjects: state.recentProjects,
        lastProjectFolder: state.lastProjectFolder,
      }),
    },
  ),
);
