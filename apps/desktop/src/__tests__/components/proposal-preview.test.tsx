import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  useChatPdf,
  useProposalPdfError,
  useChatPdfBuilds,
  clearChatPdfCache,
  safeChatSource,
  chatHeadingLocation,
  type ChatPdfArtifact,
} from "@/hooks/use-chat-pdf";
import { proposals, type Proposal } from "@/lib/backend";
const { documentState, chatState } = vi.hoisted(() => ({
  documentState: {
    projectId: "project",
    mainPdfByte: 9,
    files: [{ id: "main", relativePath: "main.tex", content: "unchanged" }],
  },
  chatState: {
    activeTabId: "a",
    tabs: [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ],
    proposals: [] as any[],
  },
}));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: Object.assign((selector: any) => selector(documentState), {
    getState: () => documentState,
  }),
}));
vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: Object.assign((selector: any) => selector(chatState), {
    getState: () => chatState,
  }),
  activeProposal: () =>
    chatState.proposals.find((p) => p.id === chatState.activeTabId),
}));
vi.mock("@/lib/backend", () => ({ proposals: { operate: vi.fn(), loadBuild: vi.fn() } }));
const proposal: Proposal = {
  id: "a",
  projectId: "project",
  threadId: "thread",
  generation: 1,
  state: "ready",
  conflicts: [],
  parent: null,
  changes: [{ path: "main.tex", oldContent: "before", newContent: "after", kind: "modified", binary: false }],
};
const build = (byte: number) => ({
  bytes: [byte],
  artifactId: `pdf-${byte}`,
  locations: [],
});
function deferred() {
  let resolve!: (value: ReturnType<typeof build>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof build>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: Root;
let host: HTMLDivElement;
let current: ReturnType<typeof useChatPdf>;
let mainFile = "main.tex";
function Viewer() {
  useChatPdfBuilds(mainFile);
  current = useChatPdf(mainFile);
  return (
    <div>
      {current.label}:{current.artifact?.bytes[0] ?? documentState.mainPdfByte}:{current.error}
    </div>
  );
}
async function render() {
  await act(async () => root.render(<Viewer />));
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  mainFile = "main.tex";
  vi.mocked(proposals.loadBuild).mockResolvedValue(null);
  clearChatPdfCache();
  documentState.projectId = "project";
  documentState.mainPdfByte = 9;
  documentState.files[0].content = "unchanged";
  chatState.activeTabId = "a";
  chatState.proposals = [{ ...proposal }];
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it.each([
  "running",
  "repairing",
])("keeps the main fallback without building during %s", async (state) => {
  chatState.proposals[0].state = state;
  await render();
  expect(host.textContent).toBe("Main document:9:");
  expect(proposals.operate).not.toHaveBeenCalled();
});
it("retains its PDF through a follow-up turn and failed completion build", async () => {
  vi.mocked(proposals.operate).mockResolvedValueOnce(build(1));
  await render();
  expect(host.textContent).toBe("A:1:");
  chatState.proposals[0] = { ...proposal, generation: 2, state: "running" };
  await render();
  expect(proposals.operate).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe("A:1:");
  vi.mocked(proposals.operate).mockRejectedValueOnce(
    new Error("Compilation failed"),
  );
  chatState.proposals[0] = { ...proposal, generation: 2 };
  await render();
  expect(host.textContent).toContain("A:1:Error: Compilation failed");
});
it("caches independent PDFs and ignores late completion for the displayed chat", async () => {
  const a = deferred();
  const b = deferred();
  chatState.proposals.push({ ...proposal, id: "b", threadId: "thread-b" });
  vi.mocked(proposals.operate)
    .mockReturnValueOnce(a.promise)
    .mockReturnValueOnce(b.promise);
  await render();
  chatState.activeTabId = "b";
  await render();
  await act(async () => a.resolve(build(1)));
  expect(host.textContent).toBe("Main document:9:");
  await act(async () => b.resolve(build(2)));
  expect(host.textContent).toBe("B:2:");
  chatState.activeTabId = "a";
  await render();
  expect(host.textContent).toBe("A:1:");
  expect(proposals.operate).toHaveBeenCalledTimes(2);
});
it("drops obsolete build results and builds the completed generation", async () => {
  const old = deferred();
  vi.mocked(proposals.operate)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(build(2));
  await render();
  chatState.proposals[0] = { ...proposal, generation: 2 };
  await render();
  await act(async () => old.resolve(build(1)));
  expect(host.textContent).toBe("A:2:");
});
it("returns to main after resolution without changing another chat's cache", async () => {
  vi.mocked(proposals.operate).mockResolvedValue(build(1));
  await render();
  chatState.proposals = [];
  await render();
  expect(host.textContent).toBe("Main document:9:");
});
it("shows the latest main PDF in both chats after their proposals resolve", async () => {
  chatState.proposals.push({ ...proposal, id: "b", threadId: "thread-b" });
  vi.mocked(proposals.operate)
    .mockResolvedValueOnce(build(1))
    .mockResolvedValueOnce(build(2));
  await render();
  expect(host.textContent).toBe("A:1:");
  chatState.activeTabId = "b";
  await render();
  expect(host.textContent).toBe("B:2:");

  // Keep A; B must retain its pending proposal until it too is resolved.
  chatState.proposals = [chatState.proposals[1]];
  documentState.mainPdfByte = 3;
  await render();
  expect(host.textContent).toBe("B:2:");
  chatState.activeTabId = "a";
  await render();
  expect(host.textContent).toBe("Main document:3:");

  chatState.proposals = [];
  documentState.mainPdfByte = 4;
  for (const chat of ["b", "a", "b"]) {
    chatState.activeTabId = chat;
    await render();
    expect(host.textContent).toBe("Main document:4:");
    expect(current.artifact).toBeUndefined();
  }
  expect(proposals.operate).toHaveBeenCalledTimes(2);
});
it("does not reuse output across projects", async () => {
  vi.mocked(proposals.operate).mockResolvedValue(build(1));
  await render();
  documentState.projectId = "other";
  await render();
  expect(host.textContent).toBe("Main document:9:");
});
it("navigates only when captured source exactly matches main source", async () => {
  const artifact: ChatPdfArtifact = {
    proposal,
    main: "main.tex",
    build: build(1),
    bytes: new Uint8Array([1]),
  };
  const box = { file: "main.tex", line: 1, page: 1, x: 0, y: 0, w: 1, h: 1 };
  vi.mocked(proposals.operate).mockResolvedValue({
    bytes: [...new TextEncoder().encode("unchanged")],
  });
  expect(await safeChatSource(artifact, box)).toEqual({
    file: "main.tex",
    line: 1,
    column: 0,
  });
  documentState.files[0].content = "accepted changes";
  expect(await safeChatSource(artifact, box)).toBeNull();
});

it("retains a chat PDF when the preview is hidden and reopened during a turn", async () => {
  vi.mocked(proposals.operate).mockResolvedValueOnce(build(1));
  await render();
  await act(async () => root.unmount());
  root = createRoot(host);
  chatState.proposals[0] = { ...proposal, generation: 2, state: "running" };
  await render();
  expect(host.textContent).toBe("A:1:");
  expect(proposals.operate).toHaveBeenCalledTimes(1);
});

it("retains the chat PDF while a repair candidate runs", async () => {
  vi.mocked(proposals.operate).mockResolvedValueOnce(build(1));
  await render();
  chatState.proposals = [
    { ...proposal, state: "original" },
    { ...proposal, id: "repair", state: "repairing", parent: "a" },
  ];
  chatState.activeTabId = "repair";
  await render();
  expect(current.artifact?.bytes[0]).toBe(1);
  expect(current.current).toBe(false);
  expect(proposals.operate).toHaveBeenCalledTimes(1);
  vi.mocked(proposals.operate).mockResolvedValueOnce(build(2));
  chatState.proposals[1] = {
    ...chatState.proposals[1],
    state: "ready",
    generation: 2,
  };
  await render();
  expect(current.artifact?.bytes[0]).toBe(2);
  expect(current.current).toBe(true);
});

it("maps an unchanged heading in edited proposal source and supports repeated jumps", async () => {
  const source = "% inserted\n\\section{Results}\nchanged body";
  vi.mocked(proposals.operate).mockResolvedValue({
    bytes: [...new TextEncoder().encode(source)],
  });
  const box = { file: "main.tex", line: 1, page: 3, x: 0, y: 10, w: 1, h: 1 };
  const artifact: ChatPdfArtifact = {
    proposal, main: "main.tex", bytes: new Uint8Array([1]),
    build: { ...build(1), locations: [box] },
  };
  const request = { filePath: "main.tex", line: 1, sourceLine: "\\section{Results}" };
  expect(await chatHeadingLocation(artifact, request)).toEqual(box);
  expect(await chatHeadingLocation(artifact, request)).not.toBe(box);
  expect(await chatHeadingLocation(artifact, { ...request, sourceLine: "\\section{Missing}" })).toBeNull();
  vi.mocked(proposals.operate).mockResolvedValue({
    bytes: [...new TextEncoder().encode(source + "\n\\section{Results}")],
  });
  expect(await chatHeadingLocation(artifact, request)).toBeNull();
});

it("builds an inactive completed chat while the PDF pane is closed", async () => {
  function Background() { useChatPdfBuilds("main.tex"); return null; }
  chatState.proposals = [{ ...proposal, state: "running" }, { ...proposal, id: "b", threadId: "b" }];
  const pending = deferred();
  vi.mocked(proposals.operate).mockReturnValue(pending.promise);
  await act(async () => root.render(<Background />));
  expect(proposals.operate).toHaveBeenCalledTimes(1);
  expect(vi.mocked(proposals.operate).mock.calls[0][0].id).toBe("b");
  await act(async () => pending.resolve(build(2)));
  chatState.activeTabId = "b";
  await render();
  expect(host.textContent).toBe("B:2:");
  expect(proposals.operate).toHaveBeenCalledTimes(1);
});

it("loads a persisted PDF without compiling even when incremental compilation is disabled", async () => {
  const { useSettingsStore } = await import("@/stores/settings-store");
  useSettingsStore.setState({ incrementalCompilation: false });
  vi.mocked(proposals.loadBuild).mockResolvedValue(build(7));
  await render();
  expect(host.textContent).toBe("A:7:");
  expect(proposals.operate).not.toHaveBeenCalled();
  vi.mocked(proposals.operate).mockResolvedValue(build(8));
  await act(async () => current.compile());
  expect(proposals.operate).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "compile",
    expect.objectContaining({ incremental: false }));
  useSettingsStore.setState({ incrementalCompilation: true });
});

it("reports a background failure without retries on tab switches and permits explicit retry", async () => {
  chatState.proposals.push({ ...proposal, id: "b", threadId: "b" });
  vi.mocked(proposals.operate).mockImplementation(async (p) => {
    if (p.id === "b") throw new Error("Broken B");
    return build(1) as any;
  });
  await render();
  for (const tab of ["b", "a", "b"]) { chatState.activeTabId = tab; await render(); }
  expect(host.textContent).toContain("Broken B");
  expect(proposals.operate).toHaveBeenCalledTimes(2);
  vi.mocked(proposals.operate).mockResolvedValue(build(2));
  await act(async () => current.compile());
  expect(host.textContent).toBe("B:2:");
  expect(proposals.operate).toHaveBeenCalledTimes(3);
});

it("ignores an old request after the project cache is reset", async () => {
  const old = deferred();
  vi.mocked(proposals.loadBuild).mockReturnValueOnce(old.promise);
  await render();
  vi.mocked(proposals.operate).mockResolvedValue(build(2));
  await act(async () => { clearChatPdfCache(); });
  await act(async () => old.resolve(build(1)));
  expect(current.artifact?.bytes[0]).toBe(2);
});

it("reloads an evicted PDF from disk without rebuilding completed chats", async () => {
  chatState.proposals = Array.from({ length: 12 }, (_, i) => ({ ...proposal, id: i ? `p${i}` : "a" }));
  vi.mocked(proposals.operate).mockResolvedValue(build(1));
  await render();
  expect(proposals.operate).toHaveBeenCalledTimes(12);
  vi.mocked(proposals.loadBuild).mockResolvedValue(build(8));
  chatState.activeTabId = "p1";
  await render();
  expect(current.artifact?.bytes[0]).toBe(8);
  expect(proposals.operate).toHaveBeenCalledTimes(12);
});

it("does not build empty planning proposals and does not compile after a stale cache miss", async () => {
  chatState.proposals = [{ ...proposal, changes: [] }];
  await render();
  expect(proposals.loadBuild).not.toHaveBeenCalled();
  const pending = deferred();
  vi.mocked(proposals.loadBuild).mockReturnValue(pending.promise);
  chatState.proposals = [{ ...proposal }];
  await render();
  chatState.proposals = [];
  await act(async () => pending.resolve(null as any));
  expect(proposals.operate).not.toHaveBeenCalled();
});

it("keeps separate cached PDFs for different TeX roots", async () => {
  vi.mocked(proposals.operate).mockResolvedValueOnce(build(1)).mockResolvedValueOnce(build(2));
  await render();
  mainFile = "slides.tex";
  await render();
  expect(current.artifact?.main).toBe("slides.tex");
  expect(current.artifact?.bytes[0]).toBe(2);
  mainFile = "main.tex";
  await render();
  expect(current.artifact?.bytes[0]).toBe(1);
  expect(proposals.operate).toHaveBeenCalledTimes(2);
});

it("exposes PDF errors read-only without scheduling builds or leaking another generation", async () => {
  let selected = proposal;
  function ErrorStatus() { return <span>{useProposalPdfError(selected)}</span>; }
  await act(async () => root.render(<ErrorStatus />));
  expect(proposals.loadBuild).not.toHaveBeenCalled();
  expect(proposals.operate).not.toHaveBeenCalled();
  vi.mocked(proposals.operate).mockRejectedValueOnce(new Error("Build failed"));
  await render();
  await act(async () => root.render(<ErrorStatus />));
  expect(host.textContent).toContain("Build failed");
  expect(proposals.operate).toHaveBeenCalledTimes(1);
  selected = { ...proposal, generation: 2 };
  await act(async () => root.render(<ErrorStatus />));
  expect(host.textContent).toBe("");
  expect(proposals.operate).toHaveBeenCalledTimes(1);
});
