import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectInstructions } from "@/components/agent-chat/project-instructions";
import { backend } from "@/lib/backend";
vi.mock("@/lib/backend", () => ({ backend: { projects: {
  getInstructions: vi.fn(async () => "Use the paper"),
  setInstructions: vi.fn(async (_id: string, text: string) => text),
} } }));
it("loads project instructions and saves them through project metadata", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ProjectInstructions projectId="project-a" />));
    expect(host.textContent).toContain("Instructions configured");
    await act(async () => host.querySelector('button')!.click());
    expect(document.querySelector('textarea')!.value).toBe("Use the paper");
    const save = [...document.querySelectorAll('button')].find(b => b.textContent === 'Save')!;
    await act(async () => save.click());
    expect(backend.projects.setInstructions).toHaveBeenCalledWith("project-a", "Use the paper");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("opens settings from the title and renames through the existing project action", async () => {
  const rename = vi.fn(async () => {});
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const { useAgentChatStore } = await import("@/stores/agent-chat-store");
  const previous = useAgentChatStore.getState().locked;
  useAgentChatStore.setState({ locked: false });
  try {
    await act(async () => root.render(<ProjectInstructions projectId="p" projectName="Paper" renameProject={rename} />));
    expect(host.textContent).toContain("Paper");
    await act(async () => host.querySelector('button')!.click());
    const input = document.querySelector<HTMLInputElement>('#project-settings-name')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'New paper');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Rename')!.click());
    expect(rename).toHaveBeenCalledWith('New paper');
    await act(async () => useAgentChatStore.setState({ locked: true }));
    expect(input.disabled).toBe(true);
    expect(document.querySelector('textarea')!.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); useAgentChatStore.setState({ locked: previous }); }
});
