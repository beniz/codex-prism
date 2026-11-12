import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import { synctexEdit } from "@/lib/latex-compiler";
import { invoke } from "@/lib/backend";
const state = vi.hoisted(() => ({
  projectRoot: "/paper",
  files: [
    { id: "chapter", relativePath: "chapter.tex", content: "First\nSecond" },
  ],
}));
vi.mock("@/lib/backend", () => ({ invoke: vi.fn() }));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: () => state },
  resolveTexRoot: vi.fn(),
}));
const revision = (text: string) =>
  createHash("sha1").update(text).digest("hex");
const pdf = new TextEncoder().encode("%PDF-current").buffer;
const result = () => ({
  file: "chapter.tex",
  line: 2,
  column: 0,
  sourceRevision: revision("First\nSecond"),
});
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  state.projectRoot = "/paper";
  state.files[0].content = "First\nSecond";
  vi.mocked(invoke).mockResolvedValue(result());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("identifies the displayed PDF and accepts only matching captured text", async () => {
  expect(
    await synctexEdit("/paper", "slides.tex", pdf, 3, 40, 80),
  ).toMatchObject({ file: "chapter.tex", line: 2 });
  expect(invoke).toHaveBeenCalledWith("synctex_edit", {
    projectDir: "/paper",
    mainFile: "slides.tex",
    pdfRevision: revision("%PDF-current"),
    page: 3,
    x: 40,
    y: 80,
  });
});
it("refuses old line numbers after edits or a project switch", async () => {
  state.files[0].content = "Inserted\nFirst\nSecond";
  expect(await synctexEdit("/paper", "slides.tex", pdf, 3, 40, 80)).toBeNull();
  state.files[0].content = "First\nSecond";
  vi.mocked(invoke).mockImplementationOnce(async () => {
    state.projectRoot = "/other";
    return result();
  });
  expect(await synctexEdit("/paper", "slides.tex", pdf, 3, 40, 80)).toBeNull();
});
it("reports unavailable mappings without falling back to another build", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  expect(await synctexEdit("/paper", "slides.tex", pdf, 3, 40, 80)).toBeNull();
  vi.mocked(invoke).mockRejectedValueOnce(new Error("No SyncTeX"));
  expect(await synctexEdit("/paper", "slides.tex", pdf, 3, 40, 80)).toBeNull();
});
