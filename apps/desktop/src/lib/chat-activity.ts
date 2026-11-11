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

export type ActivityKind =
  | "command"
  | "read"
  | "image"
  | "research"
  | "edit"
  | "plan"
  | "progress"
  | "context"
  | "tool"
  | "approval"
  | "error";
export interface ActivityState {
  tone: "progress" | "success" | "waiting" | "error";
  label: string;
}

/** Classify structured activity metadata, never words in the agent's prose or output. */
export function activityPresentation(item: ChatItem) {
  const data = item.activity ?? {};
  const activity = summarizeActivity(item);
  let kind: ActivityKind = "tool";
  let label = "Tool";
  switch (item.type) {
    case "commandExecution":
      kind = "command";
      label = "Command";
      break;
    case "imageView":
      kind = "image";
      label = "Viewed image";
      break;
    case "fileRead":
      kind = "read";
      label = "Read file";
      break;
    case "fileChange":
      kind = "edit";
      label = "File changes";
      break;
    case "webSearch":
      kind = "research";
      label = ["openPage", "open_page"].includes(data.action?.type)
        ? "Visited page"
        : ["findInPage", "find_in_page"].includes(data.action?.type)
          ? "Find in page"
          : activity.summary.startsWith("Search:")
            ? "Search"
            : "Web search";
      break;
    case "plan":
      kind = "plan";
      label = "Plan";
      break;
    case "contextCompaction":
      kind = "context";
      label = "Context";
      break;
    case "error":
      kind = "error";
      label = "Error";
      break;
    case "mcpToolCall":
    case "dynamicToolCall":
    case "functionCallOutput": {
      label = String(data.tool ?? data.name ?? "Tool");
      const name =
        label
          .toLowerCase()
          .split(/__|[./:]/)
          .pop() ?? "";
      if (/^(view|read|open)_image$/.test(name)) kind = "image";
      else if (/^(exec|execute|shell|terminal|run_command)(_|$)/.test(name))
        kind = "command";
      else if (
        /(^|_)(web|search|research|fetch|browse)(_|$)/.test(
          label.toLowerCase(),
        ) ||
        name === "webfetch"
      )
        kind = "research";
      else if (/^(read|open|list|stat|glob)(_|$)/.test(name)) kind = "read";
      else if (/^(write|edit|apply_patch|replace|create_file)(_|$)/.test(name))
        kind = "edit";
      break;
    }
  }
  const detail =
    item.type === "fileRead"
      ? String(data.path ?? item.text)
      : item.type === "error"
        ? item.text
        : activity.summary === label
          ? ""
          : activity.summary.startsWith(`${label}: `)
            ? activity.summary.slice(label.length + 2)
            : activity.summary;
  return { kind, label, detail, urls: activity.urls };
}

/** A completed transport item may still contain a failed command or tool result. */
export function activityState(item: ChatItem): ActivityState | null {
  const data = item.activity ?? {};
  const status = String(item.status ?? data.status ?? "");
  const normalized = status.replace(/[_\s-]/g, "").toLowerCase();
  const failedExit = typeof data.exitCode === "number" && data.exitCode !== 0;
  if (
    item.type === "error" ||
    failedExit ||
    data.error ||
    data.result?.isError === true ||
    data.success === false ||
    ["failed", "error", "errored"].includes(normalized)
  ) {
    return {
      tone: "error",
      label: failedExit ? `Failed · exit ${data.exitCode}` : "Failed",
    };
  }
  if (
    ["awaitingapproval", "pendingapproval", "waitingforapproval"].includes(
      normalized,
    )
  )
    return { tone: "waiting", label: "Awaiting approval" };
  if (["waiting", "waitingforinput", "awaitinginput"].includes(normalized))
    return { tone: "waiting", label: "Waiting for input" };
  if (
    ["completed", "succeeded", "success"].includes(normalized) ||
    (!status && data.exitCode === 0)
  )
    return { tone: "success", label: "Completed" };
  if (["inprogress", "running", "started"].includes(normalized))
    return { tone: "progress", label: "Running" };
  if (["pending", "queued"].includes(normalized))
    return { tone: "progress", label: "Queued" };
  if (["cancelled", "canceled", "interrupted"].includes(normalized))
    return {
      tone: "progress",
      label: normalized === "interrupted" ? "Interrupted" : "Cancelled",
    };
  return status ? { tone: "progress", label: status } : null;
}

export function commandLanguage(item: ChatItem) {
  const command = String(item.activity?.command ?? item.text);
  const firstWord =
    command
      .trim()
      .match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
      ?.slice(1)
      .find(Boolean) ?? "";
  const shell = String(item.activity?.shell ?? firstWord)
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase();
  if (
    ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(shell ?? "")
  )
    return "powershell";
  if (["cmd", "cmd.exe"].includes(shell ?? "")) return "dos";
  return "bash";
}
