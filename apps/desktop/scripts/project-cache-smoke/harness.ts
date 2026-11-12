import {
  loadProjectPreview,
  loadSavedProjectPreview,
} from "../../src/lib/project-preview";
import { getMupdfClient } from "../../src/lib/mupdf/mupdf-client";
import { pdf } from "../pdf-pool-smoke/fixture";

let workers = 0;
let reads = 0;
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: URL | string, options?: WorkerOptions) {
    super(url, options);
    workers++;
  }
};
const manifest = {
  createdAt: 1000,
  pdfs: [{ path: "main.pdf", revision: "1" }],
  texFiles: [],
};
// Transport fixture only: actual Rust persistence is exercised by core tests.
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (command: string, request: any) => {
    if (command === "project_register")
      return { id: request.root, root: request.root };
    if (command === "project_read") {
      reads++;
      return { bytes: [...new Uint8Array(pdf(1))] };
    }
    const key = "thumbnail-smoke:" + request.args.root;
    switch (request.operation) {
      case "project_preview":
        return manifest;
      case "thumbnail_cache_get":
        return JSON.parse(localStorage.getItem(key) || "null");
      case "thumbnail_cache_put":
        localStorage.setItem(
          key,
          JSON.stringify({
            ...request.args,
            projectId: request.projectId,
            createdAt: 1000,
          }),
        );
        return null;
      case "thumbnail_cache_delete":
        localStorage.removeItem(key);
        return null;
      default:
        throw new Error(command);
    }
  },
};
(window as any).runSmoke = async () => {
  const warm = location.search.includes("warm");
  if (!warm)
    for (const key of Object.keys(localStorage))
      if (key.startsWith("thumbnail-smoke:")) localStorage.removeItem(key);
  const release = getMupdfClient().retainWorkers();
  for (const root of ["project-a", "project-b"]) {
    const saved = await loadSavedProjectPreview(root);
    if (warm && !saved) throw new Error("Missing persisted thumbnail");
    const result = await loadProjectPreview(root);
    if (result.kind !== "pdf") throw new Error("Missing PDF");
    const image = new Image();
    image.src = result.url;
    image.style.width = "240px";
    document.body.append(image);
    await image.decode();
  }
  release();
  if (warm ? workers !== 0 || reads !== 0 : workers !== 1 || reads !== 2) {
    throw new Error(JSON.stringify({ warm, workers, reads }));
  }
  if (!warm) {
    location.href = location.pathname + "?warm";
    return null;
  }
  return {
    ok: true,
    warmWorkers: workers,
    warmPdfReads: reads,
    coldWorkers: 1,
  };
};
