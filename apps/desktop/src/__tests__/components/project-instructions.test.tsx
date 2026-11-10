import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectInstructions } from "@/components/agent-chat/project-instructions";
import { saveProjectSettings } from "@/lib/data-sources";
vi.mock("@/lib/data-sources", () => ({
  getProjectSettings: vi.fn(async () => ({ revision: 0, instructions: "Use the paper", sources: [] })),
  saveProjectSettings: vi.fn(async (_id: string, settings: unknown) => settings),
}));
vi.mock("@/lib/backend/desktop-host", () => ({ open: vi.fn(async () => null) }));
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
    expect(saveProjectSettings).toHaveBeenCalledWith("project-a", { revision: 0, instructions: "Use the paper", sources: [] });
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

it("adds a directory to the shared project settings", async () => {
  const { open } = await import("@/lib/backend/desktop-host");
  vi.mocked(open).mockResolvedValueOnce("/research/source material");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ProjectInstructions projectId="sources-project" />));
    await act(async () => host.querySelector('button')!.click());
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Add directory')!.click());
    expect(document.body.textContent).toContain("/research/source material");
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save')!.click());
    expect(saveProjectSettings).toHaveBeenCalledWith("sources-project", expect.objectContaining({ sources: [expect.objectContaining({ path: "/research/source material", name: "source material" })] }));
  } finally { await act(async () => root.unmount()); host.remove(); }
});
