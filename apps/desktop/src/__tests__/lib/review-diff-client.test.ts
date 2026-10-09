import { afterEach, expect, it, vi } from "vitest";
import { loadReviewDiff } from "@/lib/review-diff-client";

const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    workers.push(this);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  workers.length = 0;
});
it("cancels stale work and reuses completed content across refreshed review objects", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const cancelled = new AbortController();
  const first = loadReviewDiff(
    "before-cancel",
    "after-cancel",
    cancelled.signal,
  );
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  cancelled.abort();
  await rejected;
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  const signal = new AbortController().signal;
  const second = loadReviewDiff("before-cache", "after-cache", signal);
  const rows = [{ kind: "added" as const, text: "after-cache", number: 1 }];
  workers[1].onmessage!({ data: { rows } });
  expect(await second).toEqual(rows);
  expect(workers[1].terminate).toHaveBeenCalledOnce();
  expect(await loadReviewDiff("before-cache", "after-cache", signal)).toBe(
    rows,
  );
  expect(workers).toHaveLength(2);
});
it("reports worker failures and releases the worker", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const result = loadReviewDiff(
    "error-before",
    "error-after",
    new AbortController().signal,
  );
  const rejected = expect(result).rejects.toThrow("Could not compute");
  workers[0].onerror!();
  await rejected;
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});
