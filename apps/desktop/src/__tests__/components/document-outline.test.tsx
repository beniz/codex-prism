import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DocumentOutline } from "@/components/workspace/document-outline";
import { usePdfNavigationStore } from "@/stores/pdf-navigation-store";
import { useDocumentStore } from "@/stores/document-store";
vi.mock("@/stores/document-store", async () => {
  const { create } = await import("zustand");
  return {
    useDocumentStore: create(() => ({
      activeFileId: "main.tex",
      projectRoot: "/paper",
      files: [
        {
          id: "main.tex",
          type: "tex",
          relativePath: "main.tex",
          content: "\\section{Original}",
        },
      ],
      requestJumpToPosition: vi.fn(),
    })),
  };
});
it("shows headings immediately on open, then updates after typing pauses", () => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const edit = (content: string) =>
    act(() =>
      useDocumentStore.setState({
        files: [{ ...useDocumentStore.getState().files[0], content }],
      }),
    );
  try {
    act(() => root.render(<DocumentOutline />));
    expect(host.textContent).toContain("1Original");
    edit("\\section{First edit}");
    act(() => vi.advanceTimersByTime(249));
    expect(host.textContent).toContain("Original");
    edit("% comment\n\\section{Latest edit}");
    act(() => vi.advanceTimersByTime(249));
    expect(host.textContent).toContain("Original");
    act(() => vi.advanceTimersByTime(1));
    expect(host.textContent).toContain("1Latest edit");
    act(() => host.querySelector("button")!.click());
    expect(
      useDocumentStore.getState().requestJumpToPosition,
    ).toHaveBeenCalledWith(10);
    expect(usePdfNavigationStore.getState().request).toEqual({
      projectRoot: "/paper",
      filePath: "main.tex",
      line: 2,
      sourceLine: "\\section{Latest edit}",
    });
    edit("% slide\n\\begin{frame}[t]{Slide result}\nBody\n\\end{frame}");
    act(() => vi.advanceTimersByTime(250));
    expect(host.textContent).toContain("1Slide result");
    act(() => host.querySelector("button")!.click());
    expect(useDocumentStore.getState().requestJumpToPosition).toHaveBeenLastCalledWith(8);
    expect(usePdfNavigationStore.getState().request).toEqual({
      projectRoot: "/paper", filePath: "main.tex", line: 2,
      sourceLine: "\\begin{frame}[t]{Slide result}",
    });
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});

it("keeps the deck outline when a fragment is active and navigates to another source", () => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const file = (id: string, content: string) => ({ id, name: id, relativePath: id, type: "tex" as const, content });
  const main = file("slides.tex", "\\documentclass{beamer}\n\\begin{document}\n\\input{intro}\n\\input{results}\n\\end{document}");
  const intro = file("intro.tex", "\\begin{frame}{Introduction}\\end{frame}");
  const results = file("results.tex", "% results\n\\begin{frame}{Results}\\end{frame}");
  const setActiveFile = vi.fn((id: string) => useDocumentStore.setState({ activeFileId: id }));
  act(() => useDocumentStore.setState({
    files: [main, intro, results] as any,
    activeFileId: intro.id,
    setActiveFile,
  }));
  try {
    act(() => root.render(<DocumentOutline />));
    expect(host.textContent).toContain("1Introduction2Results");
    act(() => host.querySelectorAll("button")[1].click());
    expect(setActiveFile).toHaveBeenCalledWith("results.tex");
    expect(useDocumentStore.getState().requestJumpToPosition).toHaveBeenLastCalledWith(10);
    expect(usePdfNavigationStore.getState().request).toMatchObject({
      filePath: "results.tex", line: 2, sourceLine: "\\begin{frame}{Results}\\end{frame}",
    });
    act(() => vi.advanceTimersByTime(250));
    expect(host.textContent).toContain("1Introduction2Results");
    // Changes to another file must update the deck while Results stays active.
    act(() => useDocumentStore.setState({ files: [main, { ...intro, content: "\\begin{frame}{Revised}\\end{frame}" }, results] as any }));
    act(() => vi.advanceTimersByTime(250));
    expect(host.textContent).toContain("1Revised2Results");
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
