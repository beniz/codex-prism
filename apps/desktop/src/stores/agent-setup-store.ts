import { create } from "zustand";
import { backend, type CodexModel } from "@/lib/backend";
import { openExternal } from "@/lib/backend/desktop-host";
interface State {
  status:
    | "checking"
    | "ready"
    | "not-installed"
    | "not-authenticated"
    | "error"
    | "missing-git";
  version: string | null;
  error: string | null;
  models: CodexModel[];
  isInstalling: boolean;
  loginInfo: string;
  checkStatus(): Promise<void>;
  install(): Promise<void>;
  login(device?: boolean): Promise<void>;
  logout(): Promise<void>;
}
export const useAgentSetupStore = create<State>((set, get) => ({
  status: "checking",
  version: null,
  error: null,
  models: [],
  isInstalling: false,
  loginInfo: "",
  checkStatus: async () => {
    try {
      const s = await backend.agent.status();
      set({
        status:
          s.account.account || !s.account.requiresOpenaiAuth
            ? "ready"
            : "not-authenticated",
        version: s.version,
        models: s.models.data,
        error: null,
      });
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  },
  install: async () => {
    set({
      error:
        "Install Codex CLI separately, then refresh, or set its executable path below.",
    });
  },
  login: async (device = false) => {
    try {
      const r = await backend.agent.account(device ? "device" : "login");
      if (r.authUrl) await openExternal(r.authUrl);
      if (r.verificationUrl) {
        set({ loginInfo: `Open ${r.verificationUrl} and enter ${r.userCode}` });
        await openExternal(r.verificationUrl);
      }
      set({ error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  logout: async () => {
    await backend.agent.account("logout");
    await get().checkStatus();
  },
}));
