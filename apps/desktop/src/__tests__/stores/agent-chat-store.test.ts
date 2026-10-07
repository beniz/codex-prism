import { beforeEach, describe, it, expect, vi } from "vitest";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { backend } from "@/lib/backend";
vi.mock("@/lib/backend", () => ({
  backend: {
    projects: { register: vi.fn(async () => ({ id: "p1", root: "/paper" })) },
    agent: {
      subscribe: vi.fn(async () => () => {}),
      send: vi.fn(async () => ({ threadId: "thread1", turn: { id: "turn1" } })),
      control: vi.fn(),
      respond: vi.fn(),
      thread: vi.fn(),
    },
    review: {
      subscribe: vi.fn(async () => () => {}),
      get: vi.fn(async () => ({ active: false, changes: [] })),
      resolve: vi.fn(),
    },
  },
}));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: vi.fn() },
}));
vi.mock("@/lib/latex-compiler", () => ({
  resolveCompileTarget: vi.fn(() => null),
  compileLatex: vi.fn(),
}));
const save = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useDocumentStore.getState).mockReturnValue({
    projectRoot: "/paper",
    files: [],
    saveAllFiles: save,
    refreshFiles: vi.fn(async () => {}),
    activeFileId: "main.tex",
  } as any);
  useAgentChatStore.setState({
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
    review: { active: false, changes: [] },
    isStreaming: false,
    error: null,
    requests: [],
    pendingAttachments: [],
    selectedModel: useAgentChatStore.getInitialState().selectedModel,
    effortLevel: useAgentChatStore.getInitialState().effortLevel,
  });
});
describe("Codex turn lifecycle", () => {
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
    );
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(backend.agent.send).mock.invocationCallOrder[0],
    );
    expect(useAgentChatStore.getState().locked).toBe(true);
  });
  it("sends through pending review without accepting files one at a time", async () => {
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
    vi.mocked(backend.review.get).mockResolvedValueOnce(review);
    await useAgentChatStore.getState().sendPrompt("refine this");
    expect(backend.agent.send).toHaveBeenCalledOnce();
    expect(backend.review.resolve).not.toHaveBeenCalled();
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
    vi.mocked(backend.review.get)
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce(review);
    vi.mocked(backend.agent.send).mockRejectedValueOnce(
      new Error("Model unavailable"),
    );
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
