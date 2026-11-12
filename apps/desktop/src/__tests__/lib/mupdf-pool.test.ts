import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMupdfPool, type MupdfPool } from "@/lib/mupdf/mupdf-pool";
import type { MupdfClient } from "@/lib/mupdf/mupdf-client";
import { PageCache } from "@/lib/mupdf/page-cache";
const pixels = (value: number, count = 4) =>
  ({
    width: count / 4,
    height: 1,
    data: new Uint8ClampedArray(count).fill(value),
  }) as ImageData;
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
class Fake {
  values = new Map<number, number>();
  next = 1;
  gate: ReturnType<typeof deferred<ImageData>> | undefined;
  constructor(readonly fail: (error: Error) => void) {}
  openDocument = vi.fn(async (bytes: ArrayBuffer) => {
    const id = this.next++;
    this.values.set(id, new Uint8Array(bytes)[0]);
    return id;
  });
  closeDocument = vi.fn(async (id: number) => {
    this.values.delete(id);
  });
  drawPage = vi.fn(async (id: number) =>
    this.gate ? this.gate.promise : pixels(this.values.get(id)!),
  );
  getPageText = vi.fn(async (id: number) => ({
    blocks: [],
    value: this.values.get(id),
  }));
  getPageLinks = vi.fn(async () => []);
  countPages = vi.fn(async () => 2);
  getAllPageSizes = vi.fn(async () => [{ width: 100, height: 100 }]);
  getPageSize = vi.fn(async () => ({ width: 100, height: 100 }));
  renderThumbnail = vi.fn(async () => new ArrayBuffer(1));
  reviewRegions = vi.fn(async () => []);
  reviewCrop = vi.fn(async () => new ArrayBuffer(1));
  destroy = vi.fn();
  crash() {
    const e = new Error("crash");
    this.fail(e);
    this.gate?.reject(e);
  }
}
let workers: Fake[], pool: MupdfPool;
const fg = (ownerId: string) => ({ priority: "foreground" as const, ownerId });
const open = (value: number, owner: string) =>
  pool.openDocument(new Uint8Array([value]).buffer, undefined, fg(owner));
beforeEach(() => {
  workers = [];
  pool = createMupdfPool((fail) => {
    const w = new Fake(fail);
    workers.push(w);
    return w as MupdfClient;
  });
});
afterEach(() => pool.destroy());
it("renders a second chat independently despite colliding worker-local IDs", async () => {
  const a = await open(11, "a");
  workers[0].gate = deferred();
  const first = pool.drawPage(a, 0, 72, fg("a"));
  await tick();
  const b = await open(22, "b");
  expect(workers).toHaveLength(2);
  const second = await pool.drawPage(b, 0, 72, fg("b"));
  expect(second.data[0]).toBe(22);
  expect(workers[0].values.get(1)).toBe(11);
  expect(workers[1].values.get(1)).toBe(22);
  workers[0].gate.resolve(pixels(11));
  expect((await first).data[0]).toBe(11);
  const count = workers[1].drawPage.mock.calls.length;
  await pool.drawPage(b, 0, 72, fg("b"));
  expect(workers[1].drawPage).toHaveBeenCalledTimes(count);
  // A different resolution cannot use those pixels.
  await pool.drawPage(b, 0, 144, fg("b"));
  expect(workers[1].drawPage).toHaveBeenCalledTimes(count + 1);
});
it("limits background work to one worker and promotes a newly visible queued page", async () => {
  const a = await open(1, "a");
  workers[0].gate = deferred();
  const busy = pool.drawPage(a, 0, 72);
  await tick();
  const queued = pool.drawPage(a, 1, 72, { ownerId: "b" });
  await tick();
  expect(workers).toHaveLength(1);
  pool.promotePage(a, 1, "b", "foreground");
  await tick();
  expect(workers).toHaveLength(2);
  expect((await queued).data[0]).toBe(1);
  workers[0].gate.resolve(pixels(1));
  await busy;
});
it("deduplicates shared renders without cancelling another consumer and preserves cleanup", async () => {
  const doc = await open(7, "a");
  workers[0].gate = deferred();
  const abort = new AbortController();
  const cancelled = pool
    .drawPage(doc, 0, 72, { ...fg("a"), signal: abort.signal })
    .catch((e) => e.name);
  const kept = pool.drawPage(doc, 0, 72, fg("b"));
  await tick();
  abort.abort();
  expect(await cancelled).toBe("AbortError");
  expect(workers).toHaveLength(1);
  workers[0].gate.resolve(pixels(7));
  expect((await kept).data[0]).toBe(7);
  expect(workers[0].drawPage).toHaveBeenCalledTimes(1);
  await pool.closeDocument(doc);
  expect(workers[0].closeDocument).toHaveBeenCalledWith(1);
  expect(workers[0].destroy).toHaveBeenCalledTimes(1);
});
it("keeps at most five replicas, reopens evicted replicas and closes all copies", async () => {
  const docs = [];
  for (let i = 0; i < 6; i++) docs.push(await open(i, "chat"));
  expect(workers[0].values.size).toBe(5);
  expect((await pool.drawPage(docs[0], 0, 72, fg("chat"))).data[0]).toBe(0);
  expect(workers[0].values.size).toBe(5);
  await Promise.all(docs.map((id) => pool.closeDocument(id)));
  expect(workers[0].values.size).toBe(0);
});
it("retries a crashed worker's needed read on the survivor, never treating a render error as a crash", async () => {
  const a = await open(3, "a");
  workers[0].gate = deferred();
  const first = pool.drawPage(a, 0, 72, fg("a"));
  await tick();
  const b = await open(9, "b");
  await pool.countPages(b, fg("b"));
  workers[0].crash();
  expect((await first).data[0]).toBe(3);
  expect(workers).toHaveLength(2);
  workers[1].drawPage.mockRejectedValueOnce(new Error("bad page"));
  await expect(pool.drawPage(b, 8, 72, fg("b"))).rejects.toThrow("bad page");
  expect((await pool.drawPage(b, 1, 72, fg("b"))).data[0]).toBe(9);
});
it("does not restore cleared raster entries from an already running job", async () => {
  const doc = await open(1, "a");
  workers[0].gate = deferred();
  const job = pool.drawPage(doc, 0, 72, fg("a"));
  await tick();
  pool.clearPageCache();
  workers[0].gate.resolve(pixels(1));
  await job;
  expect(pool.peekPage(doc, 0, 72)).toBeUndefined();
});
it("enforces raster byte accounting and LRU eviction independently of document replicas", () => {
  const cache = new PageCache(12);
  cache.set("1:0:72", pixels(1));
  cache.set("1:1:72", pixels(2));
  cache.set("2:0:72", pixels(3));
  cache.get("1:0:72");
  cache.set("3:0:72", pixels(4));
  expect(cache.byteLength).toBe(12);
  expect(cache.get("1:1:72")).toBeUndefined();
  cache.set("oversize", pixels(0, 16));
  expect(cache.byteLength).toBe(12);
  cache.removeDocument(1);
  expect(cache.byteLength).toBe(8);
  cache.clear();
  expect(cache.byteLength).toBe(0);
});
it("uses chat affinity for a new revision without creating a third worker", async () => {
  const a = await open(1, "a");
  workers[0].gate = deferred();
  const busy = pool.drawPage(a, 0, 72, fg("a"));
  await tick();
  const b = await open(2, "b");
  workers[1].gate = deferred();
  const busyB = pool.drawPage(b, 0, 72, fg("b"));
  await tick();
  const waiting = pool.countPages(a, fg("c"));
  await tick();
  expect(workers).toHaveLength(2);
  workers[0].gate.resolve(pixels(1));
  await busy;
  await waiting;
  workers[1].gate.resolve(pixels(2));
  await busyB;
  await open(3, "b");
  expect([...workers[1].values.values()]).toContain(3);
  expect(workers).toHaveLength(2);
});
it("settles requests when worker construction fails or both running workers fail", async () => {
  const unavailable = createMupdfPool(() => {
    throw new Error("cannot start");
  });
  await expect(unavailable.openDocument(new ArrayBuffer(1))).rejects.toThrow(
    "cannot start",
  );
  unavailable.destroy();
  const a = await open(1, "a");
  workers[0].gate = deferred();
  const first = pool.drawPage(a, 0, 72, fg("a")).catch((e) => e);
  await tick();
  const b = await open(2, "b");
  workers[1].gate = deferred();
  const second = pool.drawPage(b, 0, 72, fg("b")).catch((e) => e);
  await tick();
  workers[0].crash();
  workers[1].crash();
  expect(await first).toBeInstanceOf(Error);
  expect(await second).toBeInstanceOf(Error);
  await pool.closeDocument(a);
  await pool.closeDocument(b);
});
it("closes a replica whose open finishes after its last read consumer was cancelled", async () => {
  const doc = await open(1, "a");
  workers[0].gate = deferred();
  const busy = pool.drawPage(doc, 0, 72, fg("a"));
  await tick();
  // Opening a second physical copy is protected even after its read is cancelled.
  const abort = new AbortController();
  const read = pool
    .drawPage(doc, 1, 72, { ...fg("b"), signal: abort.signal })
    .catch((e) => e.name);
  abort.abort();
  expect(await read).toBe("AbortError");
  await tick();
  const closing = pool.closeDocument(doc);
  workers[0].gate.resolve(pixels(1));
  await busy.catch(() => {});
  await closing;
  for (const w of workers) expect(w.values.size).toBe(0);
});

it("retains a worker across thumbnail documents without starting one for cache-only visits", async () => {
  const release = pool.retainWorkers();
  expect(workers).toHaveLength(0);
  const first = await open(1, "cards");
  await pool.closeDocument(first);
  expect(workers[0].destroy).not.toHaveBeenCalled();
  const second = await open(2, "cards");
  expect(workers).toHaveLength(1);
  await pool.closeDocument(second);
  release();
  release();
  expect(workers[0].destroy).toHaveBeenCalledTimes(1);
});
