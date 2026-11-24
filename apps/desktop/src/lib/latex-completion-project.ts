import { backend } from "./backend";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import type {
  IndexQuery,
  IndexResult,
  IndexUpdate,
} from "./latex-completion-index";

// One lazy worker per mounted editor. Send only changed inputs; reads never
// update the revision token used when saving an editable buffer.
export function projectCompletionIndex() {
  let worker: Worker | undefined;
  const known = new Map<string, ProjectFile>();
  let disposed = false;
  let pending: ((result: IndexResult | null) => void) | undefined;
  let tail = Promise.resolve();
  const generation = useDocumentStore.getState().openingGeneration;
  function current(query: IndexQuery) {
    const doc = useDocumentStore.getState();
    return (
      !disposed &&
      doc.openingGeneration === generation &&
      doc.activeFileId === query.active
    );
  }
  async function run(query: IndexQuery, aborted: () => boolean) {
    if (!current(query) || aborted()) return null;
    const files = useDocumentStore.getState().files;
    const paths = new Set<string>();
    const changed: IndexUpdate["changed"] = [];
    for (const file of files) {
      if (!/\.(tex|sty|cls)$/i.test(file.relativePath)) continue;
      paths.add(file.relativePath);
      const previous = known.get(file.relativePath);
      if (
        previous === file ||
        (previous &&
          previous.content === file.content &&
          file.diskToken !== undefined &&
          file.diskToken === previous.diskToken)
      )
        continue;
      let text = file.content;
      if (text === undefined) {
        try {
          const data = await backend.files.read(file.ref);
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(data.bytes),
          );
        } catch {
          continue;
        }
        if (!current(query) || aborted()) return null;
      }
      changed.push({ path: file.relativePath, text });
    }
    const removed = [...known.keys()].filter((path) => !paths.has(path));
    if (!current(query) || aborted()) return null;
    if (!worker) {
      worker = new Worker(
        new URL("./latex-completion.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (event) => pending?.(event.data as IndexResult);
      worker.onerror = () => {
        known.clear();
        worker?.terminate();
        worker = undefined;
        pending?.(null);
      };
    }
    const result = await new Promise<IndexResult | null>((resolve) => {
      pending = resolve;
      worker!.postMessage({ query, changed, removed } satisfies IndexUpdate);
    });
    pending = undefined;
    if (result) {
      for (const path of removed) known.delete(path);
      const updated = new Set(changed.map((f) => f.path));
      for (const file of files)
        if (updated.has(file.relativePath)) known.set(file.relativePath, file);
    }
    return current(query) && !aborted() ? result : null;
  }
  return {
    query(query: IndexQuery, aborted: () => boolean) {
      const work = tail.then(() => run(query, aborted)).catch(() => null);
      tail = work.then(() => {});
      return work;
    },
    destroy() {
      disposed = true;
      worker?.terminate();
      pending?.(null);
      known.clear();
    },
  };
}
