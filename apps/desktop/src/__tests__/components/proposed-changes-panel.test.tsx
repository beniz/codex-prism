import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProposedChangesPanel } from "@/components/agent-chat/proposed-changes-panel";
import { reviewDiff } from "@/lib/review-diff";
const { state } = vi.hoisted(() => ({
  state: {
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
  },
}));
vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: (select: any) => select(state),
}));
afterEach(() => vi.clearAllMocks());
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
  act(() => root.render(<ProposedChangesPanel />));
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
