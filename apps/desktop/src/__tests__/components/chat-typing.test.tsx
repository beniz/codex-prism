import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useAgentChatStore, persistChatTabs } from "@/stores/agent-chat-store";
import { ProposedChangesPanel } from "@/components/agent-chat/proposed-changes-panel";
import { useChatPdf, useChatPdfBuilds } from "@/hooks/use-chat-pdf";

function PdfSubscriptions() {
  useChatPdfBuilds(undefined);
  useChatPdf(undefined);
  return null;
}

it("keeps draft edits out of the PDF and proposal review render paths, while still updating proposals", async () => {
  const original = useAgentChatStore.getState();
  persistChatTabs();
  useAgentChatStore.setState({
    projectId: null,
    activeProjectPath: null,
    activeTabId: "typing",
    tabs: [
      { ...original.tabs[0], id: "typing", sessionId: "thread", draft: "" },
    ],
    proposals: [
      {
        id: "proposal",
        projectId: "p",
        threadId: "thread",
        generation: 1,
        state: "running",
        conflicts: [],
        parent: null,
        changes: [
          {
            path: "main.tex",
            kind: "modified",
            binary: false,
            oldContent: "before",
            newContent: "after",
          },
        ],
      },
    ],
  });
  const counts: Record<string, number> = {};
  const record = (id: string) => {
    counts[id] = (counts[id] ?? 0) + 1;
  };
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <>
          <Profiler id="pdf" onRender={record}>
            <PdfSubscriptions />
          </Profiler>
          <Profiler id="review" onRender={record}>
            <ProposedChangesPanel />
          </Profiler>
        </>,
      ),
    );
    const before = { ...counts };
    for (const draft of ["a", "ab", "abc"]) {
      await act(async () =>
        useAgentChatStore.setState((s) => ({
          tabs: s.tabs.map((t) => ({ ...t, draft })),
        })),
      );
    }
    expect(counts).toEqual(before);
    await act(async () =>
      useAgentChatStore.setState((s) => ({
        proposals: s.proposals.map((p) => ({
          ...p,
          state: "ready",
          generation: 2,
        })),
      })),
    );
    expect(counts.pdf).toBeGreaterThan(before.pdf);
    expect(counts.review).toBeGreaterThan(before.review);
    expect(host.textContent).toContain("Changes ready");
  } finally {
    await act(async () => root.unmount());
    useAgentChatStore.setState(original);
  }
});
