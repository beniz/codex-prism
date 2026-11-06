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
    expect(host.querySelector('[aria-label="Instructions configured"]')).not.toBeNull();
    await act(async () => host.querySelector('button')!.click());
    expect(document.querySelector('textarea')!.value).toBe("Use the paper");
    const save = [...document.querySelectorAll('button')].find(b => b.textContent === 'Save')!;
    await act(async () => save.click());
    expect(backend.projects.setInstructions).toHaveBeenCalledWith("project-a", "Use the paper");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
