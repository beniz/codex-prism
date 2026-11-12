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
    // The store owns clearing and failure recovery; this mocked store does not
    // mutate the draft itself.
    expect(field.value).toBe("- First\n");
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

it("accents approvals without changing the approval action or request ownership", async () => {
  const original = useAgentChatStore.getState();
  const setup = useAgentSetupStore.getState();
  const respond = vi.fn(async () => {});
  const request = { id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "approval-thread", command: "python plot.py", reason: "Create a figure" } };
  useAgentSetupStore.setState({ checkStatus: vi.fn(async () => {}) });
  useAgentChatStore.setState({
    respond, activeTabId: original.tabs[0].id, requests: [request],
    tabs: original.tabs.map((tab, index) => index === 0 ? { ...tab, sessionId: "approval-thread" } : tab),
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AgentChatDrawer />));
    expect(host.querySelector('[data-activity-kind="approval"]')?.textContent).toBe("Permission requested");
    expect(host.textContent).toContain("Create a figure");
    const allow = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Allow once")!;
    await act(async () => allow.click());
    expect(respond).toHaveBeenCalledWith(request, { decision: "accept" });
  } finally {
    await act(async () => root.unmount());
    useAgentChatStore.setState(original);
    useAgentSetupStore.setState(setup);
  }
});

it("shows questions in the composer, retains choices across chats, and submits only explicit answers", async () => {
  const original = useAgentChatStore.getState();
  const setup = useAgentSetupStore.getState();
  const request = {
    id: 71, method: "item/tool/requestUserInput", params: {
      threadId: "plan-a", questions: [
        { id: "scope", question: "Which scope?", options: [{ label: "Overview", description: "Keep it brief" }, { label: "Detailed" }] },
        { id: "audience", question: "Who is the audience?" },
      ],
    },
  };
  const other = { ...request, id: 72, params: { ...request.params, threadId: "plan-b" } };
  let finish!: () => void;
  const respond = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  useAgentSetupStore.setState({ status: "ready", checkStatus: vi.fn(async () => {}) });
  useAgentChatStore.setState({
    respond, requests: [request, other], activeTabId: "a", pendingAttachments: [],
    tabs: ["a", "b"].map(id => ({ ...original.tabs[0], id, sessionId: `plan-${id}`, mode: "plan", isStreaming: true, draft: `Draft ${id}`, messages: [] })),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AgentChatDrawer />));
    const composer = host.querySelector('[data-chat-composer]')!;
    const forms = Array.from(host.querySelectorAll<HTMLFormElement>('form[aria-label="Plan questions"]'));
    const form = forms[0];
    expect(composer.contains(form)).toBe(true);
    expect(forms[1].closest('[hidden]')).not.toBeNull();
    expect(host.querySelector('[data-chat-mode="plan"]')?.className).toContain('text-[var(--syntax-special)]');
    const draft = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Codex"]')!;
    expect(draft.closest('[hidden]')).not.toBeNull();
    expect(draft.value).toBe("Draft a");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const choice = form.querySelector<HTMLInputElement>('input[value="Overview"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => choice.click());
    expect(choice.checked).toBe(true);
    expect(choice.closest('label')?.dataset.selected).toBe("true");
    expect(choice.closest('label')?.textContent).toContain("Selected");
    expect(submit.disabled).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    await act(async () => useAgentChatStore.setState({ activeTabId: "b" }));
    expect(form.closest('[hidden]')).not.toBeNull();
    expect(forms[1].closest('[hidden]')).toBeNull();
    expect(forms[1].querySelector<HTMLInputElement>('input[value="Overview"]')?.checked).toBe(false);
    await act(async () => useAgentChatStore.setState({ activeTabId: "a" }));
    expect(choice.checked).toBe(true);
    expect(draft.value).toBe("Draft a");
    const answer = form.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(answer, 'Researchers');
      answer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(respond).toHaveBeenCalledExactlyOnceWith(request, {
      answers: { scope: { answers: ["Overview"] }, audience: { answers: ["Researchers"] } },
    });
    expect(submit.disabled).toBe(true);
    await act(async () => submit.click());
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    // A failed delivery leaves the request and selections available for retry.
    expect(choice.checked).toBe(true);
    expect(submit.disabled).toBe(false);
    await act(async () => useAgentChatStore.setState({ requests: [other] }));
    expect(draft.closest('[hidden]')).toBeNull();
    expect(draft.value).toBe("Draft a");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useAgentChatStore.setState(original);
    useAgentSetupStore.setState(setup);
  }
});
