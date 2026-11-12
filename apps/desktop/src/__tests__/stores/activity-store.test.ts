import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  beginActivity,
  resetActivities,
  useActivityStore,
  startActivityTurn,
  updateActivityItem,
  finishActivityTurn,
  disconnectActivities,
} from "@/stores/activity-store";
const owner = { projectPath: "/paper", chatId: "a" };
beforeEach(resetActivities);
afterEach(() => {
  resetActivities();
  vi.useRealTimers();
});
it("isolates overlapping operations and ignores stale handles after a project reset", () => {
  const a = beginActivity(owner, "apply");
  const b = beginActivity({ ...owner, chatId: "b" }, "preparingPdf");
  a.finish();
  a.finish();
  expect(useActivityStore.getState().operations.map((o) => o.id)).toEqual([
    b.id,
  ]);
  resetActivities();
  const next = beginActivity(owner, "starting");
  b.update("updatingPdf");
  b.finish();
  expect(useActivityStore.getState().operations).toMatchObject([
    { id: next.id, kind: "starting" },
  ]);
});
it("publishes only changed lifecycle state and schedules no timers", () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const unsubscribe = useActivityStore.subscribe(changed);
  try {
    const a = beginActivity(owner, "starting");
    a.update("starting");
    expect(changed).toHaveBeenCalledTimes(1);
    a.update("working");
    a.finish();
    a.finish();
    expect(changed).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    unsubscribe();
  }
});
it("tracks overlapping tools without old items or turns clearing newer work", () => {
  startActivityTurn(owner, "one");
  updateActivityItem("a", "one", { id: "c", type: "commandExecution" }, true);
  updateActivityItem("a", "one", { id: "r", type: "webSearch" }, true);
  updateActivityItem("a", "one", { id: "c", type: "commandExecution" }, false);
  expect(useActivityStore.getState().operations[0].kind).toBe("research");
  startActivityTurn(owner, "two");
  finishActivityTurn("a", "one");
  updateActivityItem("a", "one", { id: "r", type: "webSearch" }, false);
  expect(useActivityStore.getState().operations[0].kind).toBe("working");
  finishActivityTurn("a", "two");
  updateActivityItem(
    "a",
    "two",
    { id: "late", type: "commandExecution" },
    true,
  );
  expect(useActivityStore.getState().operations).toEqual([]);
});
it("disconnect clears agent operations without losing independent acceptance or builds", () => {
  startActivityTurn(owner, "turn");
  beginActivity(owner, "stopping");
  const apply = beginActivity({ ...owner, chatId: "b" }, "apply", {
    projectWide: true,
  });
  const pdf = beginActivity(owner, "preparingPdf", { group: "build" });
  disconnectActivities();
  expect(useActivityStore.getState().operations.map((o) => o.id)).toEqual([
    apply.id,
    pdf.id,
  ]);
  apply.finish();
  pdf.finish();
});
