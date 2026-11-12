import { createRoot } from "react-dom/client";
import { AgentChatDrawer } from "../../src/components/agent-chat/agent-chat-drawer";
import { backend } from "../../src/lib/backend";
import { useAgentChatStore } from "../../src/stores/agent-chat-store";
import { useAgentSetupStore } from "../../src/stores/agent-setup-store";
import "../../src/styles/globals.css";

// UI-only fixtures: never connect to an actual agent or writing project.
backend.agent.subscribe = async () => () => {};
backend.review.subscribe = async () => () => {};
useAgentSetupStore.setState({ status: "ready", checkStatus: async () => {} });
const initial = useAgentChatStore.getState().tabs[0];
const request = {
  id: 901,
  method: "item/tool/requestUserInput",
  params: {
    threadId: "plan-a",
    questions: [
      {
        id: "scope",
        question: "How should we revise the presentation?",
        options: [
          {
            label: "Focus on the results",
            description:
              "Keep the introduction brief and give the findings more room.",
          },
          {
            label: "Cover the full paper",
            description: "Balance background, methods, and findings.",
          },
        ],
      },
    ],
  },
};
let submitted: unknown;
useAgentChatStore.setState({
  projectId: null,
  activeTabId: "a",
  requests: [request],
  tabs: ["a", "b"].map((id) => ({
    ...initial,
    id,
    title: id === "a" ? "Presentation plan" : "Other chat",
    sessionId: `plan-${id}`,
    mode: "plan",
    isStreaming: id === "a",
    draft: `Draft ${id}`,
    messages: [
      {
        id: `message-${id}`,
        type: "agentMessage",
        phase: "commentary",
        text: "I’ll use the paper’s structure as a starting point. One choice will help me shape the plan.",
      },
    ],
  })),
  respond: async (event, result) => {
    if (event !== request) throw new Error("Wrong request owner");
    submitted = result;
    useAgentChatStore.setState({ requests: [] });
  },
});
if (location.search.includes("dark"))
  document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")!).render(
  <div className="flex h-screen flex-col bg-background text-foreground">
    <AgentChatDrawer fillHeight />
  </div>,
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
(window as any).runSmoke = async () => {
  for (let i = 0; i < 100 && !document.querySelector("form"); i++) await tick();
  const mode = document.querySelector('[data-chat-mode="plan"]')!;
  if (
    getComputedStyle(mode).color === getComputedStyle(mode.parentElement!).color
  )
    throw new Error("Plan indicator lacks colour");
  const form = document.querySelector<HTMLFormElement>("form")!;
  if (!form.closest("[data-chat-composer]"))
    throw new Error("Questions outside composer");
  const draft = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message Codex"]',
  )!;
  if (draft.getClientRects().length)
    throw new Error("Normal composer overlaps questions");
  const submit = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  if (!submit.disabled) throw new Error("Answer was preselected");
  const choice = form.querySelector<HTMLInputElement>('input[type="radio"]')!;
  const before = getComputedStyle(choice.closest("label")!).backgroundColor;
  choice.click();
  await tick();
  if (
    !choice.checked ||
    getComputedStyle(choice.closest("label")!).backgroundColor === before
  )
    throw new Error("Selection lacks a coloured highlight");
  if (submitted) throw new Error("Selection submitted without confirmation");
  useAgentChatStore.setState({ activeTabId: "b" });
  await tick();
  if (
    form.getClientRects().length ||
    !draft.getClientRects().length ||
    draft.value !== "Draft b"
  )
    throw new Error("Question leaked into another chat");
  useAgentChatStore.setState({ activeTabId: "a" });
  await tick();
  if (!choice.checked) throw new Error("Switching chats lost answer");
  submit.click();
  await tick();
  if (
    JSON.stringify(submitted) !==
    JSON.stringify({
      answers: { scope: { answers: ["Focus on the results"] } },
    })
  )
    throw new Error("Incorrect answer payload");
  if (!draft.getClientRects().length || draft.value !== "Draft a")
    throw new Error("Draft lost after answering");
  useAgentChatStore.setState({ requests: [request] });
  await tick();
  document.querySelector<HTMLInputElement>('form input[type="radio"]')!.click();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    ok: true,
    steps:
      "coloured Plan → composer questions → explicit selection → chat isolation → submit → draft restored",
  };
};
