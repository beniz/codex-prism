import type { ReviewDiffLine } from "./review-diff";

type Cached = {
  before: string;
  after: string;
  rows: ReviewDiffLine[];
  weight: number;
};
const cache: Cached[] = [];
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

/** One cancellable worker per selected revision; closing a file stops its work. */
export function loadReviewDiff(
  before: string,
  after: string,
  signal: AbortSignal,
): Promise<ReviewDiffLine[]> {
  if (signal.aborted)
    return Promise.reject(new DOMException("Cancelled", "AbortError"));
  const index = cache.findIndex(
    (entry) => entry.before === before && entry.after === after,
  );
  if (index >= 0) {
    const [hit] = cache.splice(index, 1);
    cache.push(hit);
    return Promise.resolve(hit.rows);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./review-diff.worker.ts", import.meta.url),
      { type: "module" },
    );
    const dispose = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      dispose();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      dispose();
      reject(new Error("Could not compute the review diff"));
    };
    worker.onmessage = (
      event: MessageEvent<{ rows?: ReviewDiffLine[]; error?: string }>,
    ) => {
      dispose();
      if (!event.data.rows)
        return reject(new Error(event.data.error ?? "Invalid diff response"));
      const rows = event.data.rows;
      const weight =
        2 *
        (before.length +
          after.length +
          rows.reduce((n, row) => n + row.text.length + 64, 0));
      if (weight <= MAX_CACHE_BYTES) {
        cache.push({ before, after, rows, weight });
        while (
          cache.length > 4 ||
          cache.reduce((n, entry) => n + entry.weight, 0) > MAX_CACHE_BYTES
        )
          cache.shift();
      }
      resolve(rows);
    };
    try {
      worker.postMessage({ before, after });
    } catch (error) {
      dispose();
      reject(error);
    }
  });
}
