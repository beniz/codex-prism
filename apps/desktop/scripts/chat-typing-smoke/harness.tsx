import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import { AgentChatDrawer } from "../../src/components/agent-chat/agent-chat-drawer";
import { ProposedChangesPanel } from "../../src/components/agent-chat/proposed-changes-panel";
import { useChatPdf, useChatPdfBuilds } from "../../src/hooks/use-chat-pdf";
import { backend, type Proposal } from "../../src/lib/backend";
import { useAgentChatStore } from "../../src/stores/agent-chat-store";
import { useAgentSetupStore } from "../../src/stores/agent-setup-store";
import "../../src/styles/globals.css";

// Real composer/review components and PDF subscriptions; no user files or agent.
backend.agent.subscribe = async () => () => {};
backend.review.subscribe = async () => () => {};
backend.agent.sessions = async () => [];
useAgentSetupStore.setState({ status: "ready", checkStatus: async () => {} });
const initial = useAgentChatStore.getState().tabs[0];
const proposal = {
  id: "proposal",
  projectId: "typing-fixture",
  chatId: "a",
  threadId: "thread-a",
  generation: 1,
  state: "running",
  conflicts: [],
  changes: Array.from({ length: 100 }, (_, i) => ({
    path: `sections/part-${i}.tex`,
    kind: "modified",
    oldContent: "Before",
    newContent: "After",
  })),
} as unknown as Proposal;
useAgentChatStore.setState({
  projectId: "typing-fixture",
  activeProjectPath: "/typing-smoke-fixture",
  activeTabId: "a",
  proposals: [proposal],
  tabs: ["a", "b"].map((id) => ({
    ...initial,
    id,
    title: `Chat ${id}`,
    sessionId: `thread-${id}`,
    isStreaming: true,
    draft: "",
    messages: Array.from({ length: 200 }, (_, i) => ({
      id: `${id}-${i}`,
      type: "agentMessage",
      text: `### Result ${i}\n\nA paragraph with **results** and \\(x^2\\).\n\n- First observation\n- Second observation`,
    })),
  })),
});
let observing = false;
let writes = 0;
const storageWrite = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  if (observing && key.startsWith("prism-chat-tabs")) writes++;
  return storageWrite.call(this, key, value);
};
const counts: Record<string, number> = {};
const durations: number[] = [];
function PdfSubscriptions() {
  useChatPdfBuilds(undefined);
  useChatPdf(undefined);
  return <p className="p-3">PDF workspace subscription probe</p>;
}
function profile(id: string, _phase: string, duration: number) {
  if (!observing) return;
  counts[id] = (counts[id] ?? 0) + 1;
  if (id === "composer") durations.push(duration);
}
createRoot(document.getElementById("root")!).render(
  <main className="grid h-screen grid-cols-2 bg-background text-foreground">
    <div>
      <Profiler id="pdf" onRender={profile}>
        <PdfSubscriptions />
      </Profiler>
      <Profiler id="review" onRender={profile}>
        <ProposedChangesPanel />
      </Profiler>
    </div>
    <div className="flex min-h-0 flex-col">
      <Profiler id="composer" onRender={profile}>
        <AgentChatDrawer fillHeight />
      </Profiler>
    </div>
  </main>,
);
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
(window as any).runSmoke = async () => {
  for (let i = 0; i < 100 && !document.querySelector("textarea"); i++)
    await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 400));
  const input = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message Codex"]',
  )!;
  input.focus();
  await frame();
  observing = true;
  const handlers: number[] = [];
  const untilFrame: number[] = [];
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  for (let i = 0; i < 100; i++) {
    const text = "Improve the explanation of the results. "
      .repeat(3)
      .slice(0, i + 1);
    const start = performance.now();
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    handlers.push(performance.now() - start);
    await frame();
    untilFrame.push(performance.now() - start);
    if (
      input.value !== text ||
      useAgentChatStore.getState().tabs[0].draft !== text
    )
      throw new Error("Typed text was delayed or lost");
  }
  observing = false;
  const percentile = (values: number[], p: number) =>
    [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
  const result = {
    ok: true,
    counts,
    storageWrites: writes,
    inputHandlerP95Ms: percentile(handlers, 0.95),
    nextFrameP95Ms: percentile(untilFrame, 0.95),
    composerRenderP95Ms: percentile(durations, 0.95),
    note: "Synthetic input events in real WebKit; not OS key-to-pixel latency",
  };
  if (location.search.includes("verify") && (counts.pdf || counts.review))
    throw new Error(`Typing redrew unrelated panes: ${JSON.stringify(result)}`);
  if (location.search.includes("verify") && writes >= 10)
    throw new Error(`Draft storage still runs too often: ${writes}`);
  window.dispatchEvent(new Event("pagehide"));
  if (
    JSON.parse(
      localStorage.getItem("prism-chat-tabs-v1:/typing-smoke-fixture")!,
    ).tabs[0].draft !== input.value
  )
    throw new Error("Final draft was not persisted");
  return result;
};
