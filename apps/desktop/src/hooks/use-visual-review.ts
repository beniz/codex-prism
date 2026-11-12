import { useEffect, useRef, useState } from "react";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  visualBackend,
  type VisualItem,
  type VisualMetadata,
  type Region,
} from "@/lib/visual-review";
import { loadReviewBlocks } from "@/lib/review-diff-client";
import { mergeVisualItems } from "@/lib/visual-regions";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { createLogger } from "@/lib/debug/logger";
const log = createLogger("visual-review");
export function useVisualReview(main?: string, allowed = true) {
  const configured = useSettingsStore((s) => s.visualChangeReports);
  const enabled = allowed && configured;
  const documentProject = useDocumentStore((s) => s.projectId);
  const project = useAgentChatStore((s) => s.projectId);
  const review = useAgentChatStore((s) => s.review);
  const pdfRevision = useDocumentStore((s) => s.pdfRevision);
  const tracksChanges = enabled && review.changes.length > 0;
  const dirty = useDocumentStore(
    (s) => tracksChanges && s.files.some((file) => file.isDirty),
  );
  const contentGeneration = useDocumentStore((s) =>
    tracksChanges && !dirty ? s.contentGeneration : 0,
  );
  const [metadata, setMetadata] = useState<VisualMetadata>({
    state: "unavailable",
  });
  const [items, setItems] = useState<VisualItem[]>([]);
  const [shown, setShown] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const bytes = useRef<ArrayBuffer | null>(null);
  const docs = useRef<{ before: number; after: number } | null>(null);
  const loadedProject = useRef<string | null>(null);
  const lastOpened = useRef("");
  useEffect(() => {
    const abort = new AbortController();
    let opened: number[] = [];
    let closeDocument: ((id: number) => Promise<void>) | undefined;
    const closeOpened = () => {
      for (const id of opened.splice(0)) void closeDocument?.(id).catch(() => {});
    };
    bytes.current = null;
    docs.current = null;
    setItems([]);
    setMetadata({ state: "preparing" });
    async function prepare() {
      if (!enabled) {
        lastOpened.current = "";
        setShown(false);
        setMetadata({ state: "unavailable" });
        return;
      }
      const changes = review.changes.filter(
        (change) => !change.path.toLowerCase().endsWith(".pdf"),
      );
      if (
        !project ||
        project !== documentProject ||
        review.active ||
        !changes.length
      ) {
        setMetadata({ state: review.active ? "preparing" : "unavailable" });
        return;
      }
      // Unsaved edits cannot match a report's immutable source revision.
      // Hide stale geometry immediately, without reloading PDFs on every key.
      if (dirty) {
        setMetadata({ state: "stale" });
        return;
      }
      const client = getMupdfClient();
      closeDocument = client.closeDocument;
      const started = performance.now();
      const m = await visualBackend.report(project);
      if (abort.signal.aborted) return;
      setMetadata(m);
      if (m.state !== "ready" || m.main !== main || !m.before || !m.after)
        return;
      const beforeBytes = await visualBackend.pdf(project, m.before);
      const afterBytes = await visualBackend.pdf(project, m.after);
      if (abort.signal.aborted) return;
      const before = await client.openDocument(beforeBytes);
      opened.push(before);
      if (abort.signal.aborted) { closeOpened(); return; }
      const after = await client.openDocument(afterBytes.slice(0));
      opened.push(after);
      if (abort.signal.aborted) {
        closeOpened();
        return;
      }
      const mappingStarted = performance.now();
      let cards: VisualItem[] = [];
      for (const change of changes) {
        const blocks =
          change.binary || !change.path.endsWith(".tex")
            ? []
            : await loadReviewBlocks(
                change.oldContent ?? "",
                change.newContent ?? "",
                abort.signal,
              );
        if (!blocks.length) {
          cards.push({
            id: `${m.generation}:${change.path}`,
            reviewRevision: m.generation!,
            beforeArtifact: m.before,
            afterArtifact: m.after,
            path: change.path,
            label: `${change.binary ? "Asset" : "File"} ${change.kind}`,
            ranges: [],
            before: [],
            after: [],
            quality: "unplaced",
          });
          continue;
        }
        for (const block of blocks) {
          if (abort.signal.aborted) return;
          const locate = async (
            artifact: string,
            doc: number,
            range: typeof block.before,
          ): Promise<Region[]> =>
            range
              ? client.reviewRegions(
                  doc,
                  await visualBackend.locations(
                    project!,
                    artifact,
                    change.path,
                    range,
                  ),
                  { signal: abort.signal },
                )
              : [];
          const old = await locate(m.before, before, block.before);
          const current = await locate(
            m.after,
            after,
            block.after ?? block.context,
          );
          const card: VisualItem = {
            id: `${m.generation}:${change.path}:${block.before?.start ?? 0}-${block.before?.end ?? 0}:${block.after?.start ?? 0}-${block.after?.end ?? 0}`,
            reviewRevision: m.generation!,
            beforeArtifact: m.before,
            afterArtifact: m.after,
            path: change.path,
            label: !block.before
              ? "Passage added"
              : !block.after
                ? "Passage deleted"
                : "Passage modified",
            ranges: [block],
            before: old,
            after: current,
            quality: current.length
              ? block.after
                ? "region"
                : "adjacent"
              : "unplaced",
          };
          cards.push(card);
        }
      }
      if (abort.signal.aborted) return;
      cards = mergeVisualItems(cards);
      cards.sort(
        (a, b) =>
          (a.after[0]?.page ?? Infinity) - (b.after[0]?.page ?? Infinity) ||
          (a.after[0]?.y ?? 0) - (b.after[0]?.y ?? 0) ||
          (a.after[0]?.x ?? 0) - (b.after[0]?.x ?? 0) ||
          a.path.localeCompare(b.path),
      );
      const verified = await visualBackend.report(project);
      if (abort.signal.aborted) return;
      if (
        verified.state !== "ready" ||
        verified.generation !== m.generation ||
        verified.after !== m.after
      ) {
        setMetadata(verified);
        return;
      }
      loadedProject.current = project;
      bytes.current = afterBytes;
      docs.current = { before, after };
      setItems(cards);
      const key = `${project}:${m.generation}:${m.after}`;
      if (lastOpened.current !== key) {
        lastOpened.current = key;
        setShown(true);
        setSelected(null);
      }
      log.info("Visual report mapped", {
        durationMs: Math.round(performance.now() - started),
        mappingMs: Math.round(performance.now() - mappingStarted),
        placed: cards.filter((c) => c.quality !== "unplaced").length,
        unplaced: cards.filter((c) => c.quality === "unplaced").length,
      });
    }
    void prepare().catch((e) => {
      closeOpened();
      if (!abort.signal.aborted)
        setMetadata({ state: "unavailable", error: String(e) });
    });
    return () => {
      abort.abort();
      bytes.current = null;
      docs.current = null;
      closeOpened();
    };
  }, [
    enabled,
    project,
    documentProject,
    review,
    main,
    contentGeneration,
    dirty,
    pdfRevision,
  ]);
  // Detect external edits even while no review events arrive; never retain old geometry.
  useEffect(() => {
    if (!enabled || !project || metadata.state !== "ready") return;
    let alive = true;
    const timer = setInterval(() => {
      void visualBackend
        .report(project)
        .then((m) => {
          if (alive && m.state !== "ready") {
            bytes.current = null;
            setItems([]);
            setMetadata(m);
          }
        })
        .catch(() => {});
    }, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, project, metadata.state]);
  return {
    metadata,
    items,
    shown,
    setShown,
    selected,
    setSelected,
    bytes,
    docs,
    active:
      enabled &&
      shown &&
      !review.active &&
      project === documentProject &&
      loadedProject.current === project &&
      metadata.state === "ready" &&
      metadata.main === main &&
      !!bytes.current,
  };
}
