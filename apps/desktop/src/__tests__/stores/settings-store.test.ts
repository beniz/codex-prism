import { beforeEach, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";
beforeEach(() => localStorage.clear());
for (const compilerBackend of ["tectonic", "texlive"]) {
  it(`migrates ${compilerBackend} without losing preferences`, async () => {
    localStorage.setItem(
      "codex-prism-settings",
      JSON.stringify({
        version: 0,
        state: { compilerBackend, autoRecompile: true, vimMode: true },
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState()).toMatchObject({
      autoRecompile: true,
      vimMode: true,
    });
    expect(useSettingsStore.getState()).not.toHaveProperty("compilerBackend");
    const saved = JSON.parse(localStorage.getItem("codex-prism-settings")!);
    expect(saved.version).toBe(1);
    expect(saved.state).toEqual({
      incrementalCompilation: true,
      autoRecompile: true,
      vimMode: true,
      editorFontSize: 14,
      visualChangeReports: false,
    });
  });
}

it("restores the editor font size from saved preferences", async () => {
  useSettingsStore.getState().setEditorFontSize(20);
  const saved = localStorage.getItem("codex-prism-settings")!;
  useSettingsStore.setState({ editorFontSize: 14 });
  localStorage.setItem("codex-prism-settings", saved);
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState().editorFontSize).toBe(20);
});

it("remembers disabled visual change reports across sessions", async () => {
  useSettingsStore.getState().setVisualChangeReports(false);
  const saved = localStorage.getItem("codex-prism-settings")!;
  useSettingsStore.setState({ visualChangeReports: true });
  localStorage.setItem("codex-prism-settings", saved);
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState().visualChangeReports).toBe(false);
});

 it("remembers disabled incremental compilation across sessions", async () => {
  useSettingsStore.getState().setIncrementalCompilation(false);
  const saved = localStorage.getItem("codex-prism-settings")!;
  useSettingsStore.setState({ incrementalCompilation: true });
  localStorage.setItem("codex-prism-settings", saved);
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState().incrementalCompilation).toBe(false);
});
