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
    expect(saved.state).toEqual({ autoRecompile: true, vimMode: true });
  });
}
