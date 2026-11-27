import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import { undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { Sidebar } from "../../src/components/workspace/sidebar";
import { LatexEditor } from "../../src/components/workspace/editor/latex-editor";
import { PdfPreview } from "../../src/components/workspace/preview/pdf-preview";
import { useDocumentStore } from "../../src/stores/document-store";
import { useSettingsStore } from "../../src/stores/settings-store";
import "../../src/styles/globals.css";

// No real project or backend: typing must never mutate a user's document.
(window as any).__TAURI_INTERNALS__ = {
  metadata: {
    currentWebview: { label: "main" },
    currentWindow: { label: "main" },
  },
  transformCallback: () => 1,
  invoke: async (command: string) => {
    if (command === "plugin:app|version") return "test";
    if (command === "detect_editors") return [];
    if (command.includes("listen")) return 1;
    throw new Error(`Unavailable in typing fixture: ${command}`);
  },
};
const source =
  "\\documentclass{article}\n\\begin{document}\n" +
  Array.from(
    { length: 300 },
    (_, i) =>
      `\\section{Section ${i}}\n` +
      "A paragraph of ordinary prose with some $x^2$ mathematics.\n".repeat(12),
  ).join("") +
  "\\end{document}\n";
useDocumentStore.setState({
  projectRoot: null,
  activeFileId: "main.tex",
  files: [
    {
      id: "main.tex",
      name: "main.tex",
      relativePath: "main.tex",
      type: "tex",
      ref: { projectId: "fixture", path: "main.tex" },
      content: source,
      isDirty: false,
    },
  ],
  initialized: true,
  saveAllFiles: async () => {},
  refreshFiles: async () => {},
});
useSettingsStore.setState({ autoRecompile: false, visualChangeReports: false });
const withPdf = new URLSearchParams(location.search).has("pdf");
if (withPdf)
  useDocumentStore
    .getState()
    .setPdfData(
      new Uint8Array(await (await fetch("./fixture.pdf")).arrayBuffer()),
      "main.tex",
    );
const renders: Record<string, number[]> = {};
function record(id: string, _phase: string, duration: number) {
  (renders[id] ??= []).push(duration);
}
(window as any).typingSmoke = {
  async run() {
    for (const key of Object.keys(renders)) delete renders[key];
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor")!)!;
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      view.dispatch({
        changes: { from: 60, insert: "x" },
        selection: { anchor: 61 },
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      times.push(performance.now() - start);
      if (
        useDocumentStore.getState().files[0].content !==
        view.state.doc.toString()
      )
        throw new Error("Document store lost an edit");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const typed = view.state.doc.toString();
    if (typed.length !== source.length + 40)
      throw new Error("Missing typed characters");
    if (!undo(view) || view.state.doc.toString() === typed)
      throw new Error("Undo failed");
    if (!redo(view) || view.state.doc.toString() !== typed)
      throw new Error("Redo failed");
    if (useDocumentStore.getState().files[0].content !== typed)
      throw new Error("Undo/redo not synchronized");
    const pages = document.querySelectorAll(".mupdf-page").length;
    if (withPdf && !pages) throw new Error("PDF was not displayed");
    const sorted = [...times].sort((a, b) => a - b);
    const beforeReload = useDocumentStore.getState().contentGeneration;
    const replacement = typed + "% external reload\n";
    useDocumentStore.setState(state => ({
      files: state.files.map(file => ({ ...file, content: replacement, isDirty: false })),
    }));
    await Promise.resolve();
    if (view.state.doc.toString() !== replacement ||
        useDocumentStore.getState().contentGeneration !== beforeReload ||
        useDocumentStore.getState().files[0].isDirty)
      throw new Error("External reload was lost or treated as a new edit");
    return {
      characters: source.length,
      pages,
      edits: times.length,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxMs: sorted.at(-1),
      renderMs: Object.fromEntries(
        Object.entries(renders).map(([id, samples]) => [
          id,
          samples.reduce((a, b) => a + b, 0),
        ]),
      ),
      synchronized: true,
      undoRedo: true,
    };
  },
};
createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", height: "100vh" }}>
    <div style={{ width: 260 }}>
      <Profiler id="sidebar" onRender={record}>
        <Sidebar />
      </Profiler>
    </div>
    <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
      <Profiler id="editor" onRender={record}>
        <LatexEditor />
      </Profiler>
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <Profiler id="pdf" onRender={record}>
        <PdfPreview />
      </Profiler>
    </div>
  </div>,
);

(window as any).typingSmoke.pdfStress = async () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (test: () => boolean) => {
    const deadline = performance.now() + 15_000;
    while (!test()) {
      if (performance.now() > deadline)
        throw new Error("PDF render did not finish");
      await sleep(50);
    }
  };
  await waitFor(() => !!document.querySelector(".mupdf-page canvas"));
  const pages = Array.from(
    document.querySelectorAll<HTMLElement>(".mupdf-page"),
  );
  const viewer = pages[0].parentElement!.parentElement!;
  const firstCanvas = pages[0].querySelector("canvas")!;
  await waitFor(() => firstCanvas.width > 0);
  const rect = viewer.getBoundingClientRect();
  // A burst must update layout once per animation frame, then rasterize only
  // the latest zoom. 400% display zoom still has a bounded bitmap allocation.
  for (let i = 0; i < 40; i++)
    viewer.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
        clientX: rect.left + 80,
        clientY: rect.top + 80,
      }),
    );
  await sleep(700);
  let peakPixels = 0;
  for (const index of [0, Math.floor(pages.length / 2), pages.length - 1, 0]) {
    pages[index].scrollIntoView({ block: "start" });
    const canvas = pages[index].querySelector("canvas")!;
    await waitFor(() => canvas.width > 0);
    await sleep(500);
    const canvases = pages.map((p) => p.querySelector("canvas")!);
    for (const bitmap of canvases) {
      if (bitmap.width * bitmap.height > 4_020_000)
        throw new Error("Unbounded page bitmap");
    }
    peakPixels = Math.max(
      peakPixels,
      canvases.reduce((n, c) => n + c.width * c.height, 0),
    );
    if (index === pages.length - 1 && firstCanvas.width !== 0)
      throw new Error("Offscreen bitmap retained");
  }
  return {
    pdfStress: true,
    pages: pages.length,
    peakRasterMiB: Math.round((peakPixels * 4) / 1024 / 1024),
    offscreenReleased: true,
  };
};
