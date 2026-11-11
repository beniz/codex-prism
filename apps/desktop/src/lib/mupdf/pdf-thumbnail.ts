import { getMupdfClient } from "./mupdf-client";

/** Render the first page at the requested width, preserving its aspect ratio.
 * The worker consumes the buffer; pass a copy if the PDF is cached. The caller
 * owns the returned object URL and must revoke it when evicting the thumbnail.
 */
export async function renderPdfThumbnail(
  buffer: ArrayBuffer,
  width: number,
): Promise<string> {
  const client = getMupdfClient();
  const doc = await client.openDocument(buffer);
  try {
    const png = await client.renderThumbnail(doc, 0, width);
    return URL.createObjectURL(new Blob([png], { type: "image/png" }));
  } finally {
    // Cleanup failures must not hide a usable thumbnail or the rendering error.
    await client.closeDocument(doc).catch(() => {});
  }
}
