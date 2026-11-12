import { beforeEach, expect, it, vi } from "vitest";
import { privateTemplateItem } from "@/lib/template-catalog";
import { getAllTemplates } from "@/lib/template-registry";

vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: vi.fn() }));
const template = (id: string, revision = "one") =>
  privateTemplateItem({
    id: `private:${id}`,
    revision,
    name: id,
    description: "",
    category: "academic",
    tags: [],
    mainFile: "paper.tex",
  });
let cache: typeof import("@/lib/template-preview-cache");
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  const invoke = await import("@tauri-apps/api/core");
  vi.mocked(invoke.invoke).mockReset();
  cache = await import("@/lib/template-preview-cache");
});

it("deduplicates preview requests and returns independent buffers safe to transfer to workers", async () => {
  const invoke = await import("@tauri-apps/api/core");
  const call = vi.mocked(invoke.invoke).mockResolvedValue([37, 80, 68, 70, 45]);
  const item = template("lab");
  const [first, second] = await Promise.all([
    cache.getTemplatePdfBuffer(item),
    cache.getTemplatePdfBuffer(item),
  ]);
  expect(call).toHaveBeenCalledTimes(1);
  structuredClone(first, { transfer: [first] });
  expect(first.byteLength).toBe(0);
  expect(second.byteLength).toBe(5);
  expect((await cache.getTemplatePdfBuffer(item)).byteLength).toBe(5);
  expect(call).toHaveBeenCalledTimes(1);
});

it("prioritizes opened templates and serializes background compilation", async () => {
  const invoke = await import("@tauri-apps/api/core");
  let finish!: (bytes: number[]) => void;
  const call = vi
    .mocked(invoke.invoke)
    .mockImplementationOnce(
      () =>
        new Promise<number[]>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue([1]);
  const first = cache.getTemplatePdfBuffer(template("first"));
  const second = cache.getTemplatePdfBuffer(template("second"));
  const third = cache.getTemplatePdfBuffer(template("third"));
  const priority = cache.getTemplatePdfBuffer(template("third"), true);
  expect(call).toHaveBeenCalledTimes(1);
  finish([1]);
  await Promise.all([first, second, third, priority]);
  expect(
    call.mock.calls.map(([, args]) => (args as { id: string }).id),
  ).toEqual(["private:first", "private:third", "private:second"]);
});

it("retries failed previews only explicitly or after refresh and separates source revisions", async () => {
  const invoke = await import("@tauri-apps/api/core");
  const call = vi
    .mocked(invoke.invoke)
    .mockRejectedValueOnce("Missing TeX Live")
    .mockResolvedValue([1]);
  const item = template("broken");
  await expect(cache.getTemplatePdfBuffer(item)).rejects.toBe(
    "Missing TeX Live",
  );
  await expect(cache.getTemplatePdfBuffer(item)).rejects.toThrow(
    "Missing TeX Live",
  );
  expect(call).toHaveBeenCalledTimes(1);
  cache.resetPrivatePreviewFailures();
  await cache.getTemplatePdfBuffer(item);
  await cache.getTemplatePdfBuffer(template("broken", "two"));
  await cache.getTemplatePdfBuffer(item, true, true);
  expect(call).toHaveBeenCalledTimes(4);
});

it("loads built-in previews from bundled files without a backend compile", async () => {
  const invoke = await import("@tauri-apps/api/core");
  const call = vi.mocked(invoke.invoke);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(new Uint8Array([1, 2])));
  const item = { ...getAllTemplates()[0], source: "builtin" as const };
  expect((await cache.getTemplatePdfBuffer(item)).byteLength).toBe(2);
  expect(fetch).toHaveBeenCalledWith(`/examples/${item.id}/main.pdf`);
  expect(call).not.toHaveBeenCalled();
});

async function mockRenderer() {
  const { getMupdfClient } = await import("@/lib/mupdf/mupdf-client");
  const client = {
    openDocument: vi.fn(async (buffer: ArrayBuffer) => {
      structuredClone(buffer, { transfer: [buffer] });
      return 1;
    }),
    renderThumbnail: vi.fn(async () => new ArrayBuffer(1)),
    closeDocument: vi.fn(async () => {}),
  };
  vi.mocked(getMupdfClient).mockReturnValue(client as unknown as ReturnType<typeof getMupdfClient>);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:template");
  return client;
}

it("shares template thumbnails without detaching cached PDFs and keeps their own width", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  vi.mocked(invoke).mockResolvedValue([37, 80, 68, 70, 45]);
  const client = await mockRenderer();
  const item = template("thumbnail");
  const notify = vi.fn();
  const unsubscribe = cache.subscribeThumbnails(notify);
  expect(
    await Promise.all([
      cache.generateThumbnail(item),
      cache.generateThumbnail(item),
    ]),
  ).toEqual(["blob:template", "blob:template"]);
  expect(client.renderThumbnail).toHaveBeenCalledExactlyOnceWith(1, 0, 300);
  expect(client.closeDocument).toHaveBeenCalledExactlyOnceWith(1);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(cache.getThumbnail(item)).toBe("blob:template");
  expect(await cache.generateThumbnail(item)).toBe("blob:template");
  expect(client.openDocument).toHaveBeenCalledTimes(1);
  expect((await cache.getTemplatePdfBuffer(item)).byteLength).toBe(5);
  unsubscribe();
});

it("keeps thumbnail failures until retry and revokes successful thumbnails when rebuilding", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  vi.mocked(invoke).mockResolvedValue([1]);
  const client = await mockRenderer();
  client.renderThumbnail.mockRejectedValueOnce(new Error("Bad PDF"));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const item = template("retry-thumbnail");
  expect(await cache.generateThumbnail(item)).toBeNull();
  expect(cache.isThumbnailFailed(item)).toBe(true);
  expect(await cache.generateThumbnail(item)).toBeNull();
  expect(client.openDocument).toHaveBeenCalledTimes(1);
  expect(client.closeDocument).toHaveBeenCalledTimes(1);
  await cache.getTemplatePdfBuffer(item, true, true);
  expect(cache.isThumbnailFailed(item)).toBe(false);
  expect(await cache.generateThumbnail(item)).toBe("blob:template");
  await cache.getTemplatePdfBuffer(item, true, true);
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:template");
  expect(cache.getThumbnail(item)).toBeUndefined();
});
