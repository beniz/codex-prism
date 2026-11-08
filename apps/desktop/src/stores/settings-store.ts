import { migrateStorageKey } from "@/lib/legacy-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  incrementalCompilation: boolean;
  setIncrementalCompilation: (enabled: boolean) => void;
  autoRecompile: boolean;
  setAutoRecompile: (enabled: boolean) => void;
  visualChangeReports: boolean;
  setVisualChangeReports: (enabled: boolean) => void;
  vimMode: boolean;
  setVimMode: (enabled: boolean) => void;
  editorFontSize: number;
  setEditorFontSize: (size: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      incrementalCompilation: true,
      setIncrementalCompilation: (enabled) => set({ incrementalCompilation: enabled }),
      autoRecompile: false,
      setAutoRecompile: (enabled) => set({ autoRecompile: enabled }),
      visualChangeReports: false,
      setVisualChangeReports: (enabled) =>
        set({ visualChangeReports: enabled }),
      vimMode: false,
      setVimMode: (enabled) => set({ vimMode: enabled }),
      editorFontSize: 14,
      setEditorFontSize: (size) =>
        set({ editorFontSize: normalizeFontSize(size) }),
    }),
    {
      name: migrateStorageKey("codex-prism-settings"),
      version: 1,
      migrate: (persisted) => settingsPreferences(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...settingsPreferences(persisted),
      }),
      partialize: ({
        incrementalCompilation,
        autoRecompile,
        visualChangeReports,
        vimMode,
        editorFontSize,
      }) => ({
        incrementalCompilation,
        autoRecompile,
        visualChangeReports,
        vimMode,
        editorFontSize,
      }),
    },
  ),
);

function normalizeFontSize(size: unknown): number {
  return typeof size === "number" && Number.isFinite(size)
    ? Math.max(10, Math.min(32, Math.round(size)))
    : 14;
}

/** Whitelist preferences so removed backend fields cannot return through hydration. */
export function settingsPreferences(value: unknown) {
  const state = (value ?? {}) as Record<string, unknown>;
  return {
    incrementalCompilation: state.incrementalCompilation !== false,
    autoRecompile: state.autoRecompile === true,
    visualChangeReports: state.visualChangeReports === true,
    vimMode: state.vimMode === true,
    editorFontSize: normalizeFontSize(state.editorFontSize),
  };
}
