import { reviewDiff } from "./review-diff";

self.onmessage = (event: MessageEvent<{ before: string; after: string }>) => {
  try {
    self.postMessage({ rows: reviewDiff(event.data.before, event.data.after) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
