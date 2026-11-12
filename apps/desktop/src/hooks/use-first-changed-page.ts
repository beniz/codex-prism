import { useEffect, useState } from "react";
import type { ChatPdfArtifact } from "./use-chat-pdf";
import { loadFirstChangedPdfPage } from "@/lib/changed-pdf-page-client";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("pdf-change-analysis");
const cache = new Map<string, number | undefined>();
let owner: string | null = null;
let epoch = 0;
export function clearFirstChangedPageCache() {
  owner = null;
  cache.clear();
  epoch++;
}
export interface ChangePageTarget {
  key: string;
  artifactId: string;
  page: number;
}

/** Only the active preview owns analysis. A cached undefined page is a completed no-change result. */
export function useFirstChangedPage(
  artifact: ChatPdfArtifact | undefined,
  project: string | null,
) {
  const [result, setResult] = useState<ChangePageTarget>();
  const key =
    artifact && artifact.proposal.projectId === project
      ? JSON.stringify([
          project,
          artifact.proposal.id,
          artifact.proposal.generation,
          artifact.main,
          artifact.build.artifactId,
        ])
      : undefined;
  useEffect(() => {
    if (owner !== project) {
      clearFirstChangedPageCache();
      owner = project;
    }
    const startedEpoch = epoch;
    const abort = new AbortController();
    if (!key || !artifact) return;
    const publish = (page: number | undefined) => {
      if (abort.signal.aborted || startedEpoch !== epoch) return;
      setResult(
        page === undefined
          ? undefined
          : { key, page, artifactId: artifact.build.artifactId },
      );
    };
    if (cache.has(key)) {
      const page = cache.get(key);
      cache.delete(key);
      cache.set(key, page);
      publish(page);
      return;
    }
    // No PDF data is cloned into the analysis worker.
    const changes = artifact.proposal.changes.filter(
      (c) => !c.binary && c.newContent !== null,
    );
    const files = new Set(changes.map((c) => c.path));
    const locations = artifact.build.locations
      .filter((b) => files.has(b.file))
      .map(({ file, line, page }) => ({ file, line, page }));
    void loadFirstChangedPdfPage({ changes, locations }, abort.signal)
      .then((page) => {
        if (abort.signal.aborted || startedEpoch !== epoch) return;
        cache.set(key, page);
        while (cache.size > 10) cache.delete(cache.keys().next().value!);
        publish(page);
      })
      .catch((error) => {
        if (abort.signal.aborted || startedEpoch !== epoch) return;
        // Optional navigation analysis must never turn a usable PDF into an error page.
        cache.set(key, undefined);
        while (cache.size > 10) cache.delete(cache.keys().next().value!);
        log.warn("Could not locate first PDF change", { error: String(error) });
      });
    return () => abort.abort();
  }, [key, project]); // artifact is immutable for this identity
  return result?.key === key ? result : undefined;
}
