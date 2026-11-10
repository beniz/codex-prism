import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { exists, mkdir, writeTextFile } from "@/lib/backend/desktop-host";
import { backend } from "@/lib/backend";
import { createProject, type CreationAttempt } from "@/lib/project-creation";
import { getTemplateById } from "@/lib/template-registry";
import { privateTemplateItem } from "@/lib/template-catalog";
import {
  getProjectSettings,
  saveSourcesWithFiles,
  type ProjectSettings,
} from "@/lib/data-sources";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";

vi.mock("@/lib/data-sources", () => ({
  getProjectSettings: vi.fn(),
  saveSourcesWithFiles: vi.fn(),
}));
const disk = new Map<string, string>();
const originalOpen = useDocumentStore.getState().openProject;
let settings: ProjectSettings;
let attempt: CreationAttempt;
let open = vi.fn(async () => {});
let session: ReturnType<typeof vi.spyOn>;
const saved = vi.fn();
function request(id = "blank") {
  return {
    template: { ...getTemplateById(id)!, source: "builtin" as const },
    parentDirectory: "/work",
    name: "new paper",
    purpose: "Write about galaxies",
    settings,
    files: ["/outside/paper.pdf"],
  };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  disk.clear();
  attempt = {};
  settings = {
    revision: 0,
    instructions: "Use the draft",
    sources: [{ id: "data", name: "Data", path: "/data", kind: "directory" }],
    connections: [],
  };
  vi.mocked(exists).mockImplementation(async (path) => disk.has(String(path)));
  vi.mocked(mkdir).mockImplementation(async (path) => {
    disk.set(String(path), "directory");
  });
  vi.mocked(writeTextFile).mockImplementation(async (path, value) => {
    disk.set(String(path), value);
  });
  vi.spyOn(backend.projects, "register").mockResolvedValue({
    id: "new",
    name: "new paper",
    root: "/work/new paper",
  });
  vi.mocked(getProjectSettings).mockImplementation(async () =>
    structuredClone(settings),
  );
  vi.mocked(saveSourcesWithFiles).mockImplementation(
    async (_id, _root, updated, files) => {
      settings = {
        ...updated,
        revision: settings.revision + 1,
        sources: [
          ...updated.sources,
          ...files.map((path) => ({
            id: path,
            name: "paper.pdf",
            path: "attachments/paper.pdf",
            kind: "file" as const,
          })),
        ],
      };
      return settings;
    },
  );
  open = vi.fn(async () => {});
  useDocumentStore.setState({ openProject: open });
  session = vi
    .spyOn(useAgentChatStore.getState(), "newSession")
    .mockImplementation(() => {});
  vi.spyOn(
    useAgentChatStore.getState(),
    "setPendingInitialPrompt",
  ).mockImplementation(() => {});
});
afterEach(() => {
  useDocumentStore.setState({ openProject: originalOpen });
  vi.restoreAllMocks();
});

it.each([
  "blank",
  "paper-standard",
])("creates %s with instructions, sources, and the initial prompt", async (id) => {
  const input = request(id);
  await createProject(input, attempt, saved);
  expect(disk.get("/work/new paper/main.tex")).toContain("\\documentclass");
  expect(disk.has("/work/new paper/references.bib")).toBe(
    input.template.hasBibliography,
  );
  expect(disk.get("/work/new paper/AGENTS.md")).toContain("codex-prism");
  expect(settings.instructions).toBe("Use the draft");
  expect(settings.sources.map((s) => s.id)).toEqual([
    "data",
    "/outside/paper.pdf",
  ]);
  expect(open).toHaveBeenCalledWith("/work/new paper", "main.tex");
  expect(
    useAgentChatStore.getState().setPendingInitialPrompt,
  ).toHaveBeenCalledWith(expect.stringContaining("Write about galaxies"));
});

it("preserves private contents, custom instructions, and a nested main filename", async () => {
  const template = privateTemplateItem({
    id: "private:lab",
    name: "Lab",
    description: "",
    tags: [],
    category: "academic",
    revision: "v1",
    mainFile: "chapters/paper.tex",
  });
  const copy = vi
    .spyOn(backend.templates, "createProject")
    .mockImplementation(async () => {
      disk.set("/work/new paper", "directory");
      disk.set("/work/new paper/AGENTS.md", "Custom guidance");
      disk.set("/work/new paper/chapters/paper.tex", "Full document");
      return {
        project: { id: "new", name: "new paper", root: "/work/new paper" },
        mainFile: "chapters/paper.tex",
      };
    });
  await createProject({ ...request(), template }, attempt, saved);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(writeTextFile).not.toHaveBeenCalled();
  expect(disk.get("/work/new paper/chapters/paper.tex")).toBe("Full document");
  expect(open).toHaveBeenCalledWith("/work/new paper", "chapters/paper.tex");
  expect(
    useAgentChatStore.getState().setPendingInitialPrompt,
  ).toHaveBeenCalledWith(
    expect.stringContaining("adapt the existing document"),
  );
});

it("rejects an existing destination and invalid names before writing", async () => {
  disk.set("/work/new paper", "directory");
  await expect(createProject(request(), attempt, saved)).rejects.toThrow(
    "already exists",
  );
  await expect(
    createProject({ ...request(), name: "../outside" }, attempt, saved),
  ).rejects.toThrow("characters");
  expect(writeTextFile).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
});

it("retries a partial write without replacing existing source", async () => {
  vi.mocked(writeTextFile).mockRejectedValueOnce(new Error("Disk full"));
  await expect(createProject(request(), attempt, saved)).rejects.toThrow(
    "Disk full",
  );
  disk.set("/work/new paper/main.tex", "User recovered source");
  await createProject(request(), attempt, saved);
  expect(disk.get("/work/new paper/main.tex")).toBe("User recovered source");
  expect(open).toHaveBeenCalledTimes(1);
});

it("retries a failed import without opening or generating prematurely", async () => {
  const input = request();
  vi.mocked(saveSourcesWithFiles).mockRejectedValueOnce(
    new Error("Import failed"),
  );
  await expect(createProject(input, attempt, saved)).rejects.toThrow(
    "Import failed",
  );
  expect(open).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
  await createProject(input, attempt, saved);
  expect(settings.sources.filter((s) => s.kind === "file")).toHaveLength(1);
  expect(disk.get("/work/new paper/main.tex")).toContain("\\documentclass");
});

it("does not duplicate imports or chats when opening fails after creation", async () => {
  const input = request();
  open.mockRejectedValueOnce(new Error("Open failed"));
  await expect(createProject(input, attempt, saved)).rejects.toThrow(
    "Open failed",
  );
  await createProject(input, attempt, saved);
  expect(saveSourcesWithFiles).toHaveBeenLastCalledWith(
    "new",
    "/work/new paper",
    expect.anything(),
    [],
  );
  expect(settings.sources.filter((s) => s.kind === "file")).toHaveLength(1);
  expect(session).toHaveBeenCalledTimes(1);
});
