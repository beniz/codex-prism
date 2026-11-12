import { createMupdfPool } from "./mupdf-pool";
import type { SourceBox, Region } from "../visual-review";
import type {
  StructuredTextData,
  LinkData,
  PageSize,
  WorkerResponse,
} from "./types";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("mupdf-worker");
export interface RequestOptions {
  signal?: AbortSignal;
  priority?: "foreground" | "background";
  ownerId?: string;
}
export interface MupdfClient {
  openDocument(buffer: ArrayBuffer, magic?: string, options?: RequestOptions): Promise<number>;
  closeDocument(docId: number): Promise<void>;
  countPages(docId: number, options?: RequestOptions): Promise<number>;
  getPageSize(
    docId: number,
    pageIndex: number,
    options?: RequestOptions,
  ): Promise<PageSize>;
  getAllPageSizes(docId: number, options?: RequestOptions): Promise<PageSize[]>;
  drawPage(
    docId: number,
    pageIndex: number,
    dpi: number,
    options?: RequestOptions,
  ): Promise<ImageData>;
  getPageText(
    docId: number,
    pageIndex: number,
    options?: RequestOptions,
  ): Promise<StructuredTextData>;
  getPageLinks(
    docId: number,
    pageIndex: number,
    options?: RequestOptions,
  ): Promise<LinkData[]>;
  renderThumbnail(
    docId: number,
    pageIndex: number,
    targetWidth: number,
    options?: RequestOptions,
  ): Promise<ArrayBuffer>;
  reviewRegions(
    docId: number,
    boxes: SourceBox[],
    options?: RequestOptions,
  ): Promise<Region[]>;
  reviewCrop(
    docId: number,
    region: Region,
    options?: RequestOptions,
  ): Promise<ArrayBuffer>;
  destroy(): void;
}

interface Request {
  id: number;
  method: string;
  args: unknown[];
  finish(error?: Error, value?: unknown): void;
}
const TIMEOUT_MS = 30_000;

/** Keep waiting work here: messages already posted to synchronous WASM cannot be cancelled. */
export function createMupdfClient(onFatal?: (error: Error) => void): MupdfClient {
  const worker = new Worker(new URL("./mupdf-worker.ts", import.meta.url), {
    type: "module",
  });
  const queue: Request[] = [];
  let active: Request | undefined;
  let ready = false;
  let failed: Error | undefined;
  let nextId = 1;
  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  const initializationTimer = setTimeout(
    () => fail(new Error("MuPDF worker initialization timed out")),
    TIMEOUT_MS,
  );

  function fail(error: Error, notify = true) {
    if (failed) return;
    failed = error;
    clearTimeout(initializationTimer);
    clearTimeout(executionTimer);
    worker.terminate();
    active?.finish(error);
    active = undefined;
    for (const request of queue.splice(0)) request.finish(error);
    // Do not replace this client: cached document IDs belong to this worker.
    if (notify) {
      log.error("Worker unavailable", { error: String(error) });
      onFatal?.(error);
    }
  }

  function dispatch() {
    if (!ready || failed || active || !queue.length) return;
    const request = queue.shift()!;
    active = request;
    executionTimer = setTimeout(
      () => fail(new Error(`MuPDF worker timeout: ${request.method}`)),
      TIMEOUT_MS,
    );
    try {
      worker.postMessage([request.method, request.id, request.args], {
        transfer: request.args.filter(
          (arg): arg is ArrayBuffer => arg instanceof ArrayBuffer,
        ),
      });
      request.args = [];
    } catch (error) {
      clearTimeout(executionTimer);
      active = undefined;
      request.finish(error instanceof Error ? error : new Error(String(error)));
      dispatch();
    }
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const [type, id, payload] = event.data;
    if (failed) return;
    if (type === "INIT") {
      clearTimeout(initializationTimer);
      ready = true;
      dispatch();
      return;
    }
    if (!active || active.id !== id) return;
    const request = active;
    active = undefined;
    clearTimeout(executionTimer);
    if (type === "ERROR") {
      const error = payload as { name: string; message: string };
      request.finish(new Error(`${error.name}: ${error.message}`));
    } else request.finish(undefined, payload);
    dispatch();
  };
  worker.onerror = (event) =>
    fail(new Error(event.message || "MuPDF worker failed"));
  worker.onmessageerror = () =>
    fail(new Error("Invalid MuPDF worker response"));

  function call<T>(
    method: string,
    args: unknown[],
    options?: RequestOptions,
  ): Promise<T> {
    const signal = options?.signal;
    if (signal?.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (failed) return Promise.reject(failed);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const request: Request = {
        id: nextId++,
        method,
        args,
        finish(error, value) {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          request.args = [];
          if (error) reject(error);
          else resolve(value as T);
        },
      };
      function abort() {
        const index = queue.indexOf(request);
        if (index >= 0) queue.splice(index, 1);
        request.finish(new DOMException("Cancelled", "AbortError"));
        // An aborted active request still owns the slot until the worker replies.
      }
      signal?.addEventListener("abort", abort, { once: true });
      queue.push(request);
      dispatch();
    });
  }

  return {
    openDocument: (buffer, magic = "application/pdf") =>
      call("openDocument", [buffer, magic]),
    closeDocument: (docId) => call("closeDocument", [docId]),
    countPages: (docId, options) => call("countPages", [docId], options),
    getPageSize: (docId, pageIndex, options) =>
      call("getPageSize", [docId, pageIndex], options),
    getAllPageSizes: (docId, options) =>
      call("getAllPageSizes", [docId], options),
    drawPage: (docId, pageIndex, dpi, options) =>
      call("drawPage", [docId, pageIndex, dpi], options),
    getPageText: (docId, pageIndex, options) =>
      call("getPageText", [docId, pageIndex], options),
    getPageLinks: (docId, pageIndex, options) =>
      call("getPageLinks", [docId, pageIndex], options),
    renderThumbnail: (docId, pageIndex, width, options) =>
      call("renderThumbnail", [docId, pageIndex, width], options),
    reviewRegions: (docId, boxes, options) =>
      call("reviewRegions", [docId, boxes], options),
    reviewCrop: (docId, region, options) =>
      call("reviewCrop", [docId, region], options),
    destroy: () => fail(new Error("MuPDF worker was closed"), false),
  };
}
let instance: ReturnType<typeof createMupdfPool> | null = null;
export function getMupdfClient() {
  return (instance ??= createMupdfPool(createMupdfClient));
}
