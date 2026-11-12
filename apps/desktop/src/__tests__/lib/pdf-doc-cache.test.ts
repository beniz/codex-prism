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
});
