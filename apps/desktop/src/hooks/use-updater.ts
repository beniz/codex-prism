import { useCallback, useState } from "react";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "available"; version: string; notes?: string }
  | { state: "downloading"; percent: number }
  | { state: "installing" }
  | { state: "ready" }
  | { state: "error"; message: string };

// This fork has no update feed. Never query or install the upstream application's releases.
export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const checkForUpdate = useCallback(async () => {
    setStatus({ state: "error", message: "Automatic updates are not configured for Codex-Prism. Update your local checkout to install a new version." });
  }, []);
  const installUpdate = useCallback(async () => {}, []);
  return { status, checkForUpdate, installUpdate };
}
