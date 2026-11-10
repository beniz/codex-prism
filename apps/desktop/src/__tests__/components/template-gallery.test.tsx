import { saveSourcesWithFiles } from "@/lib/data-sources";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exists, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { TemplateGallery } from "@/components/template-gallery/template-gallery";
import { TemplatePreview } from "@/components/template-gallery/template-preview";
import { backend, type TemplateLibrary } from "@/lib/backend";
import { privateTemplateItem } from "@/lib/template-catalog";
import { getTemplatePdfBuffer } from "@/lib/template-preview-cache";
import { useTemplateStore } from "@/stores/template-store";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";

vi.mock("@/lib/template-preview-cache", () => ({
  getTemplatePdfBuffer: vi.fn(),
  resetPrivatePreviewFailures: vi.fn(),
  subscribeThumbnails: () => () => {},
  getThumbnail: () => undefined,
  isThumbnailFailed: () => true,
  generateThumbnail: vi.fn(async () => null),
}));
vi.mock("@/lib/data-sources", () => ({ getProjectSettings: vi.fn(async () => ({ revision: 1, instructions: "", sources: [] })), saveSourcesWithFiles: vi.fn(async (_id, _root, settings) => settings) }));
vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: vi.fn() }));

const library: TemplateLibrary = {
  root: "/home/test/.codexprism/templates",
  templates: [
    {
      id: "private:lab",
      name: "Lab manuscript",
      description: "A complete starter",
      category: "academic",
      tags: ["internal"],
      mainFile: "document/paper.tex",
      revision: "one",
    },
  ],
  issues: [{ folder: "broken", message: "Several main documents found" }],
};
let root: Root;
let host: HTMLDivElement;
const originalOpenProject = useDocumentStore.getState().openProject;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(backend.projects, "register").mockResolvedValue({ id: "new-project", root: "/work/new-paper", name: "New paper" } as any);
  useTemplateStore.getState().reset();
  useProjectStore.setState({ lastProjectFolder: "/work" });
  vi.mocked(getTemplatePdfBuffer).mockRejectedValue(
    new Error("Missing TeX Live"),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useDocumentStore.setState({ openProject: originalOpenProject });
});
function button(label: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  )!;
}
function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

it("shows private cards, counts, library issues, and rescans through Refresh", async () => {
  const list = vi.spyOn(backend.templates, "list").mockResolvedValue(library);
  await act(async () => root.render(<TemplateGallery />));
  expect(host.textContent).toContain("Lab manuscript");
  expect(host.textContent).toContain("Private");
  expect(host.textContent).toContain("broken: Several main documents found");
  const my = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith("My Templates"),
  )!;
  expect(my.textContent).toBe("My Templates1");
  await act(async () => my.click());
  expect(host.textContent).toContain(library.root);
  expect(host.textContent).not.toContain("Standard Research Paper");
  list.mockResolvedValue({ ...library, templates: [], issues: [] });
  await act(async () => button("Refresh").click());
  expect(list).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("No private templates yet");
});

it.each([
  false,
  true,
])("creates a full private project despite a failed preview (custom instructions: %s)", async (customInstructions) => {
  const item = privateTemplateItem(library.templates[0]);
  useTemplateStore.setState({ templates: [item], previewTemplateId: item.id });
  const create = vi
    .spyOn(backend.templates, "createProject")
    .mockResolvedValue({
      project: { id: "project", root: "/work/new-paper", name: "new-paper" },
      mainFile: "document/paper.tex",
    });
  vi.mocked(exists).mockImplementation(
    async (path) => String(path).endsWith("AGENTS.md") && customInstructions,
  );
  vi.mocked(writeTextFile).mockResolvedValue(undefined);
  const open = vi.fn(async () => {});
  useDocumentStore.setState({ openProject: open });
  const session = vi
    .spyOn(useAgentChatStore.getState(), "newSession")
    .mockImplementation(() => {});
  const prompt = vi
    .spyOn(useAgentChatStore.getState(), "setPendingInitialPrompt")
    .mockImplementation(() => {});
  await act(async () => root.render(<TemplatePreview />));
  expect(document.body.textContent).toContain("Missing TeX Live");
  expect(document.body.textContent).toContain(
    "You can still use this template",
  );
  await act(async () => button("Retry preview").click());
  expect(getTemplatePdfBuffer).toHaveBeenLastCalledWith(item, true, true);
  await act(async () => button("Use Template").click());
  await act(async () => {
    fill(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="e.g., conference-paper"]',
      )!,
      "new-paper",
    );
    if (!customInstructions)
      fill(document.querySelector("textarea")!, "Write about proteins");
  });
  if (customInstructions) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(saveSourcesWithFiles).mockRejectedValueOnce(new Error("Source unavailable"));
    await act(async () => button("Create Project").click());
    expect(open).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  }
  await act(async () =>
    button(
      customInstructions ? "Create Project" : "Create & Generate with AI",
    ).click(),
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(item.id, "one", "/work/new-paper");
  expect(mkdir).not.toHaveBeenCalled();
  expect(saveSourcesWithFiles).toHaveBeenCalledWith("new-project", "/work/new-paper", expect.objectContaining({ revision: 1 }), []);
  expect(open).toHaveBeenCalledWith("/work/new-paper", "document/paper.tex");
  if (customInstructions) {
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  } else {
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile).toHaveBeenCalledWith(
      "/work/new-paper/AGENTS.md",
      expect.any(String),
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.stringContaining("adapt the existing document"),
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.stringContaining("Write about proteins"),
    );
  }
  expect(useTemplateStore.getState().previewTemplateId).toBeNull();
});

it("resizes the PDF after dialog layout and redraws when returning from details", async () => {
  const { getMupdfClient } = await import("@/lib/mupdf/mupdf-client");
  let resize = () => {};
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  let height = 60;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  const paint = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: paint } as any);
  const drawPage = vi.fn(async (_docId: number, _page: number, _dpi: number) => ({ width: 600, height: 800 }) as ImageData);
  vi.mocked(getMupdfClient).mockReturnValue({
    openDocument: vi.fn(async () => 1),
    closeDocument: vi.fn(async () => {}),
    countPages: vi.fn(async () => 1),
    getPageSize: vi.fn(async () => ({ width: 600, height: 800 })),
    drawPage,
  } as any);
  vi.mocked(getTemplatePdfBuffer).mockResolvedValue(new ArrayBuffer(5));
  const flushFrame = async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  };
  try {
    useTemplateStore.getState().openPreview("paper-standard");
    await act(async () => root.render(<TemplatePreview />));
    await flushFrame();
    const initialDpi = drawPage.mock.calls[0]?.[2];
    height = 650;
    act(() => resize());
    await flushFrame();
    expect(drawPage.mock.calls[drawPage.mock.calls.length - 1][2]).toBeGreaterThan(initialDpi!);
    expect(parseFloat(document.querySelector("canvas")!.style.height)).toBe(602);
    await act(async () => button("Use Template").click());
    expect(document.querySelector("canvas")).toBeNull();
    const before = paint.mock.calls.length;
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Back to preview"]')!.click());
    await flushFrame();
    expect(document.querySelector("canvas")).not.toBeNull();
    expect(paint.mock.calls.length).toBeGreaterThan(before);
  } finally {
    globalThis.ResizeObserver = previousObserver;
  }
});
