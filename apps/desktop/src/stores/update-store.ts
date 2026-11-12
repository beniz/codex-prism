import { create } from "zustand";
import { updates, type UpdateStatus } from "@/lib/backend/updates";
import { useDocumentStore } from "./document-store";
import { useAgentChatStore, persistChatTabs } from "./agent-chat-store";
import { hasChatPdfWork } from "@/hooks/use-chat-pdf";

const KEY = "codex-prism-updates";
export const UPDATE_INTERVAL = 12 * 60 * 60 * 1000;
type Phase = "idle" | "checking" | "downloading" | "installing";
function preferences(): {
  automatic?: boolean;
  lastAttempt?: number;
  status?: UpdateStatus;
} {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}
const saved = preferences();
interface UpdateState {
  automatic: boolean;
  lastAttempt: number;
  status: UpdateStatus | null;
  phase: Phase;
  error: string | null;
  progress: { received: number; total: number | null } | null;
  open: boolean;
  setOpen(open: boolean): void;
  setAutomatic(value: boolean): void;
  check(manual?: boolean): Promise<void>;
  inspectLocal(force?: boolean): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
}
let lastLocalCheck = 0;
let localPending = false;
export function updateBlocker(): string | null {
  const chat = useAgentChatStore.getState();
  const doc = useDocumentStore.getState();
  if (chat.restoringChats) return "Wait for conversations to finish loading.";
  if (
    chat.tabs.some((t) => t.isStreaming) ||
    chat.proposals.some((p) =>
      ["running", "repairing", "applying"].includes(p.state),
    )
  )
    return "Wait for agent turns and proposal changes to finish.";
  if (doc.isCompiling || doc.pendingRecompile || hasChatPdfWork())
    return "Wait for PDF builds to finish.";
  if (doc.isSaving) return "Wait for saving to finish.";
  return null;
}
export const useUpdateStore = create<UpdateState>((set, get) => ({
  automatic: saved.automatic !== false,
  lastAttempt: typeof saved.lastAttempt === "number" ? saved.lastAttempt : 0,
  // Cached availability is informational; native capabilities are always rechecked.
  status: saved.status
    ? {
        ...saved.status,
        canInstall: false,
        ready: false,
        installedVersion: null,
      }
    : null,
  phase: "idle",
  error: null,
  progress: null,
  open: false,
  setOpen: (open) => {
    set({ open });
    if (open) {
      void get().inspectLocal(true);
      void get().check(true);
    }
  },
  setAutomatic: (automatic) => set({ automatic }),
  check: async (manual = false) => {
    const state = get();
    if (state.phase !== "idle") return;
    const now = Date.now();
    if (
      !manual &&
      (!state.automatic ||
        (now >= state.lastAttempt && now - state.lastAttempt < UPDATE_INTERVAL))
    )
      return;
    set({ phase: "checking", lastAttempt: now, error: null });
    try {
      set({ status: await updates.check(manual) });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ phase: "idle" });
    }
  },
  inspectLocal: async (force = false) => {
    if (
      localPending ||
      get().phase !== "idle" ||
      (!force && Date.now() - lastLocalCheck < 60_000)
    )
      return;
    localPending = true;
    lastLocalCheck = Date.now();
    try {
      const local = await updates.local();
      set((s) => ({
        status: {
          ...local,
          ...(s.status?.runningVersion === local.runningVersion
            ? s.status
            : {}),
          installation: local.installation,
          installedVersion: local.installedVersion,
        },
      }));
    } catch {
      /* Automatic local inspection stays quiet; manual checking reports feed errors. */
    } finally {
      localPending = false;
    }
  },
  download: async () => {
    if (get().phase !== "idle") return;
    // A cached indicator is never authority to install a package.
    await get().check(true);
    if (get().error || !get().status?.canInstall || get().phase !== "idle")
      return;
    set({ phase: "downloading", error: null, progress: null });
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await updates.progress((progress) => set({ progress }));
      await updates.download(get().status!.availableVersion!);
      set((s) => ({ status: s.status ? { ...s.status, ready: true } : null }));
    } catch (error) {
      set({ error: String(error) });
    } finally {
      unlisten?.();
      set({ phase: "idle" });
    }
  },
  install: async () => {
    if (get().phase !== "idle") return;
    const blocked = updateBlocker();
    if (blocked) {
      set({ error: blocked });
      return;
    }
    set({ phase: "installing", error: null });
    try {
      await useDocumentStore.getState().saveAllFiles();
      if (useDocumentStore.getState().files.some((f) => f.isDirty))
        throw new Error("Save failed. Resolve unsaved files before updating.");
      persistChatTabs();
      const doc = useDocumentStore.getState();
      localStorage.setItem(
        "codex-prism-update-session",
        JSON.stringify({
          root: doc.projectRoot,
          file: doc.files.find((f) => f.id === doc.activeFileId)?.relativePath,
        }),
      );
      const blocked = updateBlocker();
      if (blocked) throw new Error(blocked);
      if (get().status?.installedVersion) await updates.restartLocal();
      else if (get().status?.ready)
        await updates.install(get().status!.availableVersion!);
      else throw new Error("Download the update first.");
    } catch (error) {
      try {
        localStorage.removeItem("codex-prism-update-session");
      } catch {
        /* Report the original persistence failure. */
      }
      set({ error: String(error), phase: "idle" });
    }
  },
}));
useUpdateStore.subscribe((state, previous) => {
  if (
    state.automatic === previous.automatic &&
    state.lastAttempt === previous.lastAttempt &&
    state.status === previous.status
  )
    return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        automatic: state.automatic,
        lastAttempt: state.lastAttempt,
        status: state.status,
      }),
    );
  } catch {
    /* Checking remains usable without storage. */
  }
});

/** One coordinator for the entire application, with no interval ticks while idle. */
export function startUpdateChecks() {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const schedule = () => {
    clearTimeout(timer);
    if (
      stopped ||
      !useUpdateStore.getState().automatic ||
      useUpdateStore.getState().phase !== "idle"
    )
      return;
    const last = useUpdateStore.getState().lastAttempt;
    const delay = Math.max(
      1000,
      last > Date.now()
        ? 1000
        : Math.min(UPDATE_INTERVAL, last + UPDATE_INTERVAL - Date.now()),
    );
    timer = setTimeout(async () => {
      await useUpdateStore.getState().check();
      schedule();
    }, delay);
  };
  const focus = () => {
    void useUpdateStore.getState().inspectLocal();
    void useUpdateStore.getState().check();
  };
  const unsubscribe = useUpdateStore.subscribe((s, old) => {
    if (
      s.automatic !== old.automatic ||
      s.lastAttempt !== old.lastAttempt ||
      (s.phase === "idle" && old.phase !== "idle")
    )
      schedule();
  });
  window.addEventListener("focus", focus);
  void useUpdateStore.getState().inspectLocal(true);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    window.removeEventListener("focus", focus);
  };
}

/** Consume once after an updater restart; ordinary app launches keep their existing behaviour. */
export async function restoreUpdateSession() {
  try {
    const saved = localStorage.getItem("codex-prism-update-session");
    if (!saved) return;
    localStorage.removeItem("codex-prism-update-session");
    const session = JSON.parse(saved);
    if (
      typeof session.root !== "string" ||
      useDocumentStore.getState().projectRoot
    )
      return;
    await useDocumentStore.getState().openProject(session.root);
    const doc = useDocumentStore.getState();
    const file = doc.files.find((f) => f.relativePath === session.file);
    if (file) doc.setActiveFile(file.id);
  } catch (error) {
    useUpdateStore.setState({
      error: `Could not reopen the project after updating: ${String(error)}`,
      open: true,
    });
  }
}
