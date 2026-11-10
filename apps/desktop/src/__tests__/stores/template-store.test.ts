import { describe, it, expect, beforeEach, vi } from "vitest";
import { backend, type TemplateLibrary } from "@/lib/backend";
import { useTemplateStore } from "@/stores/template-store";
import { getAllTemplates } from "@/lib/template-registry";

describe("useTemplateStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useTemplateStore.getState().reset();
  });

  const library: TemplateLibrary = {
    root: "/home/test/.codexprism/templates",
    templates: [
      {
        id: "private:lab",
        name: "Lab manuscript",
        description: "Internal starter",
        category: "academic",
        tags: ["internal"],
        mainFile: "paper.tex",
        revision: "one",
      },
    ],
    issues: [{ folder: "broken", message: "Add a .tex file" }],
  };

  it("merges private templates into search and categories and preserves filters on refresh", async () => {
    vi.spyOn(backend.templates, "list").mockResolvedValue(library);
    await useTemplateStore.getState().refresh();
    expect(useTemplateStore.getState().templates).toHaveLength(
      getAllTemplates().length + 1,
    );
    expect(useTemplateStore.getState().issues).toEqual(library.issues);
    useTemplateStore.getState().setOnlyPrivate(true);
    expect(
      useTemplateStore.getState().filteredTemplates.map((t) => t.id),
    ).toEqual(["private:lab"]);
    useTemplateStore.getState().setSearchQuery("internal manuscript");
    await useTemplateStore.getState().refresh();
    expect(useTemplateStore.getState().filteredTemplates).toHaveLength(1);
    useTemplateStore.getState().setSelectedCategory("professional");
    expect(useTemplateStore.getState().onlyPrivate).toBe(false);
    expect(useTemplateStore.getState().filteredTemplates).toHaveLength(0);
    useTemplateStore.getState().setSelectedCategory("academic");
    expect(useTemplateStore.getState().filteredTemplates[0].id).toBe(
      "private:lab",
    );
  });

  it("ignores out-of-order library responses and closes a removed preview", async () => {
    let resolveOld!: (library: TemplateLibrary) => void;
    vi.spyOn(backend.templates, "list")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...library, templates: [], issues: [] });
    const old = useTemplateStore.getState().refresh();
    useTemplateStore.getState().openPreview("private:lab");
    await useTemplateStore.getState().refresh();
    resolveOld(library);
    await old;
    expect(useTemplateStore.getState().templates).toHaveLength(
      getAllTemplates().length,
    );
    expect(useTemplateStore.getState().previewTemplateId).toBeNull();
  });

  it("keeps built-ins available when the private library cannot be read", async () => {
    vi.spyOn(backend.templates, "list").mockRejectedValue(
      new Error("Permission denied"),
    );
    await useTemplateStore.getState().refresh();
    expect(useTemplateStore.getState().libraryError).toContain(
      "Permission denied",
    );
    expect(useTemplateStore.getState().filteredTemplates).toHaveLength(
      getAllTemplates().length,
    );
    expect(useTemplateStore.getState().loading).toBe(false);
  });

  it("initializes with all templates", () => {
    const all = getAllTemplates();
    const { filteredTemplates } = useTemplateStore.getState();
    expect(filteredTemplates).toHaveLength(all.length);
  });

  describe("setSearchQuery", () => {
    it("filters templates by keyword", () => {
      useTemplateStore.getState().setSearchQuery("paper");
      const { filteredTemplates } = useTemplateStore.getState();
      expect(filteredTemplates.length).toBeGreaterThan(0);
      expect(filteredTemplates.length).toBeLessThan(getAllTemplates().length);
    });

    it("returns all templates for empty query", () => {
      useTemplateStore.getState().setSearchQuery("paper");
      useTemplateStore.getState().setSearchQuery("");
      expect(useTemplateStore.getState().filteredTemplates).toHaveLength(
        getAllTemplates().length,
      );
    });
  });

  it("searches case-insensitively with all words and handles empty/no matches", () => {
    const store = useTemplateStore.getState();
    store.setSearchQuery("RESEARCH paper");
    expect(useTemplateStore.getState().filteredTemplates.map(t => t.id)).toContain("paper-standard");
    store.setSearchQuery("xyznonexistent123");
    expect(useTemplateStore.getState().filteredTemplates).toEqual([]);
    store.setSearchQuery("   ");
    expect(useTemplateStore.getState().filteredTemplates).toHaveLength(getAllTemplates().length);
    for (const category of ["academic", "professional", "creative", "starter"] as const) {
      store.setSelectedCategory(category);
      const selected = useTemplateStore.getState().filteredTemplates;
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.every(t => t.category === category)).toBe(true);
    }
  });

  describe("setSelectedCategory", () => {
    it("filters by category", () => {
      useTemplateStore.getState().setSelectedCategory("academic");
      const { filteredTemplates } = useTemplateStore.getState();
      expect(filteredTemplates.length).toBeGreaterThan(0);
      expect(filteredTemplates.every((t) => t.category === "academic")).toBe(
        true,
      );
    });

    it("clears category filter with null", () => {
      useTemplateStore.getState().setSelectedCategory("academic");
      useTemplateStore.getState().setSelectedCategory(null);
      expect(useTemplateStore.getState().filteredTemplates).toHaveLength(
        getAllTemplates().length,
      );
    });
  });

  describe("combined filters", () => {
    it("applies search + category together", () => {
      useTemplateStore.getState().setSearchQuery("paper");
      useTemplateStore.getState().setSelectedCategory("academic");
      const { filteredTemplates } = useTemplateStore.getState();
      expect(filteredTemplates.length).toBeGreaterThan(0);
      expect(filteredTemplates.every((t) => t.category === "academic")).toBe(
        true,
      );
    });
  });
});
