import type { ReviewChange } from "./backend";
import type { SourceBox } from "./visual-review";
import { reviewBlocks } from "./review-diff";

/** Find the earliest page containing changed source; deletions use adjacent text. */
export function firstChangedPdfPage(changes: ReviewChange[], locations: Pick<SourceBox, "file" | "line" | "page">[]): number | undefined {
  let first: number | undefined;
  for (const change of changes) {
    if (change.binary || change.newContent === null) continue;
    const boxes = locations.filter((box) => box.file === change.path);
    if (!boxes.length) continue;
    for (const block of reviewBlocks(change.oldContent ?? "", change.newContent)) {
      const range = block.after ?? block.context ?? { start: 1, end: 1 };
      let matches = boxes.filter((box) => box.line >= range.start && box.line <= range.end);
      if (!matches.length) {
        // TeX may associate an entire paragraph/frame with its closing line.
        const following = boxes.filter((box) => box.line >= range.start);
        const line = following.length
          ? Math.min(...following.map((box) => box.line))
          : Math.max(...boxes.map((box) => box.line));
        matches = boxes.filter((box) => box.line === line);
      }
      for (const box of matches) {
        if (box.page > 0 && (first === undefined || box.page < first)) first = box.page;
      }
    }
  }
  return first;
}
