import { beforeEach, expect, it, vi } from "vitest";
import { migrateStorageKey } from "@/lib/legacy-storage";
beforeEach(() => localStorage.clear());
it("moves legacy preferences without losing their contents", () => {
  localStorage.setItem(
    "claude-prism-settings",
    '{"state":{"autoRecompile":true}}',
  );
  expect(migrateStorageKey("codex-prism-settings")).toBe(
    "codex-prism-settings",
  );
  expect(localStorage.getItem("codex-prism-settings")).toBe(
    '{"state":{"autoRecompile":true}}',
  );
  expect(localStorage.getItem("claude-prism-settings")).toBeNull();
});
it("preserves newer values and does not resurrect removed preferences", () => {
  localStorage.setItem("codex-prism-app-zoom", "1.5");
  localStorage.setItem("claude-prism-app-zoom", "2");
  migrateStorageKey("codex-prism-app-zoom");
  expect(localStorage.getItem("codex-prism-app-zoom")).toBe("1.5");
  localStorage.removeItem("codex-prism-app-zoom");
  migrateStorageKey("codex-prism-app-zoom");
  expect(localStorage.getItem("codex-prism-app-zoom")).toBeNull();
});
it("retains legacy data if the new value cannot be written", () => {
  localStorage.setItem("claude-prism-projects", "projects");
  const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  migrateStorageKey("codex-prism-projects");
  spy.mockRestore();
  expect(localStorage.getItem("claude-prism-projects")).toBe("projects");
});
