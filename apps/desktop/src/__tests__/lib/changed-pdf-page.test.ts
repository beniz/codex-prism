import { expect, it } from "vitest";
import { firstChangedPdfPage } from "@/lib/changed-pdf-page";
import type { ReviewChange } from "@/lib/backend";
const change = (path: string, oldContent: string, newContent: string): ReviewChange => ({ path, oldContent, newContent, kind: "modified", binary: false });
const box = (file: string, line: number, page: number) => ({ file, line, page, x: 0, y: 0, w: 10, h: 10 });
it("chooses the earliest PDF page, independently of file and location order", () => {
  expect(firstChangedPdfPage([
    change("later.tex", "old", "new"),
    change("main.tex", "unchanged\nold\nend", "unchanged\nnew\nend"),
  ], [box("later.tex", 1, 8), box("main.tex", 2, 5), box("main.tex", 2, 3), box("main.tex", 1, 1)])).toBe(3);
});
it("maps a paragraph to its closing source line when no exact box exists", () => {
  expect(firstChangedPdfPage([change("main.tex", "same\nold\nend", "same\nnew\nend")], [box("main.tex", 1, 1), box("main.tex", 3, 4)])).toBe(4);
});
it("uses surrounding text for deletions, including the start of the file", () => {
  expect(firstChangedPdfPage([change("main.tex", "same\nremoved\nend", "same\nend")], [box("main.tex", 1, 4)])).toBe(4);
  expect(firstChangedPdfPage([change("main.tex", "removed\nend", "end")], [box("main.tex", 1, 2)])).toBe(2);
});
it("does not guess pages for binary changes, deleted files or unmapped sources", () => {
  expect(firstChangedPdfPage([
    { ...change("figure.png", "old", "new"), binary: true },
    { ...change("deleted.tex", "old", ""), newContent: null, kind: "deleted" },
    change("other.tex", "old", "new"),
  ], [box("main.tex", 1, 1)])).toBeUndefined();
});
it("does not navigate for unchanged text", () => {
  expect(firstChangedPdfPage([change("main.tex", "same", "same")], [box("main.tex", 1, 1)])).toBeUndefined();
});
