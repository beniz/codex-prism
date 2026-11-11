import { readChatTabs, writeChatTabs } from "@/lib/chat-tabs";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { backend, proposals, invoke } from "@/lib/backend";
import { compileLatex, loadExistingPdf, resolveCompileTarget } from "@/lib/latex-compiler";
vi.mock("@/lib/backend", () => ({
  invoke: vi.fn(async () => ({ valid: true })),
  proposals: { list: vi.fn(async () => []), operate: vi.fn() },
  backend: {
    projects: { register: vi.fn(async () => ({ id: "p1", root: "/paper" })) },
    agent: {
      subscribe: vi.fn(async () => () => {}),
      send: vi.fn(async () => ({ threadId: "thread1", turn: { id: "turn1" } })),
      control: vi.fn(),
      respond: vi.fn(),
      thread: vi.fn(),
      sessions: vi.fn(async () => []),
    },
    review: {
      subscribe: vi.fn(async () => () => {}),
      get: vi.fn(async () => ({ active: false, changes: [] })),
      resolve: vi.fn(),
      resolveBatch: vi.fn(async () => ({
        accepted: true,
        historyWarning: null,
      })),
    },
  },
}));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: vi.fn() },
  getCurrentPdfRootId: vi.fn(() => "main.tex"),
  resolveTexRoot: vi.fn(() => "main.tex"),
}));
vi.mock("@/lib/latex-compiler", () => ({
  resolveCompileTarget: vi.fn(() => null),
  compileLatex: vi.fn(),
  loadExistingPdf: vi.fn(),
  formatCompileError: (error: unknown) => String(error),
}));
const save = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsStore.setState({ visualChangeReports: true });
  vi.mocked(useDocumentStore.getState).mockReturnValue({
    projectRoot: "/paper",
    projectId: "p1",
    files: [],
    saveAllFiles: save,
    refreshFiles: vi.fn(async () => {}),
    activeFileId: "main.tex",
  } as any);
  useAgentChatStore.setState({
    restoringChats: false,
    tabs: [
      {
        id: "tab1",
        title: "New",
        projectPath: "/paper",
        sessionId: null,
        turnId: null,
        messages: [],
        isStreaming: false,
        error: null,
        draft: "",
      },
    ],
    activeTabId: "tab1",
    projectId: "p1",
    activeProjectPath: "/paper",
    locked: false,
    proposals: [],
    review: { active: false, changes: [] },
    isStreaming: false,
    error: null,
    requests: [],
    pendingAttachments: [],
    selectedModel: useAgentChatStore.getInitialState().selectedModel,
    effortLevel: useAgentChatStore.getInitialState().effortLevel,
  });
});

describe("compilation after accepting review changes", () => {
  const remaining = {
    path: "included.tex",
    kind: "modified" as const,
    binary: false,
    oldContent: "old",
    newContent: "new",
  };
  it("keeps every pending file and refreshes and recompiles only once", async () => {
    const changes = [remaining, { ...remaining, path: "main.tex" }];
    useAgentChatStore.setState({
      review: { active: false, changes },
      locked: true,
    });
    const doc = useDocumentStore.getState();
    Object.assign(doc, { setPdfData: vi.fn(), setIsCompiling: vi.fn() });
    vi.mocked(resolveCompileTarget).mockReturnValueOnce({
      rootId: "main.tex",
      targetPath: "main.tex",
    });
    vi.mocked(compileLatex).mockResolvedValueOnce(new Uint8Array([1]));
    await useAgentChatStore.getState().keepAllReview();
    expect(backend.review.resolveBatch).toHaveBeenCalledExactlyOnceWith(
      "p1",
      ["included.tex", "main.tex"],
      false,
      undefined,
    );
    expect(doc.refreshFiles).toHaveBeenCalledOnce();
    expect(compileLatex).toHaveBeenCalledOnce();
    expect(useAgentChatStore.getState().review.changes).toEqual([]);
    expect(useAgentChatStore.getState().locked).toBe(false);
  });
  it("stops a failed Keep all and refreshes the remaining decisions", async () => {
    const changes = [
      remaining,
      { ...remaining, path: "main.tex" },
      { ...remaining, path: "last.tex" },
    ];
    useAgentChatStore.setState({
      review: { active: false, changes },
      locked: true,
    });
    vi.mocked(backend.review.resolveBatch).mockRejectedValueOnce(
      new Error("Review changed"),
    );
    vi.mocked(backend.review.get).mockResolvedValueOnce({
      active: false,
      changes: changes.slice(1),
    });
    await useAgentChatStore.getState().keepAllReview();
    expect(backend.review.resolveBatch).toHaveBeenCalledOnce();
    expect(compileLatex).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().review.changes).toEqual(
      changes.slice(1),
    );
    expect(useAgentChatStore.getState().error).toContain("Review changed");
  });
  for (const changes of [[], [remaining]]) {
    it(`recompiles after Keep with ${changes.length} files still pending`, async () => {
      const doc = useDocumentStore.getState();
      const setPdfData = vi.fn();
      const setIsCompiling = vi.fn();
      Object.assign(doc, { setPdfData, setIsCompiling });
      vi.mocked(backend.review.get).mockResolvedValueOnce({
        active: false,
        changes,
      });
      vi.mocked(resolveCompileTarget).mockReturnValueOnce({
        rootId: "main.tex",
        targetPath: "main.tex",
      });
      const pdf = new Uint8Array([1, 2, 3]);
      vi.mocked(compileLatex).mockResolvedValueOnce(pdf);
      await useAgentChatStore.getState().resolveReview("main.tex", false);
      expect(doc.refreshFiles).toHaveBeenCalledOnce();
      expect(compileLatex).toHaveBeenCalledWith("/paper", "main.tex");
      expect(setPdfData).toHaveBeenCalledWith(pdf, "main.tex");
      expect(setIsCompiling.mock.calls).toEqual([[true], [false]]);
      expect(useAgentChatStore.getState().review.changes).toEqual(changes);
    });
  }
  it("preserves acceptance and reports a failed recompile", async () => {
    const setCompileError = vi.fn();
    const setPdfData = vi.fn();
    const setIsCompiling = vi.fn();
    Object.assign(useDocumentStore.getState(), {
      setCompileError,
      setPdfData,
      setIsCompiling,
    });
    vi.mocked(resolveCompileTarget).mockReturnValueOnce({
      rootId: "main.tex",
      targetPath: "main.tex",
    });
    vi.mocked(compileLatex).mockRejectedValueOnce("Build failed");
    await useAgentChatStore.getState().resolveReview("main.tex", false);
    expect(backend.review.resolveBatch).toHaveBeenCalledWith(
      "p1",
      ["main.tex"],
      false,
      undefined,
    );
    expect(setCompileError).toHaveBeenCalledWith("Build failed", "main.tex");
    expect(setPdfData).not.toHaveBeenCalled();
    expect(setIsCompiling).toHaveBeenLastCalledWith(false);
    expect(useAgentChatStore.getState().locked).toBe(false);
  });
});
describe("Codex turn lifecycle", () => {
  it.each([
    true,
    false,
  ])("requests visual artifacts only when reports are enabled (%s)", async (enabled) => {
    useSettingsStore.getState().setVisualChangeReports(enabled);
    Object.assign(useDocumentStore.getState(), {
      files: [
        {
          id: "main.tex",
          relativePath: "main.tex",
          type: "tex",
          isDirty: false,
        },
      ],
    });
    await useAgentChatStore.getState().sendPrompt("Edit paragraph");
    expect(vi.mocked(backend.agent.send).mock.calls[0][6]).toBe(
      enabled ? "main.tex" : undefined,
    );
  });
  it("saves before starting and carries project identity across the boundary", async () => {
    await useAgentChatStore.getState().sendPrompt("Fix equations");
    expect(save).toHaveBeenCalledOnce();
    expect(backend.agent.send).toHaveBeenCalledWith(
      "p1",
      null,
      "Fix equations",
      "gpt-5.6-sol",
      "xhigh",
      [],
      undefined,
      "Fix equations",
      "tab1",
      "default",
    );
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(backend.agent.send).mock.invocationCallOrder[0],
    );
    expect(useAgentChatStore.getState().locked).toBe(true);
  });
  it("blocks legacy reviews without accepting files implicitly", async () => {
    useAgentChatStore.setState({
      locked: true,
      review: {
        active: false,
        changes: [
          {
            path: "main.tex",
            kind: "modified",
            oldContent: "old",
            newContent: "new",
            binary: false,
          },
        ],
      },
    });
    await useAgentChatStore.getState().sendPrompt("Refine");
    expect(backend.agent.send).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().error).toContain("legacy");
  });

  it("blocks a new turn when the project has an active turn", async () => {
    useAgentChatStore.setState({
      locked: true,
      review: { active: true, changes: [] },
    });
    await useAgentChatStore.getState().sendPrompt("again");
    expect(backend.agent.send).not.toHaveBeenCalled();
  });
  it("retains pending review if starting the next turn is rejected", async () => {
    const review = {
      active: false,
      changes: [
        {
          path: "main.tex",
          kind: "modified" as const,
          binary: false,
          oldContent: "before",
          newContent: "after",
        },
      ],
    };
    useAgentChatStore.setState({ locked: true, review });
    await useAgentChatStore.getState().sendPrompt("refine");
    expect(useAgentChatStore.getState().review).toEqual(review);
    expect(useAgentChatStore.getState().locked).toBe(true);
    expect(useAgentChatStore.getState().isStreaming).toBe(false);
  });
  it("does not start when dirty buffers remain after save", async () => {
    vi.mocked(useDocumentStore.getState).mockReturnValue({
      projectRoot: "/paper",
      files: [{ isDirty: true }],
      saveAllFiles: save,
    } as any);
    await useAgentChatStore.getState().sendPrompt("edit");
    expect(backend.agent.send).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().error).toContain("Save failed");
  });
  it("steers an active turn without starting another", async () => {
    const s = useAgentChatStore.getState();
    useAgentChatStore.setState({
      tabs: [
        {
          ...s.tabs[0],
          sessionId: "thread1",
          turnId: "turn1",
          isStreaming: true,
        },
      ],
      locked: true,
    });
    await useAgentChatStore.getState().sendPrompt("Only section 2");
    expect(backend.agent.control).toHaveBeenCalledWith(
      "p1",
      "thread1",
      "turn1",
      "Only section 2",
    );
    expect(backend.agent.send).not.toHaveBeenCalled();
  });
  it("routes streaming deltas by thread and replaces final items", () => {
    const s = useAgentChatStore.getState();
    useAgentChatStore.setState({
      tabs: [{ ...s.tabs[0], sessionId: "thread1" }],
    });
    s.handleEvent({
      method: "item/agentMessage/delta",
      params: { threadId: "other", itemId: "a", delta: "ignored" },
    });
    s.handleEvent({
      method: "item/agentMessage/delta",
      params: { threadId: "thread1", itemId: "a", delta: "Hello" },
    });
    s.handleEvent({
      method: "item/completed",
      params: {
        threadId: "thread1",
        item: { id: "a", type: "agentMessage", text: "Hello world" },
      },
    });
    expect(useAgentChatStore.getState().tabs[0].messages).toEqual([
      { id: "a", type: "agentMessage", text: "Hello world", status: undefined },
    ]);
  });
  it("preserves message phases and structured web actions", () => {
    const store = useAgentChatStore.getState();
    useAgentChatStore.setState({
      tabs: [{ ...store.tabs[0], sessionId: "thread1" }],
    });
    const item = {
      id: "a",
      type: "agentMessage",
      text: "Checking sources",
      phase: "commentary",
    };
    store.handleEvent({
      method: "item/started",
      params: { threadId: "thread1", item },
    });
    store.handleEvent({
      method: "item/agentMessage/delta",
      params: { threadId: "thread1", itemId: "a", delta: " now" },
    });
    expect(useAgentChatStore.getState().tabs[0].messages[0].phase).toBe(
      "commentary",
    );
    const web = {
      id: "w",
      type: "webSearch",
      query: "TikZ",
      results: [{ url: "https://example.org" }],
    };
    store.handleEvent({
      method: "item/completed",
      params: { threadId: "thread1", item: web },
    });
    expect(useAgentChatStore.getState().tabs[0].messages[1].activity).toEqual(
      web,
    );
  });
  it("answers approvals without killing the process", async () => {
    const r = {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread1" },
    };
    useAgentChatStore.setState({ requests: [r] });
    await useAgentChatStore.getState().respond(r, { decision: "decline" });
    expect(backend.agent.respond).toHaveBeenCalledWith(7, {
      decision: "decline",
    });
    expect(useAgentChatStore.getState().requests).toEqual([]);
    expect(backend.agent.control).not.toHaveBeenCalled();
  });
  it("marks disconnect without resubmitting the prompt", () => {
    useAgentChatStore
      .getState()
      .handleEvent({ method: "connection/closed", params: {} });
    expect(useAgentChatStore.getState().isStreaming).toBe(false);
    expect(backend.agent.send).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().error).toContain("not retried");
  });
  it("reconciles the optimistic user message with the server transcript", async () => {
    await useAgentChatStore.getState().sendPrompt("Edit paragraph");
    const event = {
      params: {
        threadId: "thread1",
        item: {
          id: "server-user",
          type: "userMessage",
          content: [
            { type: "text", text: "[Open file: main.tex] Edit paragraph" },
          ],
        },
      },
    };
    useAgentChatStore
      .getState()
      .handleEvent({ ...event, method: "item/started" });
    useAgentChatStore
      .getState()
      .handleEvent({ ...event, method: "item/completed" });
    expect(useAgentChatStore.getState().tabs[0].messages).toEqual([
      {
        id: "server-user",
        type: "userMessage",
        text: "Edit paragraph",
        status: undefined,
      },
    ]);
  });
  it("serializes submissions while buffers are saving", async () => {
    let saved!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    const first = useAgentChatStore.getState().sendPrompt("first");
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await useAgentChatStore.getState().sendPrompt("second");
    saved();
    await first;
    expect(backend.agent.send).toHaveBeenCalledOnce();
  });
  it("sends captured images as image inputs", async () => {
    await useAgentChatStore.getState().sendPrompt("Explain", {
      label: "capture",
      filePath: "attachments/a.png",
      selectedText: "",
      imageDataUrl: "data:image/png;base64,AA==",
    });
    expect(vi.mocked(backend.agent.send).mock.calls[0][5]).toEqual([
      "data:image/png;base64,AA==",
    ]);
  });
});

it("batches a streaming burst into one notification and retains completed message identities", () => {
  vi.useFakeTimers();
  const previous = {
    id: "previous",
    type: "agentMessage",
    text: "Earlier reply",
  };
  useAgentChatStore.setState({
    tabs: [
      {
        ...useAgentChatStore.getState().tabs[0],
        sessionId: "thread1",
        messages: [previous],
      },
    ],
  });
  const notify = vi.fn();
  const unsubscribe = useAgentChatStore.subscribe(notify);
  try {
    for (let i = 0; i < 100; i++)
      useAgentChatStore.getState().handleEvent({
        method: "item/agentMessage/delta",
        params: { threadId: "thread1", itemId: "new", delta: "x" },
      });
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(32);
    expect(notify).toHaveBeenCalledTimes(1);
    const messages = useAgentChatStore.getState().tabs[0].messages;
    expect(messages[0]).toBe(previous);
    expect(messages[1].text).toBe("x".repeat(100));
  } finally {
    unsubscribe();
    vi.useRealTimers();
  }
});

it("discards buffered text when switching projects", () => {
  vi.useFakeTimers();
  try {
    useAgentChatStore.setState({
      tabs: [{ ...useAgentChatStore.getState().tabs[0], sessionId: "thread1" }],
    });
    useAgentChatStore.getState().handleEvent({
      method: "item/agentMessage/delta",
      params: { threadId: "thread1", itemId: "new", delta: "old project" },
    });
    useAgentChatStore.getState().resetForProject(null);
    vi.advanceTimersByTime(32);
    expect(useAgentChatStore.getState().tabs[0].messages).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

describe("concurrent proposals", () => {
  it("routes session binding only to the submitting tab", () => {
    const first = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({
      tabs: [
        { ...first, isStreaming: true },
        { ...first, id: "tab2", isStreaming: true },
      ],
    });
    useAgentChatStore.getState().handleEvent({
      method: "prism/session",
      params: { projectId: "p1", chatId: "tab2", threadId: "thread2" },
    });
    expect(useAgentChatStore.getState().tabs.map((t) => t.sessionId)).toEqual([
      null,
      "thread2",
    ]);
  });
  it("allows a second chat while another chat is running", async () => {
    const first = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({
      tabs: [
        { ...first, isStreaming: true, sessionId: "other" },
        { ...first, id: "tab2" },
      ],
      activeTabId: "tab2",
      locked: true,
    });
    await useAgentChatStore.getState().sendPrompt("Independent edit");
    expect(backend.agent.send).toHaveBeenCalledOnce();
    expect(useAgentChatStore.getState().tabs[0].isStreaming).toBe(true);
    expect(vi.mocked(backend.agent.send).mock.calls[0][8]).toBe("tab2");
  });
  it("retains pending work when its tab is closed", () => {
    const p = {
      id: "proposal",
      projectId: "p1",
      threadId: "thread1",
      generation: 2,
      state: "ready" as const,
      conflicts: [],
      parent: null,
      changes: [],
    };
    useAgentChatStore.setState({
      proposals: [p],
      tabs: [{ ...useAgentChatStore.getState().tabs[0], sessionId: "thread1" }],
    });
    useAgentChatStore.getState().closeTab("tab1");
    expect(useAgentChatStore.getState().proposals).toEqual([p]);
  });
  it("keeps other chat errors out of the active chat", () => {
    const first = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({
      tabs: [
        { ...first, sessionId: "a" },
        { ...first, id: "tab2", sessionId: "b" },
      ],
      activeTabId: "tab2",
      error: null,
    });
    useAgentChatStore.getState().handleEvent({
      method: "turn/completed",
      params: { threadId: "a", turn: { error: { message: "a failed" } } },
    });
    expect(useAgentChatStore.getState().error).toBeNull();
    expect(useAgentChatStore.getState().tabs[0].error).toBe("a failed");
  });
});

it("keeps captured PDF attachments with their owning chat", async () => {
  const s = useAgentChatStore.getState();
  s.addPendingAttachment({
    chatId: "other",
    label: "other capture",
    filePath: "attachments/other.png",
    selectedText: "other PDF",
  });
  s.addPendingAttachment({
    chatId: "tab1",
    label: "this capture",
    filePath: "attachments/this.png",
    selectedText: "this PDF",
  });
  await s.sendPrompt("Review this");
  const prompt = vi.mocked(backend.agent.send).mock.calls[0][2];
  expect(prompt).toContain("this PDF");
  expect(prompt).not.toContain("other PDF");
  expect(
    useAgentChatStore.getState().pendingAttachments.map((a) => a.chatId),
  ).toEqual(["other"]);
});

it("includes PDF selection context when steering a running chat", async () => {
  const s = useAgentChatStore.getState();
  useAgentChatStore.setState({
    tabs: [
      {
        ...s.tabs[0],
        sessionId: "thread1",
        turnId: "turn1",
        isStreaming: true,
      },
    ],
  });
  await s.sendPrompt("Fix this", {
    label: "PDF page 1",
    filePath: "main.tex",
    selectedText: "selected passage",
  });
  expect(backend.agent.control).toHaveBeenCalledWith(
    "p1",
    "thread1",
    "turn1",
    expect.stringContaining("selected passage"),
  );
  expect(backend.agent.send).not.toHaveBeenCalled();
});

describe("project chat restoration", () => {
  const sessions = [
    { id: "thread2", projectId: "p1", title: "Second" },
    { id: "thread1", projectId: "p1", title: "First" },
  ];
  const waitForRestore = async () => {
    await vi.waitFor(() => expect(useAgentChatStore.getState().restoringChats).toBe(false));
  };
  beforeEach(() => {
    vi.mocked(backend.agent.sessions).mockResolvedValue(sessions);
    vi.mocked(backend.agent.thread).mockImplementation(async (_project, id) => ({
      thread: { turns: [{ items: [{ id: "reply", type: "agentMessage", text: id }] }] },
    }));
  });
  it("restores open tabs, active conversation and drafts using backend messages", async () => {
    const state = useAgentChatStore.getState();
    useAgentChatStore.setState({
      tabs: [
        { ...state.tabs[0], id: "one", sessionId: "thread1", title: "First" },
        { ...state.tabs[0], id: "two", sessionId: "thread2", title: "Second", draft: "Follow up" },
      ],
      activeTabId: "two",
    });
    expect(readChatTabs("/paper")?.tabs).toHaveLength(2);
    state.resetForProject(null);
    state.resetForProject("/paper");
    await waitForRestore();
    const restored = useAgentChatStore.getState();
    expect(restored.tabs.map((t) => t.id)).toEqual(["one", "two"]);
    expect(restored.activeTabId).toBe("two");
    expect(restored.tabs[1].draft).toBe("Follow up");
    expect(restored.tabs[1].messages[0].text).toBe("thread2");
    expect(restored.tabs.every((t) => !t.isStreaming && t.turnId === null)).toBe(true);
    expect(backend.agent.send).not.toHaveBeenCalled();
  });
  it("opens the newest saved conversation for projects without tab metadata", async () => {
    useAgentChatStore.getState().resetForProject("/older-project");
    await waitForRestore();
    expect(useAgentChatStore.getState().tabs[0].sessionId).toBe("thread2");
  });
  it("retains an intentionally empty new chat instead of reopening closed tabs", async () => {
    writeChatTabs("/empty", {
      activeTabId: "empty",
      tabs: [{ id: "empty", title: "New Chat", sessionId: null, draft: "Unsent" }],
    });
    useAgentChatStore.getState().resetForProject("/empty");
    await waitForRestore();
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      id: "empty", sessionId: null, draft: "Unsent", messages: [],
    });
    expect(backend.agent.thread).not.toHaveBeenCalled();
  });
  it("ignores a late restoration after switching projects", async () => {
    let finish!: (value: typeof sessions) => void;
    vi.mocked(backend.agent.sessions).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    useAgentChatStore.getState().resetForProject("/slow");
    await vi.waitFor(() => expect(finish).toBeDefined());
    useAgentChatStore.getState().resetForProject("/fast");
    await waitForRestore();
    const active = useAgentChatStore.getState().activeTabId;
    finish([{ id: "wrong", projectId: "p1", title: "Wrong project" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAgentChatStore.getState().activeProjectPath).toBe("/fast");
    expect(useAgentChatStore.getState().activeTabId).toBe(active);
  });
  it("reconnects a pending running proposal without starting another turn", async () => {
    vi.mocked(proposals.list).mockResolvedValueOnce([{
      id: "proposal", projectId: "p1", threadId: "thread2", turnId: "live",
      generation: 1, state: "running", conflicts: [], parent: null, changes: [],
    }]);
    useAgentChatStore.getState().resetForProject("/running");
    await waitForRestore();
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      sessionId: "thread2", turnId: "live", isStreaming: true,
    });
    expect(useAgentChatStore.getState().locked).toBe(true);
    expect(backend.agent.send).not.toHaveBeenCalled();
  });
  it("skips archived sessions and falls back to a new tab", async () => {
    writeChatTabs("/archived", {
      activeTabId: "gone",
      tabs: [{ id: "gone", sessionId: "archived", title: "Old", draft: "" }],
    });
    useAgentChatStore.getState().resetForProject("/archived");
    await waitForRestore();
    expect(useAgentChatStore.getState().tabs).toHaveLength(1);
    expect(useAgentChatStore.getState().tabs[0].sessionId).toBeNull();
    expect(backend.agent.thread).not.toHaveBeenCalled();
  });
  it("retains a tab and displays an error if its history cannot be read", async () => {
    vi.mocked(backend.agent.thread).mockRejectedValueOnce(new Error("offline"));
    useAgentChatStore.getState().resetForProject("/offline");
    await waitForRestore();
    expect(useAgentChatStore.getState().tabs[0].sessionId).toBe("thread2");
    expect(useAgentChatStore.getState().error).toContain("offline");
  });
});

it.each([true, false])("Keep reuses a matching reviewed build (%s), otherwise compiles", async (reuse) => {
  const pdf = new Uint8Array([37,80,68,70]);
  const doc = useDocumentStore.getState();
  const setPdfData = vi.fn();
  const setIsCompiling = vi.fn();
  vi.mocked(useDocumentStore.getState).mockReturnValue({ ...doc, setPdfData, setIsCompiling, setCompileError: vi.fn() } as any);
  useAgentChatStore.setState({ proposals: [{ id: "proposal", projectId: "p1", chatId: "tab1", state: "ready", generation: 1 }] as any });
  vi.mocked(proposals.operate).mockResolvedValueOnce({ conflicts: [], reusedBuilds: reuse ? ["main.tex"] : [] });
  vi.mocked(resolveCompileTarget).mockReturnValue({ rootId: "main.tex", targetPath: "main.tex" });
  vi.mocked(loadExistingPdf).mockResolvedValueOnce(pdf);
  vi.mocked(compileLatex).mockResolvedValueOnce(pdf);
  await useAgentChatStore.getState().decideProposal("apply");
  expect(setPdfData).toHaveBeenCalledWith(pdf, "main.tex");
  if (reuse) {
    expect(compileLatex).not.toHaveBeenCalled();
    expect(setIsCompiling).not.toHaveBeenCalled();
  } else {
    expect(compileLatex).toHaveBeenCalledOnce();
  }
});


describe("project model preferences", () => {
  it("persists choices and restores them without leaking across projects", async () => {
    useAgentChatStore.setState({ selectedModel: "custom-model", effortLevel: "high" });
    expect(readChatTabs("/paper")).toMatchObject({ selectedModel: "custom-model", effortLevel: "high" });
    useAgentChatStore.getState().resetForProject("/other");
    await vi.waitFor(() => expect(useAgentChatStore.getState().restoringChats).toBe(false));
    expect(useAgentChatStore.getState().selectedModel).toBe("gpt-5.6-sol");
    useAgentChatStore.setState({ selectedModel: "", effortLevel: "" });
    useAgentChatStore.getState().resetForProject("/paper");
    await vi.waitFor(() => expect(useAgentChatStore.getState().restoringChats).toBe(false));
    expect(useAgentChatStore.getState()).toMatchObject({ selectedModel: "custom-model", effortLevel: "high" });
    useAgentChatStore.getState().resetForProject("/other");
    await vi.waitFor(() => expect(useAgentChatStore.getState().restoringChats).toBe(false));
    expect(useAgentChatStore.getState()).toMatchObject({ selectedModel: "", effortLevel: "" });
  });
  it("keeps legacy saved tabs when optional preferences are absent or malformed", () => {
    const saved = { activeTabId: "old", tabs: [{ id: "old", title: "Old", sessionId: null, draft: "draft" }] };
    writeChatTabs("/legacy", saved);
    expect(readChatTabs("/legacy")?.selectedModel).toBeUndefined();
    localStorage.setItem("prism-chat-tabs-v1:/legacy", JSON.stringify({ ...saved, selectedModel: 42, effortLevel: null }));
    expect(readChatTabs("/legacy")).toMatchObject({ tabs: saved.tabs, selectedModel: undefined, effortLevel: undefined });
  });
});

describe("data-source prompt references", () => {
  const prompt = "Read @attachments:/paper.pdf";
  function draft(running = false) {
    useAgentChatStore.setState(s => ({ tabs: s.tabs.map(t => ({ ...t, draft: prompt, isStreaming: running, sessionId: running ? "thread1" : null, turnId: running ? "turn1" : null })) }));
  }
  it("retains an invalid prompt and never starts or steers a turn", async () => {
    for (const running of [false, true]) {
      draft(running);
      vi.mocked(invoke).mockRejectedValueOnce(new Error("File is not registered"));
      await useAgentChatStore.getState().sendPrompt(prompt);
      expect(useAgentChatStore.getState().tabs[0].draft).toBe(prompt);
      expect(useAgentChatStore.getState().error).toContain("not registered");
    }
    expect(backend.agent.send).not.toHaveBeenCalled();
    expect(backend.agent.control).not.toHaveBeenCalled();
  });
  it("preserves the original prompt for sending and history, clearing it only after acceptance", async () => {
    draft();
    await useAgentChatStore.getState().sendPrompt(prompt);
    expect(invoke).toHaveBeenCalledWith("project_service", { projectId: "p1", operation: "source_reference_check", args: { chatId: "tab1", prompt } });
    expect(vi.mocked(backend.agent.send).mock.calls[0][2]).toBe(prompt);
    expect(vi.mocked(backend.agent.send).mock.calls[0][7]).toBe(prompt);
    expect(useAgentChatStore.getState().tabs[0].draft).toBe("");
    draft(true);
    await useAgentChatStore.getState().sendPrompt(prompt);
    expect(backend.agent.control).toHaveBeenCalledWith("p1", "thread1", "turn1", prompt);
    expect(useAgentChatStore.getState().tabs[0].draft).toBe("");
  });
  it("does not send to a different chat after an asynchronous check", async () => {
    draft();
    vi.mocked(invoke).mockImplementationOnce(async () => {
      useAgentChatStore.setState({ activeTabId: "other" });
      return { valid: true } as any;
    });
    await useAgentChatStore.getState().sendPrompt(prompt);
    expect(backend.agent.send).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().tabs[0].draft).toBe(prompt);
  });
});

describe("composer clearing after submission", () => {
  const prompt = "Read @attachments:/paper.pdf";
  const setDraft = (draft: string) => useAgentChatStore.setState(s => ({
    tabs: s.tabs.map(t => t.id === "tab1" ? { ...t, draft } : t),
  }));

  it.each(["Revise the introduction", prompt])("clears accepted %s before review refresh, even if it fails", async (text) => {
    setDraft(text);
    vi.mocked(backend.review.get)
      .mockResolvedValueOnce({ active: false, changes: [] })
      .mockImplementationOnce(async () => {
        expect(useAgentChatStore.getState().tabs[0].draft).toBe("");
        throw new Error("Review refresh failed");
      });
    await useAgentChatStore.getState().sendPrompt(text);
    const state = useAgentChatStore.getState();
    expect(state.tabs[0]).toMatchObject({ draft: "", isStreaming: true, turnId: "turn1" });
    expect(state.isStreaming).toBe(true);
    expect(state.error).toContain("Review refresh failed");
  });

  it.each([false, true])("retains text when submission fails (steering=%s)", async (running) => {
    setDraft("Keep this draft");
    if (running) {
      useAgentChatStore.setState(s => ({ tabs: s.tabs.map(t => ({ ...t,
        isStreaming: true, sessionId: "thread1", turnId: "turn1" })) }));
      vi.mocked(backend.agent.control).mockRejectedValueOnce(new Error("Steering failed"));
    } else {
      vi.mocked(backend.agent.send).mockRejectedValueOnce(new Error("Startup failed"));
    }
    await useAgentChatStore.getState().sendPrompt("Keep this draft");
    expect(useAgentChatStore.getState().tabs[0].draft).toBe("Keep this draft");
    expect(useAgentChatStore.getState().error).toContain("failed");
  });

  it.each([false, true])("keeps newer drafts and other chats while awaiting acceptance (steering=%s)", async (running) => {
    setDraft(prompt);
    const result = { threadId: "thread1", turn: { id: "turn1" } };
    let accept!: (value: typeof result) => void;
    const pending = new Promise<typeof result>(resolve => { accept = resolve; });
    if (running) {
      useAgentChatStore.setState(s => ({ tabs: s.tabs.map(t => ({ ...t,
        isStreaming: true, sessionId: "thread1", turnId: "turn1" })) }));
      vi.mocked(backend.agent.control).mockReturnValueOnce(pending);
    } else {
      vi.mocked(backend.agent.send).mockReturnValueOnce(pending);
    }
    const sending = useAgentChatStore.getState().sendPrompt(prompt);
    await vi.waitFor(() => expect(running ? backend.agent.control : backend.agent.send).toHaveBeenCalledOnce());
    expect(useAgentChatStore.getState().tabs[0].draft).toBe(prompt);
    setDraft("New unsent text");
    useAgentChatStore.setState(s => ({ tabs: [...s.tabs, { ...s.tabs[0], id: "tab2", draft: prompt }], activeTabId: "tab2" }));
    accept(result);
    await sending;
    expect(useAgentChatStore.getState().tabs.map(t => t.draft)).toEqual(["New unsent text", prompt]);
  });

  it("allows steering after acceptance while review refresh is still pending", async () => {
    setDraft(prompt);
    let refreshed!: (value: { active: boolean; changes: [] }) => void;
    vi.mocked(backend.review.get)
      .mockResolvedValueOnce({ active: false, changes: [] })
      .mockReturnValueOnce(new Promise(resolve => { refreshed = resolve; }));
    const sending = useAgentChatStore.getState().sendPrompt(prompt);
    try {
      await vi.waitFor(() => expect(backend.review.get).toHaveBeenCalledTimes(2));
      expect(useAgentChatStore.getState().tabs[0].draft).toBe("");
      setDraft("Also update the abstract");
      await useAgentChatStore.getState().sendPrompt("Also update the abstract");
      expect(backend.agent.control).toHaveBeenCalledWith("p1", "thread1", "turn1", "Also update the abstract");
      expect(useAgentChatStore.getState().tabs[0].draft).toBe("");
    } finally {
      refreshed({ active: false, changes: [] });
      await sending;
    }
  });

  it("does not resubmit a visible draft while a follow-up turn is starting", async () => {
    setDraft("Follow up");
    useAgentChatStore.setState(s => ({ tabs: s.tabs.map(t => ({ ...t,
      sessionId: "thread1", turnId: "previous-turn" })) }));
    const result = { threadId: "thread1", turn: { id: "turn2" } };
    let accept!: (value: typeof result) => void;
    vi.mocked(backend.agent.send).mockReturnValueOnce(new Promise(resolve => { accept = resolve; }));
    const sending = useAgentChatStore.getState().sendPrompt("Follow up");
    await vi.waitFor(() => expect(backend.agent.send).toHaveBeenCalledOnce());
    await useAgentChatStore.getState().sendPrompt("Follow up");
    expect(backend.agent.control).not.toHaveBeenCalled();
    accept(result);
    await sending;
    expect(useAgentChatStore.getState().tabs[0].draft).toBe("");
  });
});
