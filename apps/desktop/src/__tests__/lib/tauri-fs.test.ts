import { describe, it, expect, beforeEach, vi } from "vitest";
import { backend } from "@/lib/backend";
import { readTexFileContent, writeTexFileContent } from "@/lib/tauri/fs";
import { getProjectFileType, scanProjectFolder } from "@/lib/tauri/fs";

describe("tauri fs helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getProjectFileType", () => {
    it("classifies editable project files", () => {
      expect(getProjectFileType("main.tex")).toBe("tex");
      expect(getProjectFileType("chapter.TEX")).toBe("tex");
      expect(getProjectFileType("refs.bib")).toBe("bib");
      expect(getProjectFileType("output.pdf")).toBe("pdf");
      expect(getProjectFileType("figure.png")).toBe("image");
      expect(getProjectFileType("custom.sty")).toBe("style");
      expect(getProjectFileType("notes.md")).toBe("other");
      expect(getProjectFileType("script.py")).toBe("other");
    });

    it("ignores LaTeX and compiled build artifacts", () => {
      expect(getProjectFileType("main.aux")).toBeNull();
      expect(getProjectFileType("main.synctex.gz")).toBeNull();
      expect(getProjectFileType("module.pyc")).toBeNull();
      expect(getProjectFileType("native.pyd")).toBeNull();
      expect(getProjectFileType("libnative.so")).toBeNull();
    });

    it("keeps imported files with arbitrary extensions visible", () => {
      expect(getProjectFileType("archive.zip")).toBe("other");
      expect(getProjectFileType("paper.docx")).toBe("other");
      expect(getProjectFileType("data.xlsx")).toBe("other");
      expect(getProjectFileType("movie.mp4")).toBe("other");
    });
  });

  describe("project backend adapter", () => {
    beforeEach(() => {
      vi.spyOn(backend.projects, "register").mockResolvedValue({
        id: "p1",
        root: "/project",
        name: "Project",
      });
      vi.spyOn(backend.files, "list").mockResolvedValue({
        folders: ["chapters"],
        files: [
          { path: "main.tex", size: 10 },
          { path: "chapters/intro.tex", size: 20 },
          { path: "worker.py", size: 128 },
        ],
      });
    });
    it("uses project IDs to list nested relative files", async () => {
      const result = await scanProjectFolder("/project");
      expect(backend.files.list).toHaveBeenCalledWith("p1");
      expect(result.files.map((f) => f.relativePath)).toEqual([
        "main.tex",
        "chapters/intro.tex",
        "worker.py",
      ]);
      expect(result.folders).toEqual(["chapters"]);
    });
    it("passes the read revision on save and propagates conflicts", async () => {
      await scanProjectFolder("/project");
      vi.spyOn(backend.files, "read").mockResolvedValue({
        bytes: [104, 105],
        revision: "r1",
      });
      vi.spyOn(backend.files, "write").mockRejectedValue(
        new Error("File changed"),
      );
      expect(await readTexFileContent("/project/main.tex")).toBe("hi");
      await expect(
        writeTexFileContent("/project/main.tex", "new"),
      ).rejects.toThrow("File changed");
      expect(backend.files.write).toHaveBeenCalledWith(
        { projectId: "p1", path: "main.tex" },
        [110, 101, 119],
        "r1",
      );
    });
  });
});
