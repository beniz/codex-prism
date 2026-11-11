// Built-in PDFs are bundled; private PDFs are compiled and cached locally.
import { backend } from "@/lib/backend";
import type { TemplateCatalogItem } from "./template-catalog";
import { renderPdfThumbnail } from "@/lib/mupdf/pdf-thumbnail";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("template-preview");
const listeners = new Set<() => void>();
const thumbnails = new Map<string, string>();
const failed = new Set<string>();
const pendingThumbnails = new Map<string, Promise<string | null>>();
const previews = new Map<string, ArrayBuffer>();
const errors = new Map<string, string>();
interface PreviewJob {
  key: string;
  template: Extract<TemplateCatalogItem, { source: "private" }>;
  retry: boolean;
  resolve(value: ArrayBuffer): void;
  reject(error: unknown): void;
}
const jobs: PreviewJob[] = [];
const pendingPreviews = new Map<string, Promise<ArrayBuffer>>();
let running = false;
const keyFor = (template: TemplateCatalogItem) =>
  template.source === "private"
    ? `${template.id}:${template.revision}`
    : template.id;
const notify = () => {
  for (const fn of listeners) fn();
};

export function subscribeThumbnails(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getThumbnail(
  template: TemplateCatalogItem,
): string | undefined {
  return thumbnails.get(keyFor(template));
}
export function isThumbnailFailed(template: TemplateCatalogItem): boolean {
  return failed.has(keyFor(template));
}
export function getTemplatePdfUrl(templateId: string): string {
  return `/examples/${templateId}/main.pdf`;
}

export function resetPrivatePreviewFailures() {
  for (const key of failed) {
    if (key.startsWith("private:")) failed.delete(key);
  }
  errors.clear();
  notify();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (jobs.length) {
      const job = jobs.shift()!;
      try {
        const result = await backend.templates.preview(
          job.template.id,
          job.template.revision,
          job.retry,
        );
        const bytes = new Uint8Array(result).buffer;
        previews.set(job.key, bytes);
        errors.delete(job.key);
        job.resolve(bytes);
      } catch (error) {
        errors.set(job.key, String(error));
        job.reject(error);
      } finally {
        pendingPreviews.delete(job.key);
      }
    }
  } finally {
    running = false;
  }
}

export async function getTemplatePdfBuffer(
  template: TemplateCatalogItem,
  priority = false,
  retry = false,
): Promise<ArrayBuffer> {
  if (template.source === "builtin") {
    const response = await fetch(getTemplatePdfUrl(template.id));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  }
  const key = keyFor(template);
  const pending = pendingPreviews.get(key);
  if (pending) {
    if (priority) {
      const index = jobs.findIndex((job) => job.key === key);
      if (index > 0) jobs.unshift(...jobs.splice(index, 1));
    }
    return (await pending).slice(0);
  }
  if (retry) {
    previews.delete(key);
    errors.delete(key);
    failed.delete(key);
    const url = thumbnails.get(key);
    if (url) URL.revokeObjectURL(url);
    thumbnails.delete(key);
    notify();
  } else {
    const cached = previews.get(key);
    if (cached) return cached.slice(0);
    const error = errors.get(key);
    if (error) throw new Error(error);
  }
  const promise = new Promise<ArrayBuffer>((resolve, reject) => {
    const job = { key, template, retry, resolve, reject };
    if (priority) jobs.unshift(job);
    else jobs.push(job);
  });
  pendingPreviews.set(key, promise);
  void drain();
  return (await promise).slice(0);
}

export async function generateThumbnail(
  template: TemplateCatalogItem,
): Promise<string | null> {
  const key = keyFor(template);
  const cached = thumbnails.get(key);
  if (cached) return cached;
  if (failed.has(key)) return null;
  const pending = pendingThumbnails.get(key);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const buffer = await getTemplatePdfBuffer(template);
      const url = await renderPdfThumbnail(buffer, 300);
      thumbnails.set(key, url);
      return url;
    } catch (error) {
      log.warn(`Failed to load preview for ${template.id}`, {
        error: String(error),
      });
      failed.add(key);
      return null;
    } finally {
      pendingThumbnails.delete(key);
      notify();
    }
  })();
  pendingThumbnails.set(key, promise);
  return promise;
}
