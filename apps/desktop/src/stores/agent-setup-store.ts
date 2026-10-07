import { create } from "zustand";
import { backend, type CodexModel } from "@/lib/backend";
import { openExternal } from "@/lib/backend/desktop-host";
interface State {
  status: "checking" | "ready" | "not-authenticated" | "error";
  version: string | null;
  error: string | null;
  models: CodexModel[];
  loginInfo: string;
  checkStatus(): Promise<void>;
  login(device?: boolean): Promise<void>;
  logout(): Promise<void>;
}
export const useAgentSetupStore = create<State>((set, get) => ({
  status: "checking",
  version: null,
  error: null,
  models: [],
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
