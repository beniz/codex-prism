import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
  clearDocCache,
  getCachedDocument,
  getOrOpenDocument,
} from "@/lib/mupdf/pdf-doc-cache";
const client = vi.hoisted(() => ({
  openDocument: vi.fn(),
  closeDocument: vi.fn(async () => {}),
  getAllPageSizes: vi.fn(),
}));
vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: () => client }));
beforeEach(async () => {
  await clearDocCache();
  vi.clearAllMocks();
});
it("closes a document opened after its cache was cleared instead of restoring stale entries", async () => {
  let finish!: (id: number) => void;
  client.openDocument.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const bytes = new Uint8Array([1, 2, 3]);
  const pending = getOrOpenDocument(bytes, "a").catch((error) => error.name);
  await Promise.resolve();
  await Promise.resolve();
  await clearDocCache();
  finish(42);
  expect(await pending).toBe("AbortError");
  expect(client.closeDocument).toHaveBeenCalledWith(42);
  expect(client.getAllPageSizes).not.toHaveBeenCalled();
  expect(getCachedDocument(bytes, "a")).toBeNull();
});
it("closes a document if reading its metadata fails", async () => {
  client.openDocument.mockResolvedValue(7);
  client.getAllPageSizes.mockRejectedValue(new Error("broken metadata"));
  await expect(getOrOpenDocument(new Uint8Array([1]), "b")).rejects.toThrow(
    "broken metadata",
  );
  expect(client.closeDocument).toHaveBeenCalledWith(7);
});
it("shares a pending open instead of allocating duplicate documents for two consumers", async () => {
  client.openDocument.mockResolvedValue(8);
  client.getAllPageSizes.mockResolvedValue([{ width: 100, height: 200 }]);
  const bytes = new Uint8Array([3]);
  const results = await Promise.all([
    getOrOpenDocument(bytes, "shared"),
    getOrOpenDocument(bytes, "shared"),
  ]);
  expect(results[0].docId).toBe(8);
  expect(results[1].docId).toBe(8);
  expect(client.openDocument).toHaveBeenCalledTimes(1);
  results.forEach((result) => result.release());
});
it("does not close leased documents during cache clearing", async () => {
  client.openDocument.mockResolvedValue(10);
  client.getAllPageSizes.mockResolvedValue([]);
  const bytes = new Uint8Array([1]);
  const a = await getOrOpenDocument(bytes, "lease", "project");
  const b = getCachedDocument(bytes, "lease", "project")!;
  expect(getCachedDocument(bytes, "lease", "another")).toBeNull();
  await clearDocCache();
  expect(client.closeDocument).not.toHaveBeenCalled();
  a.release();
  expect(client.closeDocument).not.toHaveBeenCalled();
  b.release();
  b.release();
  expect(client.closeDocument).toHaveBeenCalledExactlyOnceWith(10);
});

it("hashes all PDF bytes instead of aliasing equal-sized PDFs with matching sampled bytes", async () => {
  vi.stubGlobal("crypto", webcrypto);
  let id = 30;
  client.openDocument.mockImplementation(async () => ++id);
  client.getAllPageSizes.mockResolvedValue([]);
  const a = new Uint8Array(100),
    b = new Uint8Array(100);
  a[12] = 1;
  b[12] = 2;
  try {
    const first = await getOrOpenDocument(a);
    const second = await getOrOpenDocument(b);
    expect(first.docId).not.toBe(second.docId);
    const again = getCachedDocument(a)!;
    expect(again.docId).toBe(first.docId);
    first.release();
    second.release();
    again.release();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("evicts only unleased entries when more than five viewers own documents", async () => {
  let id = 50;
  client.openDocument.mockImplementation(async () => ++id);
  client.getAllPageSizes.mockResolvedValue([]);
  const leases = [];
  for (let index = 0; index < 6; index++) {
    leases.push(
      await getOrOpenDocument(new Uint8Array([index]), `pinned-${index}`),
    );
  }
  expect(client.closeDocument).not.toHaveBeenCalled();
  leases[5].release();
  expect(client.closeDocument).toHaveBeenCalledExactlyOnceWith(56);
  const stillMounted = getCachedDocument(new Uint8Array([0]), "pinned-0")!;
  expect(stillMounted.docId).toBe(51);
  stillMounted.release();
  leases.forEach((lease) => lease.release());
  await clearDocCache();
  expect(client.closeDocument).toHaveBeenCalledTimes(6);
});
