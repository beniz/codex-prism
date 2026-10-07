import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";

interface SettingsState {
  compilerBackend: CompilerBackend;
  setCompilerBackend: (backend: CompilerBackend) => void;
  autoRecompile: boolean;
  setAutoRecompile: (enabled: boolean) => void;
  vimMode: boolean;
  setVimMode: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      compilerBackend: "tectonic",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
      autoRecompile: false,
      setAutoRecompile: (enabled) => set({ autoRecompile: enabled }),
      vimMode: false,
      setVimMode: (enabled) => set({ vimMode: enabled }),
    }),
    {
      name: "claude-prism-settings",
    },
  ),
);
