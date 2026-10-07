import type { ChatItem } from "@/stores/agent-chat-store";

/** Extract only public HTTP links, including structured and text tool results. */
function collectUrls(value: unknown, urls = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    // Structured URL fields can legitimately contain parentheses and commas.
    if (/^https?:\/\/\S+$/.test(value)) {
      try {
        new URL(value);
        urls.add(value);
        return urls;
      } catch {
        /* Fall through to text extraction. */
      }
    }
    for (const match of value.matchAll(/https?:\/\/[^\s<>"'\]\)]+/g)) {
      const url = match[0].replace(/[.,;]+$/, "");
      try {
        if (["https:", "http:"].includes(new URL(url).protocol)) urls.add(url);
      } catch {
        /* Not a URL. */
      }
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) collectUrls(entry, urls);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectUrls(entry, urls);
  }
  return urls;
}

export function summarizeActivity(item: ChatItem): {
  summary: string;
  urls: string[];
} {
  const data = item.activity ?? {};
  let summary: string;
  let urls: string[] = [];
  switch (item.type) {
    case "webSearch": {
      const action = data.action ?? {};
      const queries = action.queries?.length
        ? action.queries
        : [action.query || data.query].filter(Boolean);
      if (["openPage", "open_page"].includes(action.type))
        summary = "Visited page";
      else if (["findInPage", "find_in_page"].includes(action.type))
        summary = `Find in page: ${action.pattern ?? ""}`;
      else
        summary = queries.length
          ? `Search: ${queries.join("; ")}`
          : "Web search";
      urls = [...collectUrls([action.url, data.results])];
      break;
    }
    case "commandExecution":
      summary = `Command: ${data.command ?? item.text.split("\n")[0]}`;
      if (data.exitCode != null && data.exitCode !== 0)
        summary += ` (exit ${data.exitCode})`;
      break;
    case "fileChange":
      summary = `File changes: ${
        (data.changes ?? [])
          .map((change: any) => change.path)
          .filter(Boolean)
          .join(", ") || "updated project files"
      }`;
      break;
    case "mcpToolCall":
    case "dynamicToolCall":
    case "functionCallOutput": {
      const name = data.tool ?? data.name ?? "Tool";
      const args = data.arguments ?? {};
      const query = args.query ?? args.q ?? args.search_query;
      summary = `${name}${query ? `: ${typeof query === "string" ? query : JSON.stringify(query)}` : ""}`;
      urls = [
        ...collectUrls([args, data.result, data.output, data.contentItems]),
      ];
      if (data.error?.message) summary += `: ${data.error.message}`;
      break;
    }
    case "plan":
      summary = item.text;
      break;
    case "imageView":
      summary = `Viewed image: ${data.path ?? ""}`;
      break;
    case "contextCompaction":
      summary = "Conversation context compacted";
      break;
    default:
      summary = item.type.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
  return { summary, urls };
}
