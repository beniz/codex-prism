import { expect, it } from "vitest";
import { repairPromptSummary } from "@/lib/repair-prompt";

const legacy =
  "Repair the proposal against the refreshed main document in this workspace. Cleanly merged changes are already present. Exact original base and intended result files, including binary assets, are available at .codexprism/repair-intent/before and .codexprism/repair-intent/after. Preserve other accepted work. Resolve these conflicts and intended changes, then leave the result for review; do not apply it. Diagnostics: ";
const prompt =
  legacy +
  JSON.stringify({
    conflicts: ["Makefile"],
    deletedFiles: [],
    intendedChanges: {
      "photo.jpg": "\u0000�".repeat(10000),
      "slides.tex": "source body",
    },
  });

it("summarizes a saved repair request with or without editor context", () => {
  expect(repairPromptSummary(prompt)).toBe(
    "Repair proposal conflicts in Makefile.",
  );
  expect(repairPromptSummary(`[Open file: slides.tex]\n\n${prompt}`)).toBe(
    "Repair proposal conflicts in Makefile.",
  );
});

it("preserves user text, including quoted or malformed diagnostics", () => {
  for (const text of [
    "Diagnostics: {}",
    `Explain this message:\n${prompt}`,
    legacy + "{}",
    legacy + "{",
  ])
    expect(repairPromptSummary(text)).toBe(text);
});
