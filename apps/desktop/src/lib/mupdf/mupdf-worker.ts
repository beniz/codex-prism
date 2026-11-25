import { boundedRenderScale } from "./render-budget";
import { renderedRegions } from "../visual-regions";
import type { SourceBox, Region } from "../visual-review";
import type { StructuredTextData } from "./types";
import type { PDFDocument } from "mupdf";

type MupdfModule = typeof import("mupdf");

type MupdfWasmModuleConfig = {
  locateFile?: (path: string) => string;
};

const wasmModuleConfig = ((
  globalThis as typeof globalThis & {
    $libmupdf_wasm_Module?: MupdfWasmModuleConfig;
  }
).$libmupdf_wasm_Module ??= {});

// In Vite dev, requests for /node_modules/.../mupdf-wasm.wasm can fall back to
// index.html. Pointing MuPDF at Vite's @fs URL keeps worker startup on the
// actual binary during local development without changing packaged builds.
if (import.meta.env.DEV) {
  const devWasmUrl = `/@fs/${__MUPDF_WASM_FS_PATH__}`;
  wasmModuleConfig.locateFile = (path: string) => {
    if (path.endsWith("mupdf-wasm.wasm")) {
      return devWasmUrl;
    }
    return path;
  };
}

const mupdf: MupdfModule = await import("mupdf");

const documentMap = new Map<number, PDFDocument>();
let nextDocId = 1;

const methods: Record<string, (...args: any[]) => any> = {};

methods.openDocument = (buffer: ArrayBuffer, magic: string): number => {
  const docId = nextDocId++;
  const doc = mupdf.Document.openDocument(
    buffer,
    magic,
  ) as unknown as PDFDocument;
  documentMap.set(docId, doc);
  return docId;
};

methods.closeDocument = (docId: number): void => {
  const doc = documentMap.get(docId);
  if (doc) {
    documentMap.delete(docId);
    doc.destroy();
  }
};

methods.countPages = (docId: number): number => {
  const doc = documentMap.get(docId)!;
  return doc.countPages();
};

methods.getPageSize = (
  docId: number,
  pageIndex: number,
): { width: number; height: number } => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  try {
    const bounds = page.getBounds();
    return { width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] };
  } finally {
    page.destroy();
  }
};

methods.getAllPageSizes = (
  docId: number,
): { width: number; height: number }[] => {
  const doc = documentMap.get(docId)!;
  const count = doc.countPages();
  const sizes: { width: number; height: number }[] = [];
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
    try {
      const bounds = page.getBounds();
      sizes.push({
        width: bounds[2] - bounds[0],
        height: bounds[3] - bounds[1],
      });
    } finally {
      page.destroy();
    }
  }
  return sizes;
};

methods.drawPage = (
  docId: number,
  pageIndex: number,
  dpi: number,
): ImageData => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  try {
    const bounds = page.getBounds();
    const scale = boundedRenderScale(
      bounds[2] - bounds[0],
      bounds[3] - bounds[1],
      dpi / 72,
    );
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    );
    try {
      const w = pixmap.getWidth();
      const h = pixmap.getHeight();
      // getPixels() is a view into WASM memory: copy before destroying pixmap.
      const rgb = pixmap.getPixels();
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        rgba[j] = rgb[i];
        rgba[j + 1] = rgb[i + 1];
        rgba[j + 2] = rgb[i + 2];
        rgba[j + 3] = 255;
      }
      return new ImageData(rgba, w, h);
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
};

methods.searchPage = (docId: number, pageIndex: number, query: string) => {
  const page = documentMap.get(docId)!.loadPage(pageIndex);
  try {
    const [left, top] = page.getBounds();
    // MuPDF limits the number of returned quads, including multiline matches.
    let capacity = 128;
    for (;;) {
      const hits = page.search(query, capacity);
      if (hits.reduce((count, hit) => count + hit.length, 0) < capacity) {
        return hits.map((hit) =>
          hit.map(([x0, y0, x1, y1, x2, y2, x3, y3]) => {
            const x = Math.min(x0, x1, x2, x3);
            const y = Math.min(y0, y1, y2, y3);
            return {
              x: x - left,
              y: y - top,
              w: Math.max(x0, x1, x2, x3) - x,
              h: Math.max(y0, y1, y2, y3) - y,
            };
          }),
        );
      }
      capacity *= 2;
    }
  } finally {
    page.destroy();
  }
};

methods.getPageText = (docId: number, pageIndex: number): unknown => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  const stext = page.toStructuredText("preserve-whitespace");
  const raw = JSON.parse(stext.asJSON());

  // Transform mupdf's nested spans format to our flat line format
  const blocks = (raw.blocks || []).map((block: any) => {
    if (block.type !== "text") return block;
    return {
      type: "text",
      bbox: block.bbox,
      lines: (block.lines || []).map((line: any) => {
        let text = typeof line.text === "string" ? line.text : "";
        let font = {
          name: line.font?.name ?? "",
          family: line.font?.family ?? "",
          size: line.font?.size ?? 12,
          weight: line.font?.weight ?? "normal",
          style: line.font?.style ?? "normal",
        };
        let baselineY = line.y ?? (line.bbox?.y ?? 0) + (line.bbox?.h ?? 0);

        const spans = line.spans || [];
        if (spans.length > 0) {
          text = spans
            .map((span: any) =>
              (span.chars || []).map((ch: any) => ch.c).join(""),
            )
            .join("");

          const firstSpan = spans[0];
          font = {
            name: firstSpan.font?.name || "",
            family: firstSpan.font?.family || "",
            size: firstSpan.size || 12,
            weight: firstSpan.font?.weight || "normal",
            style: firstSpan.font?.style || "normal",
          };

          // Use first char origin as baseline
          if (firstSpan.chars?.[0]?.origin) {
            baselineY = firstSpan.chars[0].origin.y;
          } else {
            baselineY = (line.bbox?.y || 0) + (line.bbox?.h || 0);
          }
        }

        return {
          bbox: line.bbox || { x: 0, y: 0, w: 0, h: 0 },
          wmode: line.wmode || 0,
          x: line.bbox?.x || 0,
          y: baselineY,
          text,
          font,
        };
      }),
    };
  });

  stext.destroy();
  page.destroy();
  return { blocks };
};

methods.getPageLinks = (docId: number, pageIndex: number): unknown[] => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  const links = page.getLinks();
  try {
    return links.map((link: any) => {
      const bounds = link.getBounds();
      const uri: string = link.getURI() || "";
      const isExternal: boolean = link.isExternal?.() ?? uri.startsWith("http");
      let href: string;
      if (isExternal) {
        href = uri;
      } else {
        try {
          const resolved = doc.resolveLink(uri) as any;
          if (typeof resolved === "number") {
            href = `#page=${resolved + 1}`;
          } else if (resolved && typeof resolved.page === "number") {
            href = `#page=${resolved.page + 1}`;
          } else {
            href = uri;
          }
        } catch {
          href = uri;
        }
      }
      return {
        x: bounds[0],
        y: bounds[1],
        w: bounds[2] - bounds[0],
        h: bounds[3] - bounds[1],
        href,
        isExternal,
      };
    });
  } finally {
    for (const link of links) link.destroy();
    page.destroy();
  }
};

methods.renderThumbnail = (
  docId: number,
  pageIndex: number,
  targetWidth: number,
): ArrayBuffer => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  try {
    const bounds = page.getBounds();
    const scale = boundedRenderScale(
      bounds[2] - bounds[0],
      bounds[3] - bounds[1],
      (targetWidth * 2) / (bounds[2] - bounds[0]),
    );
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    );
    try {
      return pixmap.asPNG().slice().buffer as ArrayBuffer;
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
};

methods.reviewRegions = (docId: number, boxes: SourceBox[]) => {
  const pages = new Map<number, StructuredTextData>();
  for (const page of new Set(boxes.map((b) => b.page))) {
    if (page > 0 && page <= documentMap.get(docId)!.countPages())
      pages.set(
        page,
        methods.getPageText(docId, page - 1) as StructuredTextData,
      );
  }
  return renderedRegions(boxes, pages);
};
methods.reviewCrop = (docId: number, region: Region): ArrayBuffer => {
  const page = documentMap.get(docId)!.loadPage(region.page - 1);
  const scale = Math.min(
    2,
    560 / Math.max(1, region.w),
    800 / Math.max(1, region.h),
  );
  const box: [number, number, number, number] = [
    Math.floor((region.x - 4) * scale),
    Math.floor((region.y - 4) * scale),
    Math.ceil((region.x + region.w + 4) * scale),
    Math.ceil((region.y + region.h + 4) * scale),
  ];
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, false);
  pixmap.clear(255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  try {
    page.run(device, mupdf.Matrix.scale(scale, scale));
    device.close();
    return pixmap.asPNG().slice().buffer as ArrayBuffer;
  } finally {
    device.destroy();
    pixmap.destroy();
    page.destroy();
  }
};
// RPC message handler
self.onmessage = (event: MessageEvent) => {
  const [func, id, args] = event.data as [string, number, unknown[]];
  try {
    const result = methods[func](...args);
    if (result instanceof ImageData) {
      postMessage(["RESULT", id, result], { transfer: [result.data.buffer] });
    } else if (result instanceof ArrayBuffer) {
      postMessage(["RESULT", id, result], { transfer: [result] });
    } else {
      postMessage(["RESULT", id, result]);
    }
  } catch (error: any) {
    postMessage(["ERROR", id, { name: error.name, message: error.message }]);
  }
};

postMessage(["INIT", 0, Object.keys(methods)]);
