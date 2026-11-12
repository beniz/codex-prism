import { firstChangedPdfPage } from "./changed-pdf-page";
import type { PageAnalysisInput } from "./changed-pdf-page-client";
import { reviewDiff, reviewBlocks } from "./review-diff";

self.onmessage = (
  event: MessageEvent<{ before: string; after: string; blocks?: boolean } | (PageAnalysisInput & { kind: "firstChangedPage" })>,
) => {
  try {
    if ("kind" in event.data) {
      self.postMessage({ page: firstChangedPdfPage(event.data.changes, event.data.locations) });
      return;
    }
    if (event.data.blocks) {
      self.postMessage({
        blocks: reviewBlocks(event.data.before, event.data.after),
      });
      return;
    }
    self.postMessage({ rows: reviewDiff(event.data.before, event.data.after) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
