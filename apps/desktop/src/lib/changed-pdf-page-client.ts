import type { ReviewChange } from "./backend";
import type { SourceBox } from "./visual-review";

export type PageAnalysisInput = {
  changes: ReviewChange[];
  locations: Pick<SourceBox, "file" | "line" | "page">[];
};
/** A dedicated worker can be terminated without invalidating shared PDF documents. */
export function loadFirstChangedPdfPage(
  input: PageAnalysisInput,
  signal: AbortSignal,
): Promise<number | undefined> {
  if (signal.aborted)
    return Promise.reject(new DOMException("Cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./review-diff.worker.ts", import.meta.url),
      { type: "module" },
    );
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("PDF change analysis timed out")),
      30_000,
    );
    function finish(error?: Error, page?: number) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(page);
    }
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(new Error("Could not analyze PDF changes"));
    worker.onmessageerror = () =>
      finish(new Error("Invalid PDF analysis response"));
    worker.onmessage = (
      event: MessageEvent<{ page?: number; error?: string }>,
    ) => {
      const result = event.data;
      if (result.error) finish(new Error(result.error));
      else finish(undefined, result.page);
    };
    try {
      worker.postMessage({ kind: "firstChangedPage", ...input });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
