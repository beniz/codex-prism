import { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorLockNotice } from "@/components/workspace/editor/editor-lock-notice";
import { guardEditorTransaction } from "@/lib/editor-edit-lock";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCollaborationLock } from "@/lib/collaboration";
import type { Proposal } from "@/lib/backend";
const original = useAgentChatStore.getState();
const document = useDocumentStore.getState();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const pending: Proposal = {
  id: "p",
  projectId: "project",
  threadId: "thread-b",
  chatId: "b",
  generation: 1,
  state: "ready",
  conflicts: [],
  parent: null,
  changes: [],
  blocksEditing: true,
};
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  useDocumentStore.setState({
    projectId: "project",
    isCompiling: false,
    isThreadOpen: false,
  });
  useAgentChatStore.setState({
    ...original,
    locked: true,
    restoringChats: false,
    projectId: "project",
    activeTabId: "a",
    review: { active: false, changes: [] },
    proposals: [pending],
    tabs: [
      { ...original.tabs[0], id: "a", title: "Chat A", isStreaming: false },
      {
        ...original.tabs[0],
        id: "b",
        title: "Chat B",
        sessionId: "thread-b",
        isStreaming: false,
      },
    ],
  });
  useCollaborationLock.setState({ projectId: null });
  host = window.document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useAgentChatStore.setState(original);
  useDocumentStore.setState(document);
  useCollaborationLock.setState({ projectId: null });
  vi.useRealTimers();
});
const render = () => act(async () => root.render(<EditorLockNotice />));
it("numbers the blocking chat by its tab position and opens it without accepting changes", async () => {
  await render();
  expect(host.textContent).toContain("Resolve pending changes in Chat tab 2");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(useAgentChatStore.getState().activeTabId).toBe("b");
  expect(useDocumentStore.getState().isThreadOpen).toBe(true);
  expect(useAgentChatStore.getState().proposals).toEqual([pending]);
});
it("explains running work and provides links for multiple owners", async () => {
  useAgentChatStore.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === "a" ? { ...t, isStreaming: true } : t)),
  }));
  await render();
  expect(host.textContent).toContain("2 chats");
  expect(
    [...host.querySelectorAll("button")].map((b) => b.textContent),
  ).toEqual(["Go to changes · Chat tab 2", "Go to chat · Chat tab 1"]);
});
it("updates the running chat number when a preceding tab closes", async () => {
  useAgentChatStore.setState(s => ({
    tabs: s.tabs.map(t => ({ ...t, isStreaming: t.id === "b" })),
  }));
  await render();
  expect(host.textContent).toContain("Chat tab 2 is editing");
  await act(async () => useAgentChatStore.setState(s => ({
    tabs: s.tabs.filter(t => t.id === "b"),
  })));
  expect(host.textContent).toContain("Chat tab 1 is editing");
  expect(host.textContent).not.toContain("Chat B");
});
it("does not lock for PDF preparation or deferred reviewer suggestions", async () => {
  useDocumentStore.setState({ isCompiling: true });
  useAgentChatStore.setState({
    locked: false,
    proposals: [{ ...pending, blocksEditing: false }],
  });
  await render();
  expect(host.textContent).toBe("");
  const state = EditorState.create({
    doc: "a",
    extensions: EditorState.transactionFilter.of((tr) =>
      guardEditorTransaction(tr, false),
    ),
  });
  expect(
    state.update({ changes: { from: 1, insert: "b" } }).state.doc.toString(),
  ).toBe("ab");
});
it("rejects edits, highlights once per burst, and preserves selection and reloads", async () => {
  await render();
  const state = EditorState.create({
    doc: "abc",
    extensions: EditorState.transactionFilter.of((tr) =>
      guardEditorTransaction(tr, false),
    ),
  });
  expect(
    state.update({ selection: { anchor: 0, head: 3 } }).state.selection.main.to,
  ).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
  for (const changes of [
    { from: 1, insert: "typed or pasted" },
    { from: 0, to: 2 },
  ]) {
    await act(async () => {
      expect(state.update({ changes }).state.doc.toString()).toBe("abc");
    });
  }
  expect(host.querySelector("[data-highlighted=true]")).not.toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Edit blocked",
  );
  expect(vi.getTimerCount()).toBe(1);
  const reload = EditorState.create({
    doc: "abc",
    extensions: EditorState.transactionFilter.of((tr) =>
      guardEditorTransaction(tr, true),
    ),
  });
  expect(
    reload
      .update({ changes: { from: 0, to: 3, insert: "new" } })
      .state.doc.toString(),
  ).toBe("new");
  await act(async () => vi.advanceTimersByTime(2000));
  expect(host.querySelector("[data-highlighted=true]")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () =>
    useAgentChatStore.setState({ locked: false, proposals: [] }),
  );
  expect(host.textContent).toBe("");
});
it("explains synchronization only for the displayed project", async () => {
  useAgentChatStore.setState({ locked: false, proposals: [] });
  useCollaborationLock.setState({ projectId: "project" });
  await render();
  expect(host.textContent).toContain("collaborator changes are applied");
  await act(async () => useCollaborationLock.setState({ projectId: "other" }));
  expect(host.textContent).toBe("");
});
it("explains startup and legacy review locks", async () => {
  useAgentChatStore.setState({ proposals: [], restoringChats: true });
  await render();
  expect(host.textContent).toContain("Checking running work");
  await act(async () =>
    useAgentChatStore.setState({
      restoringChats: false,
      review: { active: true, changes: [] },
    }),
  );
  expect(host.textContent).toContain("Resolve the legacy review");
});

it("reopens the owning conversation when its tab was closed", async () => {
  const resume = vi.fn().mockResolvedValue(undefined);
  useAgentChatStore.setState((s) => ({
    tabs: s.tabs.filter((t) => t.id !== "b"),
    resumeSession: resume,
  }));
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(resume).toHaveBeenCalledWith("thread-b", "Closed chat");
  expect(useDocumentStore.getState().isThreadOpen).toBe(true);
});
