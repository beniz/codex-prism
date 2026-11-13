import { beforeEach, expect, it, vi } from "vitest";
import { backend, invoke } from "@/lib/backend";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import {
  loadProjectPreview,
  loadSavedProjectPreview,
} from "@/lib/project-preview";
vi.mock("@/lib/backend", () => ({
  invoke: vi.fn(),
  backend: { projects: { register: vi.fn() }, files: { read: vi.fn() } },
}));
vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: vi.fn() }));
let counter = 0;
let project: string;
let client: {
  openDocument: ReturnType<typeof vi.fn>;
  renderThumbnail: ReturnType<typeof vi.fn>;
  closeDocument: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  project = `p${++counter}`;
  vi.mocked(backend.projects.register).mockResolvedValue({
    id: project,
    root: "/project",
    name: "Project",
  } as any);
  client = {
    openDocument: vi.fn().mockResolvedValue(1),
    renderThumbnail: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
    closeDocument: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(getMupdfClient).mockReturnValue(client as any);
  vi.mocked(backend.files.read).mockResolvedValue({
    bytes: [37, 80, 68, 70],
    revision: "r1",
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue(`blob:${project}`);
});
const manifest = (revision = "1") => ({
  createdAt: 1000,
  pdfs: [{ path: ".prism/build/thesis.pdf", revision }],
  texFiles: ["thesis.tex"],
});
it("reads a discovered PDF through the project backend and renders its first page without compiling", async () => {
  vi.mocked(invoke).mockResolvedValue(manifest());
  expect(await loadProjectPreview(project)).toEqual({
    kind: "pdf",
    url: `blob:${project}`,
    createdAt: 1000,
  });
  expect(backend.files.read).toHaveBeenCalledWith({
    projectId: project,
    path: ".prism/build/thesis.pdf",
  });
  expect(client.renderThumbnail).toHaveBeenCalledWith(1, 0, 420);
  expect(client.closeDocument).toHaveBeenCalledWith(1);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("project_service", {
    projectId: project,
    operation: "project_preview",
    args: {},
  });
});
it("rechecks disk revisions on later visits and rerenders changed PDFs", async () => {
  vi.mocked(invoke).mockResolvedValue(manifest());
  await loadProjectPreview(project);
  await loadProjectPreview(project);
  expect(client.renderThumbnail).toHaveBeenCalledTimes(1);
  vi.mocked(invoke).mockResolvedValue(manifest("2"));
  await loadProjectPreview(project);
  expect(client.renderThumbnail).toHaveBeenCalledTimes(2);
});
it("tries another PDF after an invalid PDF and always releases opened documents", async () => {
  vi.mocked(invoke).mockResolvedValue({
    ...manifest(),
    pdfs: [
      { path: "broken.pdf", revision: "1" },
      { path: "paper.pdf", revision: "1" },
    ],
  });
  client.renderThumbnail.mockRejectedValueOnce(new Error("Bad PDF"));
  expect((await loadProjectPreview(project)).kind).toBe("pdf");
  expect(client.closeDocument).toHaveBeenCalledTimes(2);
  expect(backend.files.read).toHaveBeenLastCalledWith({
    projectId: project,
    path: "paper.pdf",
  });
});
it("keeps a text fallback without compilation and discovers PDFs created later", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...manifest(), pdfs: [] });
  vi.mocked(backend.files.read).mockResolvedValue({
    bytes: [...new TextEncoder().encode("\\documentclass{article}")],
    revision: "r1",
  });
  expect(await loadProjectPreview(project)).toMatchObject({
    kind: "tex",
    fileName: "thesis.tex",
  });
  expect(client.openDocument).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(manifest());
  expect((await loadProjectPreview(project)).kind).toBe("pdf");
});
it("shares simultaneous requests for the same project", async () => {
  vi.mocked(invoke).mockResolvedValue(manifest());
  await Promise.all([loadProjectPreview(project), loadProjectPreview(project)]);
  expect(client.renderThumbnail).toHaveBeenCalledTimes(1);
});

it("restores a saved preview without registration, PDF reads, or worker startup", async () => {
  vi.spyOn(HTMLImageElement.prototype, "decode").mockResolvedValue(undefined);
  vi.mocked(invoke).mockResolvedValue({
    projectId: project,
    pdf: ".prism/build/thesis.pdf",
    revision: "1",
    bytes: [137, 80, 78, 71],
    createdAt: 1000,
  });
  expect(await loadSavedProjectPreview(project)).toMatchObject({ kind: "pdf" });
  expect(backend.projects.register).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(manifest());
  expect(await loadProjectPreview(project)).toMatchObject({ kind: "pdf" });
  expect(backend.files.read).not.toHaveBeenCalled();
  expect(getMupdfClient).not.toHaveBeenCalled();
});
it("drops requests cancelled before discovery without opening a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    loadProjectPreview(project, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(backend.projects.register).not.toHaveBeenCalled();
  expect(getMupdfClient).not.toHaveBeenCalled();
});
it("ignores corrupt saved images and removes their cache entry", async () => {
  vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(
    new Error("Invalid PNG"),
  );
  vi.mocked(invoke).mockResolvedValue({
    projectId: project,
    pdf: "main.pdf",
    revision: "1",
    bytes: [1],
  });
  expect(await loadSavedProjectPreview(project)).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("project_service", {
    projectId: "",
    operation: "thumbnail_cache_delete",
    args: { root: project },
  });
});
