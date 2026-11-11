import { sourcePromptText, sourceRequest } from "@/lib/source-completion";
import { readChatTabs, writeChatTabs } from "@/lib/chat-tabs";
import { toast } from "sonner";
import { coalescedRefresh } from "@/lib/coalesced-refresh";
import { create } from "zustand";
import { useSettingsStore } from "./settings-store";
import {
  backend,
  type AgentEvent,
  type Review,
  type Proposal,
  proposals,
} from "@/lib/backend";
import {
  resolveTexRoot,
  getCurrentPdfRootId,
  useDocumentStore,
} from "./document-store";
export interface PromptContextOverride {
  chatId?: string;
  label: string;
  filePath: string;
  selectedText: string;
  temporaryFilePaths?: string[];
  imageDataUrl?: string;
}
export interface ChatItem {
  id: string;
  type: string;
  text: string;
  status?: string;
  phase?: "commentary" | "final_answer" | null;
  activity?: Record<string, any>;
}
export interface TabState {
  mode?: "plan" | "default";
  id: string;
  title: string;
  projectPath: string | null;
  sessionId: string | null;
  turnId: string | null;
  messages: ChatItem[];
  isStreaming: boolean;
  error: string | null;
  draft: string;
}
interface ChatState {
  restoringChats: boolean;
  tabs: TabState[];
  activeTabId: string;
  error: string | null;
  isStreaming: boolean;
  projectId: string | null;
  activeProjectPath: string | null;
  review: Review;
  proposals: Proposal[];
  decideProposal(action: "apply" | "discard" | "repair"): Promise<void>;
  locked: boolean;
  requests: AgentEvent[];
  selectedModel: string;
  effortLevel: string;
  pendingInitialPrompt: string | null;
  pendingAttachments: PromptContextOverride[];
  setPendingInitialPrompt(p: string): void;
  consumePendingInitialPrompt(): string | null;
  addPendingAttachment(p: PromptContextOverride): void;
  requestPinnedContextRemoval(labels: string[]): void;
  resetForProject(root: string | null): void;
  newSession(): void;
  createTab(): string;
  setActiveTab(id: string): void;
  closeTab(id: string): void;
  sendPrompt(prompt: string, context?: PromptContextOverride): Promise<void>;
  cancelExecution(): Promise<void>;
  resumeSession(id: string, title?: string): Promise<void>;
  refreshReview(): Promise<void>;
  resolveReview(path: string | string[], undo: boolean): Promise<void>;
  keepAllReview(): Promise<void>;
  reloadReview(): Promise<void>;
  respond(request: AgentEvent, result: unknown): Promise<void>;
  handleEvent(event: AgentEvent): void;
}
const tab = (): TabState => ({
  id: crypto.randomUUID(),
  title: "New Chat",
  projectPath: null,
  sessionId: null,
  turnId: null,
  messages: [],
  isStreaming: false,
  error: null,
  draft: "",
});
const first = tab();
let projectGeneration = 0;
const submissions = new Set<string>();
const reviewQueue = coalescedRefresh();
// One notification per batch, regardless of how many fragments/items arrived.
const deltas = new Map<
  string,
  {
    tabId: string;
    sessionId: string | null;
    projectId: string | null;
    item: ChatItem;
  }
>();
let deltaTimer: ReturnType<typeof setTimeout> | undefined;
function clearDeltas() {
  clearTimeout(deltaTimer);
  deltaTimer = undefined;
  deltas.clear();
}
function flushDeltas() {
  clearTimeout(deltaTimer);
  deltaTimer = undefined;
  if (!deltas.size) return;
  const batch = [...deltas.values()];
  deltas.clear();
  useAgentChatStore.setState((s) => {
    const tabs = s.tabs.map((t) => {
      const updates = batch.filter(
        (d) =>
          d.projectId === s.projectId &&
          d.tabId === t.id &&
          d.sessionId === t.sessionId,
      );
      if (!updates.length) return t;
      const messages = [...t.messages];
      for (const { item } of updates) {
        const index = messages.findIndex((m) => m.id === item.id);
        if (index < 0) messages.push(item);
        else
          messages[index] = {
            ...messages[index],
            text: messages[index].text + item.text,
          };
      }
      return { ...t, messages };
    });
    return tabs.every((t, i) => t === s.tabs[i]) ? s : { tabs };
  });
}
export const useAgentChatStore = create<ChatState>((set, get) => ({
  restoringChats: false,
  tabs: [first],
  activeTabId: first.id,
  error: null,
  isStreaming: false,
  projectId: null,
  activeProjectPath: null,
  proposals: [],
  decideProposal: async (action) => {
    const state = get();
    const p = activeProposal(state);
    if (!p) return;
    try {
      const result = await proposals.operate(p, action);
      await get().refreshReview();
      if (result?.historyWarning)
        toast.warning(
          `Changes applied, but history could not be saved: ${result.historyWarning}`,
        );
      if (
        action === "repair" &&
        result?.prompt &&
        get().projectId === p.projectId
      ) {
        const owner = get().tabs.find(
          (t) => t.sessionId === p.threadId || t.id === p.chatId,
        );
        if (owner) get().setActiveTab(owner.id);
        await get().sendPrompt(result.prompt);
      }
      if (
        action === "apply" &&
        !result?.conflicts?.length &&
        get().projectId === p.projectId
      ) {
        const doc = useDocumentStore.getState();
        await doc.refreshFiles();
        const { compileLatex, loadExistingPdf, resolveCompileTarget, formatCompileError } =
          await import("@/lib/latex-compiler");
        const target = resolveCompileTarget(
          getCurrentPdfRootId() ?? doc.activeFileId,
          doc.files,
        );
        if (target && doc.projectRoot) {
          if (result?.reusedBuilds?.includes(target.targetPath)) {
            const pdf = await loadExistingPdf(doc.projectRoot, target.targetPath).catch(() => null);
            if (pdf && get().projectId === p.projectId) {
              doc.setPdfData(pdf, target.rootId);
              return;
            }
          }
          doc.setIsCompiling(true);
          try {
            const pdf = await compileLatex(doc.projectRoot, target.targetPath);
            if (get().projectId === p.projectId)
              doc.setPdfData(pdf, target.rootId);
          } catch (e) {
            if (get().projectId === p.projectId)
              doc.setCompileError(formatCompileError(e), target.rootId);
          } finally {
            if (get().projectId === p.projectId) doc.setIsCompiling(false);
          }
        }
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },
  review: { active: false, changes: [] },
  locked: false,
  requests: [],
  selectedModel: "gpt-5.6-sol",
  effortLevel: "xhigh",
  pendingInitialPrompt: null,
  pendingAttachments: [],
  setPendingInitialPrompt: (pendingInitialPrompt) =>
    set({ pendingInitialPrompt }),
  consumePendingInitialPrompt: () => {
    const p = get().pendingInitialPrompt;
    set({ pendingInitialPrompt: null });
    return p;
  },
  addPendingAttachment: (p) =>
    set((s) => ({ pendingAttachments: [...s.pendingAttachments, p] })),
  requestPinnedContextRemoval: (labels) =>
    set((s) => ({
      pendingAttachments: s.pendingAttachments.filter(
        (p) => !labels.includes(p.label),
      ),
    })),
  resetForProject: (root) => {
    if (get().activeProjectPath === root) return;
    const generation = ++projectGeneration;
    clearDeltas();
    const saved = root ? readChatTabs(root) : null;
    const t = tab();
    set({
      restoringChats: !!root,
      selectedModel: saved?.selectedModel ?? "gpt-5.6-sol",
      effortLevel: saved?.effortLevel ?? "xhigh",
      tabs: [t],
      activeTabId: t.id,
      activeProjectPath: root,
      projectId: null,
      review: { active: false, changes: [] },
      proposals: [],
      locked: !!root,
      requests: [],
      error: null,
      isStreaming: false,
    });
    if (root) void (async () => {
      try {
        const p = await backend.projects.register(root);
        await ensureAgentEvents();
        const sessions = await backend.agent.sessions(p.id);
        const candidates = saved?.tabs ?? (sessions.length ? [{
          id: crypto.randomUUID(), title: sessions[0].title,
          sessionId: sessions[0].id, draft: "",
        }] : []);
        const restored = await Promise.all(candidates
          .filter((t) => !t.sessionId || sessions.some((s) => s.id === t.sessionId))
          .map(async (savedTab): Promise<TabState> => {
            const t = { ...tab(), ...savedTab, projectPath: root };
            if (t.sessionId) {
              try {
                const result = await backend.agent.thread(p.id, t.sessionId, "read");
                t.messages = (result.thread?.turns ?? []).flatMap((turn: any) =>
                  (turn.items ?? []).map((item: any) => { const mapped = toItem(item); return mapped.type === "proposedPlan" ? { ...mapped, status: turn.status } : mapped; }));
              } catch (e) {
                t.error = `Could not restore conversation: ${String(e)}`;
              }
            }
            return t;
          }));
        if (generation !== projectGeneration) return;
        const tabs = restored.length ? restored : [t];
        const active = tabs.find((t) => t.id === saved?.activeTabId) ?? tabs[0];
        set({ tabs, activeTabId: active.id, projectId: p.id,
          error: active.error });
        await get().refreshReview();
        if (generation !== projectGeneration) return;
        set((s) => {
          const tabs = s.tabs.map((t) => {
            const pending = s.proposals.find((p) =>
              p.threadId === t.sessionId && ["running", "repairing"].includes(p.state));
            return pending ? { ...t, isStreaming: true, turnId: pending.turnId ?? null } : t;
          });
          return { tabs, restoringChats: false, isStreaming: !!tabs.find((t) => t.id === s.activeTabId)?.isStreaming };
        });
      } catch (e) {
        if (generation === projectGeneration)
          set({ restoringChats: false, error: `Could not restore chats: ${String(e)}` });
      }
    })();
  },
  createTab: () => {
    if (get().restoringChats) return get().activeTabId;
    const t = tab();
    set((s) => ({
      tabs: [...s.tabs, t],
      activeTabId: t.id,
      error: null,
      isStreaming: false,
    }));
    return t.id;
  },
  newSession: () => {
    get().createTab();
  },
  setActiveTab: (id) => {
    const t = get().tabs.find((t) => t.id === id);
    if (t)
      set({
        activeTabId: id,
        error: t.error,
        isStreaming: t.isStreaming,
      });
  },
  closeTab: (id) => {
    if (get().restoringChats) return;
    if (get().tabs.find((t) => t.id === id)?.isStreaming) return;
    let tabs = get().tabs.filter((t) => t.id !== id);
    if (!tabs.length) tabs = [tab()];
    set({
      tabs,
      activeTabId: tabs[0].id,
      error: tabs[0].error,
      isStreaming: tabs[0].isStreaming,
    });
  },
  refreshReview: async () => {
    const id = get().projectId;
    if (!id) return;
    return reviewQueue(id, async () => {
      if (get().projectId !== id) return;
      const [review, pending] = await Promise.all([
        backend.review.get(id),
        proposals.list(id),
      ]);
      if (get().projectId !== id) return;
      set((s) => ({
        review,
        proposals: pending,
        locked:
          review.active ||
          review.changes.length > 0 ||
          pending.length > 0 ||
          s.tabs.some((t) => t.isStreaming),
      }));
    });
  },
  reloadReview: async () => {
    const id = get().projectId;
    if (!id || get().review.active) return;
    try {
      const review = await backend.review.refresh(id);
      if (get().projectId !== id) return;
      set({
        review,
        locked:
          review.active ||
          review.changes.length > 0 ||
          get().proposals.length > 0 ||
          get().tabs.some((t) => t.isStreaming),
        error: null,
      });
      await useDocumentStore.getState().refreshFiles();
    } catch (error) {
      if (get().projectId === id) set({ error: String(error) });
    }
  },
  keepAllReview: async () => {
    const review = get().review;
    if (review.active) return;
    await get().resolveReview(
      review.changes.map((change) => change.path),
      false,
    );
  },
  resolveReview: async (path, undo) => {
    const id = get().projectId;
    const paths = Array.isArray(path) ? path : [path];
    if (!id || !paths.length) return;
    set({ error: null });
    try {
      const result = await backend.review.resolveBatch(
        id,
        paths,
        undo,
        get().review.revision,
      );
      if (result.historyWarning && get().projectId === id) {
        toast.warning(
          `Changes kept, but history could not be saved: ${result.historyWarning}`,
        );
      }
      await get().refreshReview();
      if (
        get().projectId !== id ||
        useDocumentStore.getState().projectId !== id
      )
        return;
      await useDocumentStore.getState().refreshFiles();
      // Keep refreshes the ordinary preview even with Auto off or other files pending.
      // Partial Undo still uses the rebuilt visual artifact until review is complete.
      if ((!undo || !get().locked) && get().projectId === id) {
        const doc = useDocumentStore.getState();
        const { compileLatex, resolveCompileTarget, formatCompileError } =
          await import("@/lib/latex-compiler");
        if (useDocumentStore.getState().projectId !== id || get().review.active)
          return;
        const target = resolveCompileTarget(
          getCurrentPdfRootId() ?? doc.activeFileId,
          doc.files,
        );
        if (target && doc.projectRoot) {
          doc.setIsCompiling(true);
          try {
            const pdf = await compileLatex(doc.projectRoot, target.targetPath);
            if (useDocumentStore.getState().projectId === id)
              doc.setPdfData(pdf, target.rootId);
          } catch (error) {
            if (useDocumentStore.getState().projectId === id)
              doc.setCompileError(formatCompileError(error), target.rootId);
          } finally {
            if (useDocumentStore.getState().projectId === id)
              doc.setIsCompiling(false);
          }
        } else {
          doc.setPdfData(null);
        }
      }
    } catch (e) {
      if (get().projectId === id) {
        // Reflect any decisions already saved before a batch failed.
        await get()
          .refreshReview()
          .catch(() => {});
        if (get().projectId === id) set({ error: String(e) });
      }
    }
  },
  sendPrompt: async (prompt, context) => {
    if (get().restoringChats) return;
    try {
      await ensureAgentEvents();
    } catch (e) {
      set({ error: String(e) });
      return;
    }
    const state = get();
    const t = state.tabs.find((t) => t.id === state.activeTabId);
    if (!t) return;
    if (submissions.has(t.id)) return;
    if (state.projectId && /(^|[\s(])@[A-Za-z0-9_-]+:/.test(prompt)) {
      try { await sourceRequest(state.projectId, t.id, "source_reference_check", { prompt }); }
      catch (e) {
        if (get().projectId === state.projectId && get().activeTabId === t.id) set({ error: String(e) });
        return;
      }
      if (get().projectId !== state.projectId || get().activeTabId !== t.id) return;
      const current = get().tabs.find(x => x.id === t.id);
      if (!current || current.turnId !== t.turnId || current.isStreaming !== t.isStreaming || current.sessionId !== t.sessionId) {
        set({ error: "This chat changed while checking references. Send the prompt again." });
        return;
      }
    }
    if (t.isStreaming) {
      if (state.projectId && t.sessionId && t.turnId)
        try {
          await backend.agent.control(
            state.projectId,
            t.sessionId,
            t.turnId,
            context
              ? `[${context.label}; project file: ${context.filePath}]\n${context.selectedText}\n\n${prompt}`
              : prompt,
          );
          set(s => ({ tabs: s.tabs.map(x => x.id === t.id && x.draft === prompt ? { ...x, draft: "" } : x) }));
        } catch (e) {
          set({ error: String(e) });
        }
      return;
    }
    if (state.review.active || state.review.changes.length) {
      set({
        error: "Resolve the legacy project review before starting a proposal.",
      });
      return;
    }
    const doc = useDocumentStore.getState();
    if (!doc.projectRoot) {
      set({ error: "Open a project first" });
      return;
    }
    if (submissions.has(t.id)) return;
    submissions.add(t.id);
    try {
      await doc.saveAllFiles();
      if (useDocumentStore.getState().files.some((f) => f.isDirty))
        throw new Error(
          "Save failed. Resolve unsaved files before running Codex.",
        );
      const project = await backend.projects.register(doc.projectRoot);
      set({ projectId: project.id });
      await get().refreshReview();
      if (get().review.active)
        throw new Error("This project has an active turn.");
      const active = doc.files.find((f) => f.id === doc.activeFileId);
      const attachments = [
        ...state.pendingAttachments.filter(
          (a) => !a.chatId || a.chatId === t.id,
        ),
        ...(context ? [context] : []),
      ];
      const text = [
        active ? `[Open file: ${active.relativePath}]` : "",
        ...attachments.map(
          (a) => `[${a.label}; project file: ${a.filePath}]\n${a.selectedText}`,
        ),
        prompt,
      ]
        .filter(Boolean)
        .join("\n\n");
      set((s) => ({
        locked: true,
        isStreaming: true,
        error: null,
        pendingAttachments: s.pendingAttachments.filter(
          (a) => a.chatId && a.chatId !== t.id,
        ),
        tabs: s.tabs.map((x) =>
          x.id === t.id
            ? {
                ...x,
                isStreaming: true,
                error: null,
                title: x.sessionId ? x.title : prompt.slice(0, 70),
                messages: [
                  ...x.messages,
                  {
                    id: `pending-user-${crypto.randomUUID()}`,
                    type: "userMessage",
                    text: prompt,
                  },
                ],
                projectPath: doc.projectRoot,
              }
            : x,
        ),
      }));
      const result = await backend.agent.send(
        project.id,
        t.sessionId,
        text,
        state.selectedModel,
        state.effortLevel,
        attachments.flatMap((a) => (a.imageDataUrl ? [a.imageDataUrl] : [])),
        useSettingsStore.getState().visualChangeReports
          ? doc.files.find(
              (f) =>
                f.id ===
                (active?.type === "tex"
                  ? resolveTexRoot(active.id, doc.files)
                  : getCurrentPdfRootId()),
            )?.relativePath
          : undefined,
        prompt,
        t.id,
        t.mode ?? "default",
      );
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === t.id
            ? { ...x, sessionId: result.threadId, turnId: result.turn.id, draft: x.draft === prompt ? "" : x.draft }
            : x,
        ),
      }));
    } catch (e) {
      set((s) => ({
        isStreaming: s.activeTabId === t.id ? false : s.isStreaming,
        error: s.activeTabId === t.id ? String(e) : s.error,
        tabs: s.tabs.map((x) =>
          x.id === t.id ? { ...x, isStreaming: false, error: String(e) } : x,
        ),
      }));
      try {
        await get().refreshReview();
      } catch {}
      return;
    } finally {
      submissions.delete(t.id);
    }
    // Codex has accepted the prompt. Clear it and release the submission guard
    // before refreshing review state so a slow refresh cannot block steering.
    try {
      await get().refreshReview();
    } catch (e) {
      set((s) => ({
        error: s.activeTabId === t.id ? String(e) : s.error,
        tabs: s.tabs.map((x) => x.id === t.id ? { ...x, error: String(e) } : x),
      }));
    }
  },
  cancelExecution: async () => {
    const s = get();
    const t = s.tabs.find((t) => t.id === s.activeTabId);
    if (s.projectId && t?.sessionId && t.turnId)
      try {
        await backend.agent.control(s.projectId, t.sessionId, t.turnId);
      } catch (e) {
        set({ error: String(e) });
      }
  },
  resumeSession: async (id, title) => {
    if (get().restoringChats) return;
    await ensureAgentEvents();
    const root = useDocumentStore.getState().projectRoot;
    if (!root) return;
    const existing = get().tabs.find((t) => t.sessionId === id);
    if (existing) {
      get().setActiveTab(existing.id);
      return;
    }
    const p = await backend.projects.register(root);
    const result = await backend.agent.thread(p.id, id, "read");
    const t = tab();
    t.sessionId = id;
    t.title = title || "Chat";
    t.projectPath = root;
    t.messages = (result.thread?.turns ?? []).flatMap((turn: any) =>
      (turn.items ?? []).map((item: any) => { const mapped = toItem(item); return mapped.type === "proposedPlan" ? { ...mapped, status: turn.status } : mapped; }),
    );
    set((s) => ({
      projectId: p.id,
      tabs: [...s.tabs, t],
      activeTabId: t.id,
      error: null,
      isStreaming: false,
    }));
    await get().refreshReview();
    const pending = get().proposals.find(
      (p) => p.threadId === id && ["running", "repairing"].includes(p.state),
    );
    if (pending)
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === t.id
            ? { ...x, isStreaming: true, turnId: pending.turnId ?? null }
            : x,
        ),
        isStreaming: s.activeTabId === t.id || s.isStreaming,
      }));
  },
  respond: async (r, result) => {
    if (r.id === undefined) return;
    try {
      await backend.agent.respond(r.id, result);
      set((s) => ({ requests: s.requests.filter((x) => x.id !== r.id) }));
    } catch (e) {
      set({ error: String(e) });
    }
  },
  handleEvent: (e) => {
    // Finish buffered text before lifecycle events replace items or end a turn.
    if (!e.method.endsWith("/delta")) flushDeltas();
    const p = e.params ?? {};
    if (e.method === "prism/proposal" && p.projectId === get().projectId) {
      void get().refreshReview();
      return;
    }
    if (e.method === "connection/closed") {
      set((s) => ({
        isStreaming: false,
        error:
          "Codex disconnected. Reconnect and resume the session; the prompt was not retried.",
        requests: [],
        tabs: s.tabs.map((t) => ({ ...t, isStreaming: false })),
      }));
      void get().refreshReview();
      return;
    }
    if (e.method === "prism/session" && p.projectId === get().projectId) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === p.chatId ? { ...t, sessionId: p.threadId } : t,
        ),
      }));
      return;
    }
    if (e.method === "serverRequest/resolved") {
      set((s) => ({
        requests: s.requests.filter((r) => r.id !== p.requestId),
      }));
      return;
    }
    if (e.method === "prism/unsupportedRequest") {
      set({ error: `Codex requested an unsupported interaction: ${p.method}` });
      return;
    }
    const t = get().tabs.find((t) => t.sessionId === p.threadId);
    if (!t) return;
    if (e.id !== undefined) {
      set((s) => ({
        requests: [...s.requests.filter((r) => r.id !== e.id), e],
      }));
      return;
    }
    if (e.method === "turn/started")
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === t.id ? { ...x, turnId: p.turn.id, isStreaming: true } : x,
        ),
      }));
    if (e.method === "item/started" || e.method === "item/completed") {
      const item = toItem(p.item);
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === t.id
            ? {
                ...x,
                messages: reconcileItem(x.messages, item),
              }
            : x,
        ),
      }));
    }
    if (e.method.endsWith("/delta")) {
      const type = e.method === "item/plan/delta" ? "proposedPlan" : e.method.includes("reasoning")
        ? "reasoning"
        : e.method.includes("command")
          ? "commandExecution"
          : "agentMessage";
      const key = JSON.stringify([t.id, p.itemId]);
      const buffered = deltas.get(key);
      if (buffered) buffered.item.text += p.delta ?? "";
      else
        deltas.set(key, {
          tabId: t.id,
          sessionId: t.sessionId,
          projectId: get().projectId,
          item: { id: p.itemId, type, text: p.delta ?? "" },
        });
      deltaTimer ??= setTimeout(flushDeltas, 32);
    }
    if (e.method === "turn/plan/updated") {
      const item = {
        id: `plan-${p.turnId}`,
        type: "plan",
        text: (p.plan ?? [])
          .map((s: any) => `${s.status}: ${s.step}`)
          .join("\n"),
      };
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === t.id
            ? {
                ...x,
                messages: reconcileItem(x.messages, item),
              }
            : x,
        ),
      }));
    }
    if (e.method === "turn/completed") {
      const error = p.turn.error?.message ?? null;
      set((s) => ({
        isStreaming: s.activeTabId === t.id ? false : s.isStreaming,
        error: s.activeTabId === t.id ? error : s.error,
        requests: s.requests.filter((r) => r.params?.threadId !== p.threadId),
        tabs: s.tabs.map((x) =>
          x.id === t.id ? { ...x, isStreaming: false, error, messages: x.messages.map(m => m.type === "proposedPlan" && m.status !== "completed" ? { ...m, status: p.turn.status ?? (error ? "failed" : "completed") } : m) } : x,
        ),
      }));
      void get()
        .refreshReview()
        .then(async () => {
          const doc = useDocumentStore.getState();
          await doc.refreshFiles();
        })
        .catch((e) => set({ error: String(e) }));
    }
  },
}));
function toItem(item: any): ChatItem {
  const text = item.text ?? item.aggregatedOutput ?? item.command ??
    item.content?.map((x: any) => x.text ?? "").join("\n") ??
    JSON.stringify(item.changes ?? item.summary ?? item, null, 2);
  return {
    id: item.id,
    type: item.type === "plan" ? "proposedPlan" : item.type,
    status: item.status,
    ...(item.phase != null ? { phase: item.phase } : {}),
    ...(!["agentMessage", "userMessage", "reasoning"].includes(item.type)
      ? { activity: item }
      : {}),
    text: item.type === "userMessage" ? sourcePromptText(text) : text,
  };
}
let subscription: Promise<void> | null = null;
export function ensureAgentEvents() {
  return (subscription ??= (async () => {
    await backend.agent.subscribe((e) =>
      useAgentChatStore.getState().handleEvent(e),
    );
    await backend.review.subscribe((id) => {
      if (useAgentChatStore.getState().projectId === id)
        void useAgentChatStore.getState().refreshReview();
    });
  })().catch((e) => {
    subscription = null;
    throw e;
  }));
}

function reconcileItem(messages: ChatItem[], item: ChatItem): ChatItem[] {
  const previous =
    messages.find((m) => m.id === item.id) ??
    (item.type === "userMessage"
      ? messages.find((m) => m.id.startsWith("pending-user-"))
      : undefined);
  const normalized =
    item.type === "userMessage" && previous
      ? { ...item, text: previous.text }
      : item;
  return [
    ...messages.filter((m) => m.id !== item.id && m.id !== previous?.id),
    normalized,
  ];
}

export function activeProposal(
  state: Pick<ChatState, "tabs" | "activeTabId" | "proposals">,
): Proposal | undefined {
  const session = state.tabs.find((t) => t.id === state.activeTabId)?.sessionId;
  return state.proposals.find(
    (p) =>
      ((session && p.threadId === session) || p.chatId === state.activeTabId) &&
      p.state !== "original",
  );
}

// Persist tab identity, drafts and project model preferences; Codex remains the source of message history.
useAgentChatStore.subscribe((state) => {
  if (!state.activeProjectPath || !state.projectId || state.restoringChats) return;
  try {
    writeChatTabs(state.activeProjectPath, {
      activeTabId: state.activeTabId,
      selectedModel: state.selectedModel,
      effortLevel: state.effortLevel,
      tabs: state.tabs.map(({ id, title, sessionId, draft, mode }) => ({
        id, title, sessionId, draft, mode,
      })),
    });
  } catch {
    // Storage may be unavailable; backend conversations remain accessible in History.
  }
});
