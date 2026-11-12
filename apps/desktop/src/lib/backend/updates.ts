import { invoke, listen } from "./index";
export interface UpdateStatus {
  runningVersion: string;
  installation: "appimage" | "macos" | "windows" | "deb" | "source" | "unknown";
  availableVersion: string | null;
  installedVersion: string | null;
  notes: string | null;
  releaseUrl: string;
  canInstall: boolean;
  ready: boolean;
}
export const updates = {
  check: (manual = false) => invoke<UpdateStatus>("update_check", { manual }),
  local: () => invoke<UpdateStatus>("update_local_status"),
  download: (version: string) => invoke<void>("update_download", { version }),
  install: (version: string) => invoke<void>("update_install", { version }),
  restartLocal: () => invoke<void>("update_restart_local"),
  progress: (cb: (p: { received: number; total: number | null }) => void) =>
    listen<{ received: number; total: number | null }>("update-progress", (e) =>
      cb(e.payload),
    ),
};
