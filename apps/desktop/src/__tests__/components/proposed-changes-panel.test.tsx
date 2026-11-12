import { beginActivity, resetActivities } from "@/stores/activity-store";
import type { Proposal } from "@/lib/backend";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProposedChangesPanel } from "@/components/agent-chat/proposed-changes-panel";
import { loadReviewDiff } from "@/lib/review-diff-client";
import { reviewDiff } from "@/lib/review-diff";
const { state } = vi.hoisted(() => ({
  state: {
    proposals: [] as Proposal[],
    decideProposal: vi.fn(async (_action: string) => {}),
    review: {
      active: false,
      changes: [
        {
          path: "main.tex",
          oldContent: "old",
          newContent: "new",
          kind: "modified",
          binary: false,
        },
      ],
    },
    resolveReview: vi.fn(async (_path: string, _undo: boolean) => {}),
    keepAllReview: vi.fn(async () => {}),
  },
}));
vi.mock("@/stores/agent-chat-store", () => ({
  activeProposal: () => state.proposals[0],
  useAgentChatStore: (select: any = (s: any) => s) => select(state),
}));
vi.mock("@/lib/review-diff-client", () => ({
  loadReviewDiff: vi.fn(async (before: string, after: string) =>
    reviewDiff(before, after),
  ),
}));
afterEach(() => {
  resetActivities();
  state.proposals = [];
  vi.clearAllMocks();
});
it("puts Keep all before file controls only when several files have changes", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const original = state.review.changes;
  try {
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(host.textContent).not.toContain("Keep all changes");
    state.review.changes = [
      ...original,
      { ...original[0], path: "included.tex" },
    ];
    await act(async () => root.render(<ProposedChangesPanel />));
    const first = host.querySelector<HTMLButtonElement>("button")!;
    expect(first.textContent).toBe("Keep all changes");
    await act(async () => first.click());
    expect(state.keepAllReview).toHaveBeenCalledOnce();
    expect(state.resolveReview).not.toHaveBeenCalled();
  } finally {
    state.review.changes = original;
    await act(async () => root.unmount());
  }
});
it("shows changed lines with context without duplicating it", () => {
  const rows = reviewDiff("before\nold\nafter", "before\nnew\nafter");
  expect(rows.map((r) => [r.kind, r.text])).toEqual([
    ["context", "before"],
    ["removed", "old"],
    ["added", "new"],
    ["context", "after"],
  ]);
});
it("handles additions, deletions and unchanged documents", () => {
  expect(
    reviewDiff("", "added")
      .filter((r) => r.kind === "added")
      .map((r) => r.text),
  ).toEqual(["added"]);
  expect(
    reviewDiff("removed", "")
      .filter((r) => r.kind === "removed")
      .map((r) => r.text),
  ).toEqual(["removed"]);
  expect(reviewDiff("same", "same")).toEqual([]);
});
it("collapses distant unchanged lines", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[15] = "replacement";
  const rows = reviewDiff(lines.join("\n"), changed.join("\n"));
  expect(rows.filter((r) => r.kind === "gap")).toHaveLength(2);
  expect(rows).toHaveLength(8);
});
it("keeps and undoes the correct file and disables decisions while pending", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<ProposedChangesPanel />));
  let finish!: () => void;
  state.resolveReview.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const keep = host.querySelector<HTMLButtonElement>(
    'button[title="Keep all changes to main.tex"]',
  )!;
  const undo = host.querySelector<HTMLButtonElement>(
    'button[title="Undo all changes to main.tex"]',
  )!;
  act(() => keep.click());
  expect(state.resolveReview).toHaveBeenCalledWith("main.tex", false);
  expect(keep.disabled).toBe(true);
  expect(undo.disabled).toBe(true);
  await act(async () => finish());
  await act(async () => undo.click());
  expect(state.resolveReview).toHaveBeenLastCalledWith("main.tex", true);
  act(() => root.unmount());
});

it("computes only the selected diff, keeps stable revisions cached, and bounds rendered rows", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const original = state.review.changes;
  state.review.changes = [
    {
      path: "large.tex",
      oldContent: "",
      newContent: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join(
        "\n",
      ),
      kind: "added",
      binary: false,
    },
    {
      path: "other.tex",
      oldContent: "old",
      newContent: "new",
      kind: "modified",
      binary: false,
    },
  ];
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(loadReviewDiff).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll(".whitespace-pre").length).toBeLessThanOrEqual(
      24,
    );
    const viewport = host.querySelector('[aria-label="Changes to large.tex"]')!;
    act(() => {
      viewport.scrollTop = 8000;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(viewport.textContent).toContain("line 400");
    state.review.changes = state.review.changes.map((c) => ({ ...c }));
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(loadReviewDiff).toHaveBeenCalledTimes(1);
    await act(async () =>
      (
        host.querySelector('[title="other.tex"]')!
          .parentElement as HTMLButtonElement
      ).click(),
    );
    expect(loadReviewDiff).toHaveBeenCalledTimes(2);
    expect(
      host.querySelector('[aria-label="Changes to large.tex"]'),
    ).toBeNull();
  } finally {
    act(() => root.unmount());
    state.review.changes = original;
  }
});

it("shows Keep only after a proposal has changes and enables it when the turn finishes", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const proposal: Proposal = {
    id: "proposal",
    projectId: "project",
    threadId: "thread",
    generation: 1,
    state: "running",
    conflicts: [],
    parent: null,
    changes: [],
  };
  state.proposals = [proposal];
  const keep = () =>
    host.querySelector<HTMLButtonElement>(
      'button[title="Keep all changes from this chat"]',
    );
  try {
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(host.textContent).toContain("0 changed files");
    expect(keep()).toBeNull();

    proposal.state = "ready";
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(keep()).toBeNull();

    proposal.changes = [state.review.changes[0] as Proposal["changes"][number]];
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(keep()?.disabled).toBe(false);
    await act(async () => keep()!.click());
    expect(state.decideProposal).toHaveBeenCalledWith("apply");

    proposal.state = "running";
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(keep()?.disabled).toBe(true);

    proposal.changes = [];
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(keep()).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not transfer a busy Keep button to another chat's proposal", async () => {
  const proposal = { id: "a", projectId: "project", chatId: "chat-a", threadId: null, parent: null, generation: 1, state: "ready", conflicts: [], changes: [state.review.changes[0]] } as Proposal;
  state.proposals = [proposal];
  const busy = beginActivity({ projectPath: "/paper", chatId: "chat-a", proposalId: "a" }, "apply");
  const host = document.createElement("div"); const root = createRoot(host);
  const keep = () => host.querySelector<HTMLButtonElement>('button[title="Keep all changes from this chat"]')!;
  try {
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(keep().disabled).toBe(true); expect(keep().textContent).toBe("…");
    state.proposals = [{ ...proposal, id: "b", chatId: "chat-b" }];
    await act(async () => root.render(<ProposedChangesPanel />));
    expect(keep().disabled).toBe(false); expect(keep().textContent).toBe("Keep");
    await act(async () => busy.finish());
    expect(keep().disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
