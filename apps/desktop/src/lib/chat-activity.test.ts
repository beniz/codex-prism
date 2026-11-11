import { expect, it } from "vitest";
import {
  activityPresentation,
  activityState,
  commandLanguage,
} from "./chat-activity";
import type { ChatItem } from "@/stores/agent-chat-store";
const item = (changes: Partial<ChatItem>): ChatItem => ({
  id: "a",
  type: "mcpToolCall",
  text: "",
  ...changes,
});

it.each([
  ["functions.view_image", "image"],
  ["mcp__files__read_file", "read"],
  ["functions.exec_command", "command"],
  ["remote_research", "research"],
  ["webfetch", "research"],
  ["functions.apply_patch", "edit"],
  ["unknown_tool", "tool"],
])("classifies %s from structured tool names", (tool, kind) => {
  expect(
    activityPresentation(
      item({ activity: { tool, arguments: { query: "research and images" } } }),
    ).kind,
  ).toBe(kind);
});
it("does not infer activity or failure from prose, tool arguments or output", () => {
  const value = item({
    text: "ERROR image search",
    activity: {
      tool: "calculate",
      arguments: { query: "search" },
      result: "ERROR was mentioned in the paper",
    },
  });
  expect(activityPresentation(value).kind).toBe("tool");
  expect(activityState(value)).toBeNull();
});
it.each([
  [
    { status: "completed", activity: { exitCode: 2 } },
    "error",
    "Failed · exit 2",
  ],
  [
    { status: "completed", activity: { result: { isError: true } } },
    "error",
    "Failed",
  ],
  [
    { status: "completed", activity: { error: { message: "Failed request" } } },
    "error",
    "Failed",
  ],
  [{ status: "completed", activity: { success: false } }, "error", "Failed"],
  [{ status: "completed", activity: { exitCode: 0 } }, "success", "Completed"],
  [{ status: "inProgress", activity: { exitCode: 0 } }, "progress", "Running"],
  [{ status: "awaiting_approval" }, "waiting", "Awaiting approval"],
  [{ status: "waitingForInput" }, "waiting", "Waiting for input"],
  [{ status: "cancelled" }, "progress", "Cancelled"],
  [{ status: "interrupted" }, "progress", "Interrupted"],
] as const)("keeps outcome semantics for %j", (data, tone, label) => {
  expect(activityState(item(data))).toEqual({ tone, label });
});
it.each([
  ["bash -lc 'ls'", undefined, "bash"],
  ["Get-ChildItem", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
  [
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command Get-ChildItem',
    undefined,
    "powershell",
  ],
  ["powershell.exe -Command Get-ChildItem", undefined, "powershell"],
  ["cmd.exe /c dir", undefined, "dos"],
])("recognizes the command shell for %s", (command, shell, language) => {
  expect(commandLanguage(item({ activity: { command, shell } }))).toBe(
    language,
  );
});
