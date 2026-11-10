import { backend, invoke } from "@/lib/backend";
import { renderPdfThumbnail } from "@/lib/mupdf/pdf-thumbnail";

export type ProjectPreviewData = { createdAt: number | null } & (
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
const requests = new Map<string, Promise<ProjectPreviewData>>();
let queue: Promise<unknown> = Promise.resolve();

async function thumbnail(projectId: string, path: string, revision: string) {
  const key = JSON.stringify([projectId, path, revision]);
  const task = queue.then(async () => {
    const cached = thumbnails.get(key);
    if (cached) return cached;
    const { bytes } = await backend.files.read({ projectId, path });
    const url = await renderPdfThumbnail(new Uint8Array(bytes).buffer, 420);
    thumbnails.set(key, url);
    while (thumbnails.size > 80) {
      const oldest = thumbnails.keys().next().value!;
      URL.revokeObjectURL(thumbnails.get(oldest)!);
      thumbnails.delete(oldest);
    }
    return url;
  });
  queue = task.catch(() => {});
  return task;
}

/** Re-discover on each visit; only rendered PDFs are cached by their disk revision. */
export function loadProjectPreview(path: string): Promise<ProjectPreviewData> {
  const pending = requests.get(path);
  if (pending) return pending;
  const task = (async (): Promise<ProjectPreviewData> => {
    const project = await backend.projects.register(path);
    const manifest = await invoke<PreviewManifest>("project_service", {
      projectId: project.id,
      operation: "project_preview",
      args: {},
    });
    const createdAt = manifest.createdAt;
    for (const pdf of manifest.pdfs) {
      try {
        return {
          kind: "pdf",
          url: await thumbnail(project.id, pdf.path, pdf.revision),
          createdAt,
        };
      } catch {
        // A broken/incomplete PDF must not hide another usable output.
      }
    }
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
  requests.set(path, task);
  void task.finally(() => requests.delete(path)).catch(() => {});
  return task;
}
