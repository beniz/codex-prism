import { Profiler, act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ActivityLine } from "@/components/agent-chat/activity-line";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useAgentSetupStore } from "@/stores/agent-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { beginActivity, resetActivities } from "@/stores/activity-store";
const original = useAgentChatStore.getState();
const doc = useDocumentStore.getState();
const setup = useAgentSetupStore.getState();
const connect = vi.fn();
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  resetActivities();
  const tab = {
    ...original.tabs[0],
    id: "a",
    title: "Chat A",
    sessionId: "thread-a",
    isStreaming: false,
    error: null,
    messages: [],
    draft: "",
  };
  useAgentChatStore.setState({
    ...original,
    activeProjectPath: "/paper",
    projectId: "project",
    activeTabId: "a",
    tabs: [tab, { ...tab, id: "b", title: "Chat B", sessionId: "thread-b" }],
    requests: [],
    error: null,
    restoringChats: false,
    proposals: [],
    review: { active: false, changes: [] },
  });
  useDocumentStore.setState({
    projectRoot: "/paper",
    projectId: "project",
    isCompiling: false,
    isSaving: false,
    compileError: null,
  });
  useAgentSetupStore.setState({ status: "ready" });
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetActivities();
  useAgentChatStore.setState(original);
  useDocumentStore.setState(doc);
  useAgentSetupStore.setState(setup);
});
it("reports the originating chat across tab switches and returns to idle without a timer", async () => {
  await act(async () =>
    root.render(<ActivityLine attaching={false} onConnect={connect} />),
  );
  let operation!: ReturnType<typeof beginActivity>;
  await act(async () => {
    operation = beginActivity(
      { projectPath: "/paper", chatId: "a", proposalId: "p-a" },
      "apply",
      { projectWide: true },
    );
  });
  expect(host.textContent).toBe("Applying changes…");
  await act(async () => useAgentChatStore.getState().setActiveTab("b"));
  expect(host.textContent).toBe("Applying changes… · Chat A");
  await act(async () => operation.update("updatingPdf"));
  expect(host.textContent).toBe("Updating PDF… · Chat A");
  await act(async () => operation.finish());
  expect(host.textContent).toBe("Project context included");
});
it("does not rerender on draft or transcript changes", async () => {
  const rendered = vi.fn();
  await act(async () =>
    root.render(
      <Profiler id="activity" onRender={rendered}>
        <ActivityLine attaching={false} onConnect={connect} />
      </Profiler>,
    ),
  );
  const before = rendered.mock.calls.length;
  await act(async () => {
    for (let i = 0; i < 100; i++)
      useAgentChatStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({
          ...t,
          draft: `typing ${i}`,
          messages: [
            { id: "output", type: "agentMessage", text: `token ${i}` },
          ],
        })),
      }));
  });
  expect(rendered).toHaveBeenCalledTimes(before);
});
it("prioritizes active-chat questions and errors and shows review readiness", async () => {
  beginActivity({ projectPath: "/paper", chatId: "b" }, "apply", {
    projectWide: true,
  });
  await act(async () =>
    root.render(<ActivityLine attaching={false} onConnect={connect} />),
  );
  await act(async () =>
    useAgentChatStore.setState({
      requests: [
        {
          id: 1,
          method: "item/tool/requestUserInput",
          params: { threadId: "thread-a" },
        },
      ],
    }),
  );
  expect(host.textContent).toContain("Waiting for your answer");
  expect(host.querySelector('[data-activity-tone="waiting"]')).not.toBeNull();
  await act(async () => useAgentChatStore.setState({ error: "Disconnected" }));
  expect(host.textContent).toContain("Action failed");
  expect(host.querySelector('[role="status"]')!.getAttribute("title")).toBe(
    "Disconnected",
  );
  await act(async () => {
    resetActivities();
    useAgentChatStore.setState({
      requests: [],
      error: null,
      proposals: [
        {
          id: "p",
          projectId: "project",
          chatId: "a",
          state: "ready",
          generation: 1,
          conflicts: [],
          changes: [{ path: "main.tex" }],
        },
      ] as any,
    });
  });
  expect(host.textContent).toBe("Changes ready to review");
  await act(async () =>
    useAgentChatStore.setState((s) => ({
      proposals: s.proposals.map((p) => ({ ...p, state: "conflicts" })),
    })),
  );
  expect(host.textContent).toBe("Conflicts need attention");
});
it("shows restored running chats, background counts and connection guidance without history scans", async () => {
  await act(async () =>
    useAgentChatStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, isStreaming: true })),
    })),
  );
  await act(async () =>
    root.render(<ActivityLine attaching={false} onConnect={connect} />),
  );
  expect(host.textContent).toBe("Codex is working… · 1 other chat active");
  await act(async () => {
    useAgentChatStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, isStreaming: false })),
    }));
    useAgentSetupStore.setState({ status: "error" });
  });
  expect(host.textContent).toBe("Connect Codex to start chatting");
  await act(async () => host.querySelector("button")!.click());
  expect(connect).toHaveBeenCalled();
});
it("reports main PDF preparation and failure without creating build requests", async () => {
  await act(async () =>
    root.render(<ActivityLine attaching={false} onConnect={connect} />),
  );
  await act(async () => useDocumentStore.setState({ isCompiling: true }));
  expect(host.textContent).toBe("Preparing PDF…");
  await act(async () =>
    useDocumentStore.setState({
      isCompiling: false,
      compileError: "Missing figure",
    }),
  );
  expect(host.textContent).toContain("PDF preparation failed");
  expect(host.querySelector('[role="status"]')!.getAttribute("title")).toBe(
    "Missing figure",
  );
  await act(async () => {
    beginActivity({ projectPath: "/paper", chatId: "b" }, "preparingPdf", {
      group: "build",
    });
  });
  expect(host.textContent).toContain("PDF preparation failed");
});
