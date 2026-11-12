import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PdfViewer } from "../../src/components/workspace/preview/pdf-viewer";
import { getMupdfClient } from "../../src/lib/mupdf/mupdf-client";
import { pdf } from "./fixture";
import "../../src/styles/globals.css";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stage = "initial render";
async function until(test: () => boolean) {
  for (let i = 0; i < 700; i++) {
    if (test()) return;
    await pause(20);
  }
  throw new Error(
    `Timed out during ${stage}: ${JSON.stringify(sent.slice(-8))}; visibility ${document.visibilityState}; bounds ${JSON.stringify([...document.querySelectorAll("[data-chat], .overflow-auto, .mupdf-page")].slice(0, 4).map((c) => c.getBoundingClientRect().toJSON()))}; canvases ${[...document.querySelectorAll("canvas")].map((c) => c.width).join(",")}`,
  );
}
const sent: {
  worker: number;
  method: string;
  args: any[];
  id: number;
  at: number;
  done?: number;
}[] = [];
const NativeWorker = window.Worker;
let workerCount = 0;
window.Worker = class extends NativeWorker {
  workerId = ++workerCount;
  constructor(url: URL | string, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener("message", (event) => {
      const row = sent.find(
        (r) => r.worker === this.workerId && r.id === event.data[1],
      );
      if (row) row.done = performance.now();
    });
  }
  postMessage(message: any, options?: any) {
    if (Array.isArray(message))
      sent.push({
        worker: this.workerId,
        method: message[0],
        id: message[1],
        args: message[2],
        at: performance.now(),
      });
    super.postMessage(message, options);
  }
};
const bytes = { a: pdf(40, false, "CHAT A"), b: pdf(3, false, "CHAT B") };
let select: (tab: "a" | "b") => void;
let zoom: (value: number) => void;
const singleViewer = new URLSearchParams(location.search).has("single");
function App() {
  const [tab, setTab] = useState<"a" | "b">("a");
  const [scale, setScale] = useState(1);
  select = setTab;
  zoom = setScale;
  return (
    <div className="relative h-screen">
      {(singleViewer ? [tab] : (["a", "b"] as const)).map((id) => (
        <div
          key={singleViewer ? "active" : id}
          data-chat={id}
          className={`absolute inset-0 flex ${tab === id ? "" : "invisible pointer-events-none"}`}
        >
          <PdfViewer
            data={bytes[id]}
            artifactId={id}
            rootFileId={id}
            documentScope="smoke"
            ownerId={`chat-${id}`}
            scale={id === "b" ? scale : 1}
            isActive={id === tab}
          />
        </div>
      ))}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
const targetDpi = 144 * (window.devicePixelRatio || 1);
const canvas = (chat: string) =>
  document.querySelector<HTMLCanvasElement>(`[data-chat="${chat}"] canvas`)!;
(window as any).runSmoke = async () => {
  await until(
    () => canvas("a")?.width === 595 * (window.devicePixelRatio || 1),
  );
  await pause(500);
  stage = "warm B";
  select("b");
  await until(
    () => canvas("b")?.width === 595 * (window.devicePixelRatio || 1),
  );
  await pause(500);
  stage = "warm A";
  select("a");
  await until(
    () => canvas("a")?.width === 595 * (window.devicePixelRatio || 1),
  );
  await pause(500);
  const client = getMupdfClient();
  const heavy = await client.openDocument(pdf(1, true), undefined, {
    priority: "foreground",
    ownerId: "chat-a",
  });
  stage = "heavy render dispatch";
  const heavyRun = client.drawPage(heavy, 0, 111, {
    priority: "foreground",
    ownerId: "chat-a",
  });
  await until(() =>
    sent.some((r) => r.method === "drawPage" && r.args[2] === 111),
  );
  const heavyRow = sent.find(
    (r) => r.method === "drawPage" && r.args[2] === 111,
  )!;
  const start = performance.now();
  stage = "new B render";
  select("b");
  zoom(2);
  await until(() =>
    sent.some(
      (r) => r.method === "drawPage" && r.args[2] === targetDpi && r.done,
    ),
  );
  const other = sent.find(
    (r) => r.method === "drawPage" && r.args[2] === targetDpi && r.done,
  )!;
  if (
    other.worker === heavyRow.worker ||
    (heavyRow.done && other.done! >= heavyRow.done)
  )
    throw new Error("New chat waited for the busy worker");
  await until(
    () => canvas("b")?.width === 1190 * (window.devicePixelRatio || 1),
  );
  const uncachedSwitchMs = performance.now() - start;
  await heavyRun;
  await client.closeDocument(heavy);
  await pause(500);
  const counts = () => sent.filter((r) => r.method === "drawPage").length;
  // Warm both final resolutions, then measure repeated returns.
  stage = "warm A";
  select("a");
  await until(
    () => canvas("a")?.width === 595 * (window.devicePixelRatio || 1),
  );
  await pause(500);
  stage = "warm B";
  select("b");
  await until(
    () => canvas("b")?.width === 1190 * (window.devicePixelRatio || 1),
  );
  await pause(500);
  const before = counts();
  const switches: number[] = [];
  for (const tab of ["a", "b", "a", "b"] as const) {
    const start = performance.now();
    stage = `cached ${tab}`;
    select(tab);
    await until(
      () =>
        canvas(tab)?.width ===
        (tab === "b" ? 1190 : 595) * (window.devicePixelRatio || 1),
    );
    switches.push(performance.now() - start);
    await pause(100);
  }
  if (counts() !== before)
    throw new Error(
      `Cached chat switches rerendered: ${JSON.stringify(sent.filter((r) => r.method === "drawPage").slice(before))}`,
    );
  if (workerCount !== 2)
    throw new Error(`Unexpected worker count ${workerCount}`);
  return {
    ok: true,
    workers: workerCount,
    singleViewer,
    newChatFinishedBeforeBusyWorker: true,
    cachedSwitchRenders: counts() - before,
    cachedSwitchMs: switches,
    uncachedSwitchMs,
    note: "Synthetic WebKit timings; cache retains only exact document/resolution matches",
  };
};
