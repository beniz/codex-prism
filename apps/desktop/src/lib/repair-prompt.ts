// Older versions sent complete changed files (including decoded image bytes)
// in this generated user message. Summarize it for display and prompt recall.
const legacyRepairPrompt =
  "Repair the proposal against the refreshed main document in this workspace. " +
  "Cleanly merged changes are already present. Exact original base and intended result files, " +
  "including binary assets, are available at .codexprism/repair-intent/before and .codexprism/repair-intent/after. " +
  "Preserve other accepted work. Resolve these conflicts and intended changes, then leave the result for review; " +
  "do not apply it. Diagnostics: ";

export function repairPromptSummary(text: string): string {
  const start = text.indexOf(legacyRepairPrompt);
  if (start < 0) return text;
  // The editor can prepend the open file when sending a repair turn.
  if (start && !/^\[Open file: [^\n]+\]\n\n$/.test(text.slice(0, start)))
    return text;
  try {
    const diagnostics = JSON.parse(
      text.slice(start + legacyRepairPrompt.length),
    );
    if (
      !Array.isArray(diagnostics?.conflicts) ||
      !diagnostics.conflicts.every((p: unknown) => typeof p === "string") ||
      !Array.isArray(diagnostics.deletedFiles) ||
      !diagnostics.intendedChanges ||
      typeof diagnostics.intendedChanges !== "object" ||
      Array.isArray(diagnostics.intendedChanges)
    )
      return text;
    const files = diagnostics.conflicts;
    const names = files.slice(0, 3).join(", ");
    return (
      "Repair proposal conflicts" +
      (names ? ` in ${names}` : "") +
      (files.length > 3 ? ` and ${files.length - 3} more` : "") +
      "."
    );
  } catch {
    return text;
  }
}
