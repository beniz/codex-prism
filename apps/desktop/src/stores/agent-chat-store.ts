import { create } from "zustand";
import { backend, type AgentEvent, type Review } from "@/lib/backend";
import { useDocumentStore } from "./document-store";
import { compileLatex, resolveCompileTarget } from "@/lib/latex-compiler";
export interface PromptContextOverride {
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
}
export interface TabState {
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
  tabs: TabState[];
  activeTabId: string;
  error: string | null;
  isStreaming: boolean;
  projectId: string | null;
  activeProjectPath: string | null;
  review: Review;
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
  resolveReview(path: string, undo: boolean): Promise<void>;
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
const submissions = new Set<string>();
export const useAgentChatStore = create<ChatState>((set, get) => ({
  tabs: [first],
  activeTabId: first.id,
  error: null,
  isStreaming: false,
  projectId: null,
  activeProjectPath: null,
  review: { active: false, changes: [] },
  locked: false,
  requests: [],
  selectedModel: "",
  effortLevel: "",
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
    const t = tab();
    set({
      tabs: [t],
      activeTabId: t.id,
      activeProjectPath: root,
      projectId: null,
      review: { active: false, changes: [] },
      locked: !!root,
      requests: [],
      error: null,
      isStreaming: false,
    });
    if (root)
      void backend.projects
        .register(root)
        .then((p) => {
          if (get().activeProjectPath === root) {
            set({ projectId: p.id });
            void get().refreshReview();
          }
        })
        .catch((e) => set({ error: String(e) }));
  },
  createTab: () => {
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
    if (t) set({ activeTabId: id, error: t.error, isStreaming: t.isStreaming });
  },
  closeTab: (id) => {
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
    const review = await backend.review.get(id);
    if (get().projectId !== id) return;
    set({ review, locked: review.active || review.changes.length > 0 });
  },
  resolveReview: async (path, undo) => {
    const id = get().projectId;
    if (!id) return;
    try {
      await backend.review.resolve(id, path, undo);
      await get().refreshReview();
      if (!get().locked) {
        await useDocumentStore.getState().refreshFiles();
        const doc = useDocumentStore.getState();
        const target = resolveCompileTarget(doc.activeFileId, doc.files);
        if (target && doc.projectRoot) {
          try {
            doc.setPdfData(
              await compileLatex(doc.projectRoot, target.targetPath),
              target.rootId,
            );
          } catch (e) {
            doc.setCompileError(String(e));
          }
        }
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },
  sendPrompt: async (prompt, context) => {
    try {
      await ensureAgentEvents();
    } catch (e) {
      set({ error: String(e) });
      return;
    }
    const state = get();
    const t = state.tabs.find((t) => t.id === state.activeTabId);
    if (!t) return;
    if (t.isStreaming) {
      if (state.projectId && t.sessionId && t.turnId)
        try {
          await backend.agent.control(
            state.projectId,
            t.sessionId,
            t.turnId,
            prompt,
          );
        } catch (e) {
          set({ error: String(e) });
        }
      return;
    }
    if (state.locked) {
      set({
        error:
          "Resolve the current project review before starting another turn.",
      });
      return;
    }
    const doc = useDocumentStore.getState();
    if (!doc.projectRoot) {
      set({ error: "Open a project first" });
      return;
    }
    if (submissions.has(doc.projectRoot)) return;
    submissions.add(doc.projectRoot);
    try {
      await doc.saveAllFiles();
      if (useDocumentStore.getState().files.some((f) => f.isDirty))
        throw new Error(
          "Save failed. Resolve unsaved files before running Codex.",
        );
      const project = await backend.projects.register(doc.projectRoot);
      set({ projectId: project.id });
      await get().refreshReview();
      if (get().locked)
        throw new Error("This project has an active turn or pending review.");
      const active = doc.files.find((f) => f.id === doc.activeFileId);
      const attachments = [
        ...state.pendingAttachments,
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
        pendingAttachments: [],
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
      );
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === t.id
            ? { ...x, sessionId: result.threadId, turnId: result.turn.id }
            : x,
        ),
      }));
    } catch (e) {
      set((s) => ({
        isStreaming: false,
        error: String(e),
        tabs: s.tabs.map((x) =>
          x.id === t.id ? { ...x, isStreaming: false, error: String(e) } : x,
        ),
      }));
      try {
        await get().refreshReview();
      } catch {}
    } finally {
      submissions.delete(doc.projectRoot);
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
      (turn.items ?? []).map(toItem),
    );
    set((s) => ({
      projectId: p.id,
      tabs: [...s.tabs, t],
      activeTabId: t.id,
      error: null,
      isStreaming: false,
    }));
    await get().refreshReview();
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
    const p = e.params ?? {};
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
          t.isStreaming && !t.sessionId ? { ...t, sessionId: p.threadId } : t,
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
      const type = e.method.includes("reasoning")
        ? "reasoning"
        : e.method.includes("command")
          ? "commandExecution"
          : "agentMessage";
      set((s) => ({
        tabs: s.tabs.map((x) => {
          if (x.id !== t.id) return x;
          const found = x.messages.find((i) => i.id === p.itemId);
          return {
            ...x,
            messages: found
              ? x.messages.map((i) =>
                  i.id === p.itemId
                    ? { ...i, text: i.text + (p.delta ?? "") }
                    : i,
                )
              : [...x.messages, { id: p.itemId, type, text: p.delta ?? "" }],
          };
        }),
      }));
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
        error,
        requests: s.requests.filter((r) => r.params?.threadId !== p.threadId),
        tabs: s.tabs.map((x) =>
          x.id === t.id ? { ...x, isStreaming: false, error } : x,
        ),
      }));
      void get()
        .refreshReview()
        .then(async () => {
          const doc = useDocumentStore.getState();
          await doc.refreshFiles();
          const target = resolveCompileTarget(doc.activeFileId, doc.files);
          if (target && doc.projectRoot) {
            try {
              const bytes = await compileLatex(
                doc.projectRoot,
                target.targetPath,
              );
              doc.setPdfData(bytes, target.rootId);
            } catch (e) {
              doc.setCompileError(String(e));
            }
          }
        })
        .catch((e) => set({ error: String(e) }));
    }
  },
}));
function toItem(item: any): ChatItem {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    text:
      item.text ??
      item.aggregatedOutput ??
      item.command ??
      item.content?.map((x: any) => x.text ?? "").join("\n") ??
      JSON.stringify(item.changes ?? item.summary ?? item, null, 2),
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
