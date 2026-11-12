import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistChatTabs, useAgentChatStore } from "@/stores/agent-chat-store";
import { readChatTabs } from "@/lib/chat-tabs";

const original = useAgentChatStore.getState();
beforeEach(() => {
  persistChatTabs();
  vi.useFakeTimers();
  localStorage.clear();
  useAgentChatStore.setState({
    activeProjectPath: "/typing",
    projectId: "typing",
    restoringChats: false,
    activeTabId: "a",
    tabs: [
      { ...original.tabs[0], id: "a", draft: "", submittedDraft: undefined },
    ],
  });
});
afterEach(() => {
  persistChatTabs();
  vi.useRealTimers();
  useAgentChatStore.setState(original);
  vi.restoreAllMocks();
});
const type = (draft: string) =>
  useAgentChatStore.setState((s) => ({
    tabs: s.tabs.map((t) => ({ ...t, draft })),
  }));

it("updates text immediately without storage on each keystroke, then saves the latest draft", () => {
  const writes = vi.spyOn(localStorage, "setItem").mockClear();
  for (const draft of ["a", "ab", "abc"]) {
    type(draft);
    expect(useAgentChatStore.getState().tabs[0].draft).toBe(draft);
    vi.advanceTimersByTime(50);
  }
  expect(writes).not.toHaveBeenCalled();
  vi.advanceTimersByTime(250);
  expect(readChatTabs("/typing")?.tabs[0].draft).toBe("abc");
  expect(writes).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5000);
  expect(writes).toHaveBeenCalledTimes(1);
});

it("bounds autosave delay during continuous typing and ignores streaming-only state changes", () => {
  for (let i = 0; i < 10; i++) {
    type(`draft ${i}`);
    vi.advanceTimersByTime(100);
  }
  expect(readChatTabs("/typing")?.tabs[0].draft).toBe("draft 9");
  const reads = vi.spyOn(localStorage, "getItem").mockClear();
  const writes = vi.spyOn(localStorage, "setItem").mockClear();
  useAgentChatStore.setState((s) => ({
    tabs: s.tabs.map((t) => ({
      ...t,
      messages: [{ id: "m", type: "agentMessage", text: "Still working" }],
      isStreaming: true,
    })),
  }));
  vi.advanceTimersByTime(5000);
  expect(reads).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
});

it("flushes to the owning project on navigation and flushes the new project on page exit", () => {
  type("Project A draft");
  useAgentChatStore.setState((s) => ({
    activeProjectPath: "/other",
    projectId: "other",
    tabs: s.tabs.map((t) => ({ ...t, draft: "" })),
  }));
  expect(readChatTabs("/typing")?.tabs[0].draft).toBe("Project A draft");
  type("Project B draft");
  window.dispatchEvent(new Event("pagehide"));
  expect(readChatTabs("/other")?.tabs[0].draft).toBe("Project B draft");
  vi.advanceTimersByTime(5000);
  expect(readChatTabs("/typing")?.tabs[0].draft).toBe("Project A draft");
});

it("flushes before an explicit update save and preserves submitted drafts during validation", () => {
  type("Prompt with @source:");
  useAgentChatStore.setState((s) => ({
    tabs: s.tabs.map((t) => ({ ...t, submittedDraft: t.draft, draft: "" })),
  }));
  persistChatTabs();
  expect(readChatTabs("/typing")?.tabs[0].draft).toBe("Prompt with @source:");
  useAgentChatStore.setState((s) => ({
    tabs: s.tabs.map((t) => ({ ...t, submittedDraft: undefined })),
  }));
  window.dispatchEvent(new Event("beforeunload"));
  expect(readChatTabs("/typing")?.tabs[0].draft).toBe("");
});
