import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectPicker } from "@/components/project-picker";
import { useProjectStore } from "@/stores/project-store";
import { useAgentSetupStore } from "@/stores/agent-setup-store";

vi.mock("@/lib/project-preview", () => ({
  loadSavedProjectPreview: async () => null,
  retainProjectPreview: () => () => {},
  loadProjectPreview: async (path: string) => ({
    kind: "pdf",
    url: `blob:${path}`,
    createdAt: null,
  }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "test" }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));

it("organizes projects through folder creation, moves, navigation, rename and removal", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("IntersectionObserver", undefined);
  const original = useProjectStore.getState();
  const check = vi
    .spyOn(useAgentSetupStore.getState(), "checkStatus")
    .mockResolvedValue(undefined);
  useProjectStore.setState({
    folders: [],
    folderView: null,
    recentProjects: [
      { path: "/work/paper", name: "paper", lastOpened: 1 },
      { path: "/work/book", name: "book", lastOpened: 2 },
    ],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = async (selector: string) =>
    act(async () => {
      document.querySelector<HTMLButtonElement>(selector)!.click();
    });
  const fillName = async (name: string) =>
    act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        '[role="dialog"] input',
      )!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () => root.render(<ProjectPicker />));
    expect(
      host.querySelector('img[alt="paper preview"]')?.getAttribute("src"),
    ).toBe("blob:/work/paper");
    expect(host.querySelector('img[alt="book preview"]')).not.toBeNull();
    await click('[aria-label="New folder"]');
    await fillName("Research");
    await click('[role="dialog"] button[type="submit"]');
    const id = useProjectStore.getState().folders[0].id;
    expect(document.querySelector("h1")!.textContent).toBe("Research");
    expect(
      document.querySelector('[aria-label="Folder for paper"]'),
    ).toBeNull();
    await act(async () => {
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "All Projects")!
        .click();
    });
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(
        '[aria-label="Folder for paper"]',
      )!;
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "Research")!
        .click();
    });
    expect(
      host.querySelector('[aria-label="Folder for paper"]'),
    ).not.toBeNull();
    expect(host.querySelector('[aria-label="Folder for book"]')).toBeNull();
    expect(
      host.querySelector('img[alt="paper preview"]')?.getAttribute("src"),
    ).toBe("blob:/work/paper");
    await click('[aria-label="Rename folder Research"]');
    await fillName("Papers");
    await click('[role="dialog"] button[type="submit"]');
    expect(host.querySelector("h1")!.textContent).toBe("Papers");
    await click('[aria-label="Remove folder Papers"]');
    await act(async () => {
      Array.from(document.querySelectorAll('[role="dialog"] button'))
        .find((b) => b.textContent === "Remove folder")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useProjectStore.getState().folders).toEqual([]);
    expect(
      useProjectStore.getState().recentProjects.map((p) => p.path),
    ).toEqual(["/work/paper", "/work/book"]);
    expect(
      useProjectStore.getState().recentProjects.every((p) => !p.folderId),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useProjectStore.setState(original);
    check.mockRestore();
    vi.unstubAllGlobals();
  }
});
