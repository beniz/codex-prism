import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PdfViewer } from "../../src/components/workspace/preview/pdf-viewer";
import { getMupdfClient } from "../../src/lib/mupdf/mupdf-client";
import { loadFirstChangedPdfPage } from "../../src/lib/changed-pdf-page-client";
import { useFirstChangedPage } from "../../src/hooks/use-first-changed-page";
import type { ChatPdfArtifact } from "../../src/hooks/use-chat-pdf";
import "../../src/styles/globals.css";

// All inputs are generated here. No user files, backend processes, or agent sessions.
function pdf(pages: number, heavy = false): ArrayBuffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const children: string[] = [];
  for (let i = 0; i < pages; i++) {
    const id = objects.length + 1;
    children.push(`${id} 0 R`);
    let stream =
      "BT /F1 12 Tf 40 800 Td " +
      Array.from(
        { length: 45 },
        (_, j) => `(Page ${i + 1}, scientific text line ${j}) Tj 0 -16 Td\n`,
      ).join("") +
      "ET\n";
    if (heavy)
      stream +=
        "0.2 w\n" +
        Array.from(
          { length: 70000 },
          (_, j) => `${j % 550} ${(j * 17) % 780} 12 12 re S\n`,
        ).join("");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${children.join(" ")}] >>`;
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const start = text.length;
  text +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(text).buffer;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(test: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (test()) return;
    await pause(20);
  }
  throw new Error("Timed out waiting for preview");
}
const dispatched: any[] = [];
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  postMessage(message: any, options?: any) {
    if (Array.isArray(message)) dispatched.push(message);
    super.postMessage(message, options);
  }
};
const data = pdf(200);
const shown: string[] = [];
let changeArtifact: (artifact: ChatPdfArtifact | undefined) => void;
let changeScale: (scale: number) => void;
function App() {
  const [artifact, setArtifact] = useState<ChatPdfArtifact>();
  const [scale, setScale] = useState(1);
  changeArtifact = setArtifact;
  changeScale = setScale;
  const target = useFirstChangedPage(artifact, "smoke");
  return (
    <div className="flex h-screen">
      <PdfViewer
        data={data}
        artifactId={artifact?.build.artifactId ?? "main"}
        scale={scale}
        onScaleChange={setScale}
        changePageTarget={target}
        onChangePageShown={(key) => shown.push(key)}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
(window as any).runSmoke = async () => {
  await until(
    () => !!document.querySelector<HTMLCanvasElement>("canvas")?.width,
  );
  const client = getMupdfClient();
  const heavy = await client.openDocument(pdf(1, true));
  const runningAbort = new AbortController();
  const running = client
    .drawPage(heavy, 0, 110, { signal: runningAbort.signal })
    .catch((e) => e.name);
  // Allow preceding viewer jobs to drain and the heavy request to start.
  await until(() =>
    dispatched.some((m) => m[0] === "drawPage" && m[2][0] === heavy),
  );
  const cancelled = Array.from({ length: 100 }, () => {
    const abort = new AbortController();
    const promise = client
      .drawPage(heavy, 0, 72, { signal: abort.signal })
      .catch((e) => e.name);
    abort.abort();
    return promise;
  });
  runningAbort.abort();
  const mandatory = client.closeDocument(heavy);
  if (
    (await running) !== "AbortError" ||
    (await Promise.all(cancelled)).some((v) => v !== "AbortError")
  )
    throw new Error("Cancellation lost");
  await mandatory;
  const draws = dispatched.filter(
    (m) => m[0] === "drawPage" && m[2][0] === heavy,
  ).length;
  if (draws !== 1)
    throw new Error(`Obsolete requests reached worker: ${draws}`);

  const changes = [
    {
      path: "main.tex",
      kind: "modified" as const,
      binary: false,
      oldContent: Array.from(
        { length: 5000 },
        (_, i) =>
          `\\paragraph{Item ${i}} Scientific observations and results ${i}`,
      ).join("\n"),
      newContent: Array.from(
        { length: 5000 },
        (_, i) =>
          `\\paragraph{Item ${i}} ${i >= 200 && i % 17 === 0 ? "Revised interpretation and conclusions" : "Scientific observations and results"} ${i}`,
      ).join("\n"),
    },
  ];
  const locations = Array.from({ length: 5000 }, (_, i) => ({
    file: "main.tex",
    line: i + 1,
    page: Math.floor(i / 40) + 1,
  }));
  const gaps: number[] = [];
  let measuring = true;
  let last = performance.now();
  const frame = (now: number) => {
    gaps.push(now - last);
    last = now;
    if (measuring) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const started = performance.now();
  const page = await loadFirstChangedPdfPage(
    { changes, locations },
    new AbortController().signal,
  );
  const analysisMs = performance.now() - started;
  measuring = false;
  if (page !== 6) throw new Error(`Unexpected changed page ${page}`);
  const artifact = (id: string) =>
    ({
      proposal: { id, projectId: "smoke", generation: 1, changes },
      main: "main.tex",
      build: { artifactId: id, locations },
      bytes: new Uint8Array(data),
    }) as unknown as ChatPdfArtifact;
  changeArtifact(artifact("a"));
  await pause(50);
  changeArtifact(artifact("b"));
  const scroller = document.querySelector<HTMLElement>(".overflow-auto")!;
  scroller.scrollTop = 100;
  await until(() => shown.length > 0);
  if (
    shown.length !== 1 ||
    !shown[0].includes('"b"') ||
    scroller.scrollTop < 4000
  )
    throw new Error(
      "Late navigation targeted wrong build or did not override scroll",
    );
  const scrollGaps: number[] = [];
  let previous = performance.now();
  for (let i = 0; i < 40; i++) {
    scroller.scrollTop = i * 1800;
    changeScale(0.8 + (i % 3) * 0.2);
    await pause(25);
    const now = performance.now();
    scrollGaps.push(now - previous);
    previous = now;
  }
  await pause(500);
  if (shown.length !== 1) throw new Error("Repeated first-change jump");
  return {
    ok: true,
    queuedRendersCancelled: 100,
    heavyRendersDispatched: draws,
    analysisMs,
    analysisMaxFrameGapMs: Math.max(...gaps),
    scrollingMaxTickGapMs: Math.max(...scrollGaps),
    navigationCount: shown.length,
    note: "Synthetic WebKit fixture; no native wheel-latency claim",
  };
};
