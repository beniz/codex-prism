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
  let selectedBibs = new Set<string>();
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
  async function run(
    query: IndexQuery,
    aborted: () => boolean,
    resolving = true,
  ): Promise<IndexResult | null> {
    if (!current(query) || aborted()) return null;
    const files = useDocumentStore.getState().files;
    const bibPaths = files
      .filter((f) => f.type === "bib")
      .map((f) => f.relativePath);
    const paths = new Set<string>();
    const changed: IndexUpdate["changed"] = [];
    for (const file of files) {
      paths.add(file.relativePath);
      if (
        !/\.(tex|sty|cls)$/i.test(file.relativePath) &&
        !(query.kind === "citations" && selectedBibs.has(file.relativePath))
      )
        continue;
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
          paths.delete(file.relativePath);
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
      worker!.postMessage({
        query,
        changed,
        removed,
        bibPaths,
      } satisfies IndexUpdate);
    });
    pending = undefined;
    if (result) {
      for (const path of removed) known.delete(path);
      const updated = new Set(changed.map((f) => f.path));
      for (const file of files)
        if (updated.has(file.relativePath)) known.set(file.relativePath, file);
    }
    if (!current(query) || aborted()) return null;
    // A refresh can replace sources while disk or worker requests are pending.
    // The next keystroke will pick up the new revisions.
    const latest = useDocumentStore.getState().files;
    if (
      latest !== files &&
      (latest.length !== files.length ||
        latest.some((file, i) => file !== files[i] && file.id !== query.active))
    )
      return null;
    if (result?.bibliographies) {
      const missing = result.bibliographies.some(
        (path) => !selectedBibs.has(path),
      );
      selectedBibs = new Set(result.bibliographies);
      if (missing && resolving) return run(query, aborted, false);
    }
    return result;
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
