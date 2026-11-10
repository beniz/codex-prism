import { beforeEach, expect, it, vi } from "vitest";
import { getMupdfClient, type MupdfClient } from "@/lib/mupdf/mupdf-client";
import { renderPdfThumbnail } from "@/lib/mupdf/pdf-thumbnail";

vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: vi.fn() }));

const client = {
  openDocument: vi.fn<MupdfClient["openDocument"]>(),
  renderThumbnail: vi.fn<MupdfClient["renderThumbnail"]>(),
  closeDocument: vi.fn<MupdfClient["closeDocument"]>(),
};
beforeEach(() => {
  vi.restoreAllMocks();
  client.openDocument.mockReset().mockResolvedValue(0);
  client.renderThumbnail.mockReset().mockResolvedValue(new ArrayBuffer(1));
  client.closeDocument.mockReset().mockResolvedValue(undefined);
  vi.mocked(getMupdfClient).mockReturnValue(client as unknown as MupdfClient);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumbnail");
});

it("does not attempt to close a document that failed to open", async () => {
  const failure = new Error("Invalid PDF");
  client.openDocument.mockRejectedValue(failure);
  await expect(renderPdfThumbnail(new ArrayBuffer(1), 420)).rejects.toBe(
    failure,
  );
  expect(client.closeDocument).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("releases the document when rendering fails without masking the original error", async () => {
  const failure = new Error("Rendering failed");
  client.renderThumbnail.mockRejectedValue(failure);
  client.closeDocument.mockRejectedValue(new Error("Worker unavailable"));
  await expect(renderPdfThumbnail(new ArrayBuffer(1), 300)).rejects.toBe(
    failure,
  );
  expect(client.closeDocument).toHaveBeenCalledExactlyOnceWith(0);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("releases the document when creating the image URL fails", async () => {
  const failure = new Error("URL allocation failed");
  vi.mocked(URL.createObjectURL).mockImplementation(() => {
    throw failure;
  });
  await expect(renderPdfThumbnail(new ArrayBuffer(1), 300)).rejects.toBe(
    failure,
  );
  expect(client.closeDocument).toHaveBeenCalledExactlyOnceWith(0);
});

it("retains a rendered thumbnail when document cleanup fails", async () => {
  client.closeDocument.mockRejectedValue(new Error("Worker unavailable"));
  await expect(renderPdfThumbnail(new ArrayBuffer(1), 420)).resolves.toBe(
    "blob:thumbnail",
  );
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
  expect(blob.type).toBe("image/png");
  expect(blob.size).toBe(1);
});
