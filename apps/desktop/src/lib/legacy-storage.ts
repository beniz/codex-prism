/** Preserve existing preferences when adopting the codex-prism storage namespace. */
export function migrateStorageKey(key: string): string {
  try {
    const legacy = key.replace(/^codex-prism-/, "claude-prism-");
    if (localStorage.getItem(key) === null) {
      const value = localStorage.getItem(legacy);
      if (value !== null) localStorage.setItem(key, value);
    }
    // Remove only after the new value exists, so resets cannot resurrect old data.
    if (localStorage.getItem(key) !== null) localStorage.removeItem(legacy);
  } catch {
    /* Storage can be unavailable during startup or tests. */
  }
  return key;
}
