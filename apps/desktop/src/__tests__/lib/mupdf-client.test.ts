import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMupdfClient, type MupdfClient } from "@/lib/mupdf/mupdf-client";
class FakeWorker {
  static last: FakeWorker;
  onmessage?: (event: any) => void;
  onerror?: (event: any) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.last = this;
  }
  ready() {
    this.onmessage?.({ data: ["INIT", 0, []] });
  }
  reply(payload: unknown = null) {
    const [, id] =
      this.postMessage.mock.calls[this.postMessage.mock.calls.length - 1][0];
    this.onmessage?.({ data: ["RESULT", id, payload] });
  }
}
let client: MupdfClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  client = createMupdfClient();
});
afterEach(() => {
  client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("removes queued work, keeps active cancellation in its slot, and always closes documents", async () => {
  const worker = FakeWorker.last;
  const a = new AbortController(),
    b = new AbortController();
  const first = client
    .drawPage(1, 0, 72, { signal: a.signal })
    .catch((e) => e.name);
  const cancelled = client
    .getPageText(1, 0, { signal: b.signal })
    .catch((e) => e.name);
  const independent = client.getPageLinks(1, 0);
  const close = client.closeDocument(1);
  worker.ready();
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  a.abort();
  b.abort();
  expect(await first).toBe("AbortError");
  expect(await cancelled).toBe("AbortError");
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  worker.reply({ stale: true });
  expect(
    worker.postMessage.mock.calls[
      worker.postMessage.mock.calls.length - 1
    ][0][0],
  ).toBe("getPageLinks");
  worker.reply([]);
  await expect(independent).resolves.toEqual([]);
  expect(
    worker.postMessage.mock.calls[
      worker.postMessage.mock.calls.length - 1
    ][0][0],
  ).toBe("closeDocument");
  worker.reply();
  await close;
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it("does not dispatch pre-aborted requests and removes abort listeners", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    client.countPages(1, { signal: abort.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const next = new AbortController();
  const remove = vi.spyOn(next.signal, "removeEventListener");
  const count = client.countPages(1, { signal: next.signal });
  FakeWorker.last.ready();
  FakeWorker.last.reply(4);
  expect(await count).toBe(4);
  expect(remove).toHaveBeenCalledTimes(1);
  next.abort();
  expect(FakeWorker.last.postMessage).toHaveBeenCalledTimes(1);
});
it("starts timeouts at dispatch rather than enqueue time", async () => {
  const first = client.countPages(1);
  const second = client.countPages(2);
  FakeWorker.last.ready();
  vi.advanceTimersByTime(29_000);
  FakeWorker.last.reply(1);
  await first;
  vi.advanceTimersByTime(29_000);
  FakeWorker.last.reply(2);
  expect(await second).toBe(2);
});
it.each([
  "initialization",
  "execution",
  "fatal",
  "destroy",
])("settles all requests on %s failure and never reuses worker IDs", async (reason) => {
  const first = client.countPages(1).catch((e) => e);
  const close = client.closeDocument(1).catch((e) => e);
  if (reason !== "initialization") FakeWorker.last.ready();
  if (reason === "fatal") FakeWorker.last.onerror?.({ message: "broken" });
  else if (reason === "destroy") client.destroy();
  else vi.advanceTimersByTime(30_000);
  expect(await first).toBeInstanceOf(Error);
  expect(await close).toBeInstanceOf(Error);
  await expect(client.countPages(1)).rejects.toBeInstanceOf(Error);
  expect(FakeWorker.last.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
