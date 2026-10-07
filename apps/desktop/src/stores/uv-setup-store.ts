import { create } from "zustand";
import { invoke } from "@/lib/backend";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("uv");
let inspection = 0;

// ─── Types ───

interface UvStatus {
  installed: boolean;
  binary_path: string | null;
  version: string | null;
}

interface VenvInfo {
  venv_path: string;
  python_path: string;
  created: boolean;
}

type UvSetupStatus = "checking" | "not-installed" | "ready" | "error";

interface UvSetupState {
  status: UvSetupStatus;
  isInstalling: boolean;
  error: string | null;
  version: string | null;
  binaryPath: string | null;

  // venv state
  venvReady: boolean;
  venvPath: string | null;
  pythonPath: string | null;

  // Actions
  checkStatus: () => Promise<void>;
  install: () => Promise<void>;
  setupVenv: (projectPath: string) => Promise<void>;
  inspectVenv: (projectPath: string) => Promise<void>;

  // Internal
  _finishInstall: (success: boolean) => void;
}

// ─── Store ───

export const useUvSetupStore = create<UvSetupState>((set, get) => ({
  status: "checking",
  isInstalling: false,
  error: null,
  version: null,
  binaryPath: null,

  venvReady: false,
  venvPath: null,
  pythonPath: null,

  checkStatus: async () => {
    set({ status: "checking", error: null });
    try {
      const result = await invoke<UvStatus>("check_uv_status");

      if (!result.installed) {
        log.info("uv not installed");
        set({ status: "not-installed", version: null, binaryPath: null });
        return;
      }

      log.info(`uv ready: v${result.version}`);
      set({
        status: "ready",
        version: result.version,
        binaryPath: result.binary_path,
      });
    } catch (err: any) {
      set({
        status: "error",
        error: err?.message || String(err),
      });
    }
  },

  install: async () => {
    set({ isInstalling: true, error: null });
    try {
      await invoke("install_uv");
      // Completion is driven by the "uv-install-complete" event
    } catch (err: any) {
      set({
        isInstalling: false,
        status: "error",
        error: err?.message || String(err),
      });
    }
  },

  inspectVenv: async (projectPath: string) => {
    const request = ++inspection;
    set({ venvReady: false, venvPath: null, pythonPath: null });
    try {
      const info = await invoke<VenvInfo | null>("project_venv_status", {
        projectPath,
      });
      if (request !== inspection) return;
      set({
        venvReady: !!info,
        venvPath: info?.venv_path ?? null,
        pythonPath: info?.python_path ?? null,
      });
    } catch {
      // Optional environment detection never blocks the workspace.
    }
  },

  setupVenv: async (projectPath: string) => {
    const request = ++inspection;
    try {
      const info = await invoke<VenvInfo>("setup_project_venv", {
        projectPath,
      });
      if (request !== inspection) return;
      log.info(`Venv ready at ${info.venv_path}`);
      set({
        venvReady: true,
        venvPath: info.venv_path,
        pythonPath: info.python_path,
      });
    } catch (err: any) {
      if (request !== inspection) return;
      log.error("Failed to setup venv", { error: String(err) });
      // Don't set error status — uv itself is fine, just venv creation failed
      set({
        venvReady: false,
        venvPath: null,
        pythonPath: null,
      });
    }
  },

  _finishInstall: (success: boolean) => {
    if (success) {
      set({ isInstalling: false });
      get().checkStatus();
    } else {
      set({
        isInstalling: false,
        status: "error",
        error:
          "uv installation failed. Check your internet connection and try again.",
      });
    }
  },
}));
