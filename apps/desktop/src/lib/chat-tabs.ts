export interface SavedChatTabs {
  activeTabId: string;
  selectedModel?: string;
  effortLevel?: string;
  tabs: { id: string; title: string; sessionId: string | null; draft: string; mode?: "plan" | "default" }[];
}
const key = (root: string) => `prism-chat-tabs-v1:${root}`;

export function readChatTabs(root: string): SavedChatTabs | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key(root)) ?? "null");
    if (!saved || typeof saved.activeTabId !== "string" ||
      !Array.isArray(saved.tabs) || !saved.tabs.length ||
      !saved.tabs.every((t: SavedChatTabs["tabs"][number]) =>
        t && typeof t.id === "string" && typeof t.title === "string" &&
        (t.sessionId === null || typeof t.sessionId === "string") &&
        typeof t.draft === "string")) return null;
    return {
      ...saved,
      selectedModel: typeof saved.selectedModel === "string" ? saved.selectedModel : undefined,
      effortLevel: typeof saved.effortLevel === "string" ? saved.effortLevel : undefined,
    };
  } catch {
    return null;
  }
}

export function writeChatTabs(root: string, saved: SavedChatTabs): void {
  const value = JSON.stringify(saved);
  if (localStorage.getItem(key(root)) !== value)
    localStorage.setItem(key(root), value);
}
