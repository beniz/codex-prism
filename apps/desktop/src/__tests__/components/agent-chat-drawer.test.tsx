import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentChatDrawer } from "@/components/agent-chat/agent-chat-drawer";
import { useAgentSetupStore } from "@/stores/agent-setup-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";

vi.mock("@/stores/agent-chat-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/agent-chat-store")>()),
  ensureAgentEvents: vi.fn(async () => {}),
}));

it("mounts the document chat drawer with real store hooks and updates selected state", async () => {
  const check = vi
    .spyOn(useAgentSetupStore.getState(), "checkStatus")
    .mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AgentChatDrawer />));
    expect(container.textContent).toContain("What would you like to work on?");
    await act(async () =>
      useAgentChatStore.setState({ error: "Test connection error" }),
    );
    expect(container.textContent).toContain("Test connection error");
  } finally {
    await act(async () => root.unmount());
    useAgentChatStore.setState({ error: null });
    check.mockRestore();
  }
});

it("continues a list with Shift+Enter and sends its Markdown unchanged with Enter", async () => {
  const originalChat = useAgentChatStore.getState();
  const originalSetup = useAgentSetupStore.getState();
  const sendPrompt = vi.fn(async () => {});
  useAgentSetupStore.setState({ status: "ready", checkStatus: vi.fn(async () => {}) });
  useAgentChatStore.setState({
    locked: false,
    sendPrompt,
    tabs: originalChat.tabs.map(t => ({ ...t, draft: "- First", isStreaming: false })),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AgentChatDrawer />));
    const field = container.querySelector("textarea")!;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    const shiftEnter = () => field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", shiftKey: true, bubbles: true, cancelable: true,
    }));
    await act(async () => { shiftEnter(); });
    expect(field.value).toBe("- First\n- ");
    expect(field.selectionStart).toBe(field.value.length);
    expect(sendPrompt).not.toHaveBeenCalled();
    await act(async () => { shiftEnter(); });
    expect(field.value).toBe("- First\n");
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    })); });
    expect(sendPrompt).toHaveBeenCalledWith("- First\n");
    expect(field.value).toBe("");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAgentChatStore.setState(originalChat);
    useAgentSetupStore.setState(originalSetup);
  }
});

it("toggles Plan with Shift+Tab only when idle and implements in the same chat", async () => {
  const original = useAgentChatStore.getState();
  const setup = useAgentSetupStore.getState();
  const sendPrompt = vi.fn(async () => {});
  useAgentSetupStore.setState({ status: "ready", checkStatus: vi.fn(async () => {}) });
  useAgentChatStore.setState({ locked: false, sendPrompt, tabs: original.tabs.map(t => ({ ...t, mode: "default", draft: "my draft", isStreaming: false, error: null, messages: [{ id: "plan", type: "proposedPlan", status: "completed", text: "A plan" }] })) });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AgentChatDrawer />));
    const toggle = () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", {key: "Tab", shiftKey: true, bubbles: true, cancelable: true}));
    await act(async () => { toggle(); });
    expect(useAgentChatStore.getState().tabs[0].mode).toBe("plan");
    const implement = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Implement plan")!;
    await act(async () => implement.click());
    expect(sendPrompt).toHaveBeenCalledWith("Implement the plan.");
    expect(useAgentChatStore.getState().tabs[0].draft).toBe("my draft");
    await act(async () => useAgentChatStore.setState(s => ({ tabs: s.tabs.map(t => ({ ...t, isStreaming: true })) })));
    await act(async () => { toggle(); });
    expect(useAgentChatStore.getState().tabs[0].mode).toBe("default");
  } finally {
    await act(async () => root.unmount());
    useAgentChatStore.setState(original);
    useAgentSetupStore.setState(setup);
  }
});

it("recalls this chat's prompts while running and returns to an empty composer", async () => {
  const original = useAgentChatStore.getState();
  const setup = useAgentSetupStore.getState();
  const sendPrompt = vi.fn(async () => {});
  useAgentSetupStore.setState({ checkStatus: vi.fn(async () => {}) });
  useAgentChatStore.setState({ sendPrompt, tabs: original.tabs.map(t => ({ ...t, draft: "", isStreaming: true, messages: [
    { id: "u1", type: "userMessage", text: "First\nmultiline prompt" },
    { id: "a1", type: "agentMessage", text: "Answer" },
    { id: "u2", type: "userMessage", text: "Latest prompt" },
  ] })) });
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<AgentChatDrawer />));
    const field = host.querySelector('textarea')!;
    const key = async (key: string, shiftKey = false) => act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); });
    await key('ArrowUp', true); expect(field.value).toBe('');
    await key('ArrowUp'); expect(field.value).toBe('Latest prompt');
    await key('ArrowUp'); expect(field.value).toBe('First\nmultiline prompt');
    await key('ArrowUp'); expect(field.value).toBe('First\nmultiline prompt');
    await key('ArrowDown'); expect(field.value).toBe('Latest prompt');
    await key('ArrowDown'); expect(field.value).toBe('');
    expect(sendPrompt).not.toHaveBeenCalled();
    await key('ArrowUp');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Edited draft');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await key('ArrowDown'); expect(field.value).toBe('Edited draft');
  } finally {
    await act(async () => root.unmount());
    useAgentChatStore.setState(original); useAgentSetupStore.setState(setup);
  }
});
