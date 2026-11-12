import { backend, invoke } from "@/lib/backend";
import { renderPdfThumbnail } from "@/lib/mupdf/pdf-thumbnail";

export type ProjectPreviewData = {
  createdAt: number | null;
  warning?: string;
} & (
  | { kind: "pdf"; url: string }
  | { kind: "tex"; fileName: string; lines: string[] }
  | { kind: "empty" }
);
interface PreviewManifest {
  createdAt: number | null;
  pdfs: { path: string; revision: string }[];
  texFiles: string[];
}
const thumbnails = new Map<string, string>();
const displayed = new Map<string, number>();
export function retainProjectPreview(url: string) {
  displayed.set(url, (displayed.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (displayed.get(url) ?? 1) - 1;
    if (count) displayed.set(url, count);
    else displayed.delete(url);
    trim();
  };
}
function trim(protectedKey?: string) {
  while (thumbnails.size > 80) {
    const victim = [...thumbnails].find(
      ([key, url]) => key !== protectedKey && !displayed.has(url),
    );
    if (!victim) break;
    thumbnails.delete(victim[0]);
    URL.revokeObjectURL(victim[1]);
  }
}
const requests = new Map<
  string,
  { task: Promise<ProjectPreviewData>; consumers: Set<AbortSignal | undefined> }
>();
let queue: Promise<unknown> = Promise.resolve();
let discovering = 0;
const waiting: (() => void)[] = [];
async function discover<T>(run: () => Promise<T>): Promise<T> {
  if (discovering >= 2)
    await new Promise<void>((resolve) => waiting.push(resolve));
  else discovering++;
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else discovering--;
  }
}

async function thumbnail(
  projectId: string,
  path: string,
  revision: string,
  root: string,
  candidates: PreviewManifest["pdfs"],
  check: () => void,
) {
  const key = JSON.stringify([projectId, path, revision]);
  const hit = thumbnails.get(key);
  if (hit) return hit;
  const task = queue.then(async () => {
    check();
    const cached = thumbnails.get(key);
    if (cached) return cached;
    const { bytes } = await backend.files.read({ projectId, path });
    check();
    const url = await renderPdfThumbnail(new Uint8Array(bytes).buffer, 420);
    try {
      check();
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    thumbnails.set(key, url);
    try {
      const png = [...new Uint8Array(await (await fetch(url)).arrayBuffer())];
      await cacheRequest("put", root, projectId, {
        pdf: path,
        revision,
        bytes: png,
        candidates,
      });
    } catch {
      /* Persistence is optional; keep the rendered preview. */
    }
    trim(key);
    return url;
  });
  queue = task.catch(() => {});
  return task;
}

/** Re-discover on each visit; only rendered PDFs are cached by their disk revision. */
export function loadProjectPreview(
  path: string,
  signal?: AbortSignal,
): Promise<ProjectPreviewData> {
  const pending = requests.get(path);
  if (pending) {
    pending.consumers.add(signal);
    return pending.task;
  }
  const consumers = new Set([signal]);
  const check = () => {
    if (![...consumers].some((signal) => !signal?.aborted))
      throw new DOMException("Preview no longer needed", "AbortError");
  };
  const task = (async (): Promise<ProjectPreviewData> => {
    check();
    const project = await backend.projects.register(path);
    const manifest = await discover(() => {
      check();
      return invoke<PreviewManifest>("project_service", {
        projectId: project.id,
        operation: "project_preview",
        args: {},
      });
    });
    const createdAt = manifest.createdAt;
    for (const pdf of manifest.pdfs) {
      try {
        return {
          kind: "pdf",
          url: await thumbnail(
            project.id,
            pdf.path,
            pdf.revision,
            path,
            manifest.pdfs,
            check,
          ),
          createdAt,
        };
      } catch {
        check();
        // A broken/incomplete PDF must not hide another usable output.
      }
    }
    check();
    await cacheRequest("delete", path).catch(() => {});
    for (const file of manifest.texFiles) {
      try {
        const { bytes } = await backend.files.read({
          projectId: project.id,
          path: file,
        });
        const lines = new TextDecoder()
          .decode(new Uint8Array(bytes))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 12)
          .map((line) => (line.length > 70 ? `${line.slice(0, 67)}...` : line));
        return {
          kind: "tex",
          fileName: file.split("/").pop()!,
          lines,
          createdAt,
        };
      } catch {
        /* Try the next source file. */
      }
    }
    return { kind: "empty", createdAt };
  })();
  requests.set(path, { task, consumers });
  void task.finally(() => requests.delete(path)).catch(() => {});
  return task;
}

interface CachedPreview {
  projectId: string;
  pdf: string;
  revision: string;
  bytes: number[];
  createdAt: number | null;
}
function cacheRequest<T>(
  action: "get" | "put" | "delete",
  root: string,
  projectId = "",
  extra = {},
): Promise<T> {
  return invoke<T>("project_service", {
    projectId,
    operation: `thumbnail_cache_${action}`,
    args: { root, ...extra },
  });
}
export async function loadSavedProjectPreview(
  root: string,
): Promise<ProjectPreviewData | null> {
  try {
    const saved = await cacheRequest<CachedPreview | null>("get", root);
    if (!saved || !Array.isArray(saved.bytes)) return null;
    const key = JSON.stringify([saved.projectId, saved.pdf, saved.revision]);
    let url = thumbnails.get(key);
    if (!url) {
      url = URL.createObjectURL(
        new Blob([new Uint8Array(saved.bytes)], { type: "image/png" }),
      );
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
      } catch {
        URL.revokeObjectURL(url);
        await cacheRequest("delete", root).catch(() => {});
        return null;
      }
      thumbnails.set(key, url);
      trim(key);
    }
    return { kind: "pdf", url, createdAt: saved.createdAt };
  } catch {
    return null;
  }
}
