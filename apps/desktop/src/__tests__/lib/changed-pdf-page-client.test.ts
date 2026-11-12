import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFirstChangedPdfPage } from "@/lib/changed-pdf-page-client";
class WorkerMock {
  static all: WorkerMock[] = [];
  onmessage?: (event: any) => void;
  onerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    WorkerMock.all.push(this);
  }
}
beforeEach(() => {
  WorkerMock.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("Worker", WorkerMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("terminates only the cancelled analysis and ignores its late result", async () => {
  const abort = new AbortController();
  const first = loadFirstChangedPdfPage(
    { changes: [], locations: [] },
    abort.signal,
  ).catch((e) => e.name);
  const second = loadFirstChangedPdfPage(
    { changes: [], locations: [] },
    new AbortController().signal,
  );
  abort.abort();
  WorkerMock.all[0].onmessage?.({ data: { page: 9 } });
  WorkerMock.all[1].onmessage?.({ data: { page: 3 } });
  expect(await first).toBe("AbortError");
  expect(await second).toBe(3);
  for (const worker of WorkerMock.all)
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("settles no-change and timeout results without leaving workers running", async () => {
  const empty = loadFirstChangedPdfPage(
    { changes: [], locations: [] },
    new AbortController().signal,
  );
  WorkerMock.all[0].onmessage?.({ data: { page: undefined } });
  expect(await empty).toBeUndefined();
  const timeout = loadFirstChangedPdfPage(
    { changes: [], locations: [] },
    new AbortController().signal,
  ).catch((e) => e);
  vi.advanceTimersByTime(30_000);
  expect(await timeout).toBeInstanceOf(Error);
  expect(WorkerMock.all[1].terminate).toHaveBeenCalledTimes(1);
});
