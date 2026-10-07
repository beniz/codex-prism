import { migrateStorageKey } from "@/lib/legacy-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  autoRecompile: boolean;
  setAutoRecompile: (enabled: boolean) => void;
  vimMode: boolean;
  setVimMode: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      autoRecompile: false,
      setAutoRecompile: (enabled) => set({ autoRecompile: enabled }),
      vimMode: false,
      setVimMode: (enabled) => set({ vimMode: enabled }),
    }),
    {
      name: migrateStorageKey("codex-prism-settings"),
      version: 1,
      migrate: (persisted) => settingsPreferences(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...settingsPreferences(persisted),
      }),
      partialize: ({ autoRecompile, vimMode }) => ({ autoRecompile, vimMode }),
    },
  ),
);

/** Whitelist preferences so removed backend fields cannot return through hydration. */
export function settingsPreferences(value: unknown) {
  const state = (value ?? {}) as Record<string, unknown>;
  return {
    autoRecompile: state.autoRecompile === true,
    vimMode: state.vimMode === true,
  };
}
