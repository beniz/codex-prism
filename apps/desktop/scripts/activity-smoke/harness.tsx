import { createRoot } from "react-dom/client";
import { AgentChatDrawer } from "../../src/components/agent-chat/agent-chat-drawer";
import { ProposedChangesPanel } from "../../src/components/agent-chat/proposed-changes-panel";
import { useAgentChatStore } from "../../src/stores/agent-chat-store";
import { useAgentSetupStore } from "../../src/stores/agent-setup-store";
import { useDocumentStore } from "../../src/stores/document-store";
import { useActivityStore } from "../../src/stores/activity-store";
import { backend, proposals, type Proposal } from "../../src/lib/backend";
import "../../src/styles/globals.css";

// Real UI and stores; all native services are deterministic in-memory fixtures.
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(20);
  }
  throw new Error(
    `Timed out: ${document.querySelector("[data-activity-tone]")?.textContent}`,
  );
}
let finishApply!: (value: any) => void;
let finishRefresh!: () => void;
let applied = 0;
let available: Proposal[] = ["a", "b"].map((id) => ({
  id: `proposal-${id}`,
  projectId: "smoke",
  chatId: id,
  threadId: `thread-${id}`,
  state: "ready",
  generation: 1,
  parent: null,
  conflicts: [],
  changes: [
    {
      path: "main.tex",
      kind: "modified",
      binary: false,
      oldContent: "Before",
      newContent: "After",
    },
  ],
}));
backend.agent.subscribe = async () => () => {};
backend.review.subscribe = async () => () => {};
backend.agent.sessions = async () => [];
backend.review.get = async () => ({ active: false, changes: [] });
proposals.list = async () => available;
proposals.operate = (async () => {
  applied++;
  const result = await new Promise((resolve) => {
    finishApply = resolve;
  });
  available = available.filter((p) => p.id !== "proposal-a");
  return result;
}) as typeof proposals.operate;
const template = useAgentChatStore.getState().tabs[0];
useAgentChatStore.setState({
  projectId: "smoke",
  activeProjectPath: "/synthetic",
  activeTabId: "a",
  proposals: available,
  tabs: ["a", "b"].map((id) => ({
    ...template,
    id,
    title: `Chat ${id.toUpperCase()}`,
    sessionId: `thread-${id}`,
    projectPath: "/synthetic",
    messages: [],
    draft: "",
    isStreaming: false,
    error: null,
  })),
});
useDocumentStore.setState({
  projectRoot: "/synthetic",
  projectId: "smoke",
  files: [],
  activeFileId: null,
  refreshFiles: async () => {},
});
useAgentSetupStore.setState({ status: "ready", checkStatus: async () => {} });
createRoot(document.getElementById("root")!).render(
  <main
    style={{
      height: "100vh",
      maxWidth: 760,
      margin: "auto",
      display: "flex",
      flexDirection: "column",
    }}
  >
    <ProposedChangesPanel />
    <AgentChatDrawer fillHeight />
  </main>,
);
const status = () =>
  document.querySelector<HTMLElement>("[data-activity-tone]")!;
const keep = () =>
  document.querySelector<HTMLButtonElement>(
    'button[title="Keep all changes from this chat"]',
  )!;
(window as any).runSmoke = async () => {
  await until(() => !!status() && !!keep());
  const event = useAgentChatStore.getState().handleEvent;
  event({
    method: "turn/started",
    params: { threadId: "thread-b", turn: { id: "turn-b" } },
  });
  event({
    method: "item/started",
    params: {
      threadId: "thread-b",
      turnId: "turn-b",
      item: {
        id: "command",
        type: "commandExecution",
        command: "read report",
        status: "inProgress",
      },
    },
  });
  await until(() => status().textContent!.includes("Running a command"));
  if (!status().textContent!.includes("Chat B"))
    throw new Error("Background owner missing");
  event({
    method: "item/completed",
    params: {
      threadId: "thread-b",
      turnId: "turn-b",
      item: {
        id: "command",
        type: "commandExecution",
        command: "read report",
        status: "completed",
        exitCode: 0,
      },
    },
  });
  event({
    method: "turn/completed",
    params: {
      threadId: "thread-b",
      turn: { id: "turn-b", status: "completed" },
    },
  });
  await until(() => useActivityStore.getState().operations.length === 0);
  useDocumentStore.setState({
    refreshFiles: () =>
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
  });
  keep().click();
  await until(() => status().textContent!.includes("Applying changes"));
  if (!keep().disabled || keep().textContent !== "…")
    throw new Error("Keep was not busy");
  const tab = [
    ...document.querySelectorAll<HTMLButtonElement>("nav button"),
  ].find((b) => b.textContent!.startsWith("Chat B"))!;
  tab.click();
  await until(() => status().textContent!.includes("Chat A"));
  if (keep().disabled || keep().textContent !== "Keep")
    throw new Error("Busy flag leaked to Chat B");
  finishApply({ conflicts: [], reusedBuilds: [] });
  await until(
    () =>
      !!finishRefresh && status().textContent!.includes("Refreshing document"),
  );
  finishRefresh();
  await until(() => useActivityStore.getState().operations.length === 0);
  await until(() => status().textContent === "Changes ready to review");
  if (applied !== 1) throw new Error("Unexpected acceptance calls");
  let activityUpdates = 0;
  const unsubscribe = useActivityStore.subscribe(() => activityUpdates++);
  const field = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message Codex"]',
  )!;
  field.focus();
  for (let i = 0; i < 50; i++) {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, `Typing ${i}`);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await pause(100);
  unsubscribe();
  if (activityUpdates !== 0) throw new Error("Typing published activity");
  if (document.activeElement !== field) throw new Error("Activity stole focus");
  const rect = status().getBoundingClientRect();
  if (rect.width < 180 || rect.height < 10)
    throw new Error("Activity line has insufficient room");
  // Leave a representative acceptance status visible for screenshot inspection.
  available = [
    available[0],
    { ...available[0], id: "proposal-a", chatId: "a", threadId: "thread-a" },
  ];
  useAgentChatStore.setState({ proposals: available, activeTabId: "a" });
  void useAgentChatStore.getState().decideProposal("apply");
  useAgentChatStore.getState().setActiveTab("b");
  await until(
    () =>
      status().textContent!.includes("Applying changes") &&
      status().textContent!.includes("Chat A"),
  );
  document.querySelector<HTMLElement>("main")!.style.maxWidth = "380px";
  await pause(100);
  const narrowRect = status().getBoundingClientRect();
  const narrowWidth = narrowRect.width;
  if (narrowRect.top < 0 || narrowRect.bottom > window.innerHeight)
    throw new Error("Activity line is outside the viewport");
  if (narrowWidth < 180)
    throw new Error("Narrow activity line is clipped by controls");
  return {
    ok: true,
    narrowWidth,
    ownerPreserved: true,
    otherKeepEnabled: true,
    typedInputs: 50,
    activityUpdates,
    focusPreserved: true,
    status: status().textContent,
    width: rect.width,
  };
};
