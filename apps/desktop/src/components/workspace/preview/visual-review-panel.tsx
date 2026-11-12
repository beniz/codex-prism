import { useEffect, useRef, useState } from "react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { Region, VisualItem } from "@/lib/visual-review";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { FileReview } from "@/components/agent-chat/proposed-changes-panel";
export function Crop({ doc, region }: { doc: number; region: Region }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setUrl(undefined);
    setError(false);
    let url: string | undefined;
    void getMupdfClient()
      .reviewCrop(doc, region, { signal: abort.signal })
      .then((bytes) => {
        if (!abort.signal.aborted) {
          url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
          setUrl(url);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [doc, region]);
  return url ? (
    <img
      src={url}
      alt={`Rendered region on page ${region.page}`}
      className="max-w-full"
    />
  ) : (
    <span>{error ? "Rendered crop unavailable." : "Loading crop…"}</span>
  );
}
export function VisualReviewPanel({
  items,
  selected,
  onSelect,
  docs,
}: {
  items: VisualItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  docs: { before: number; after: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const changes = useAgentChatStore((s) => s.review.changes);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current
      ?.querySelector(`[data-selected="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  async function resolve(path: string | null, undo: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (path === null) await useAgentChatStore.getState().keepAllReview();
      else await useAgentChatStore.getState().resolveReview(path, undo);
      const failure = useAgentChatStore.getState().error;
      if (failure) throw new Error(failure);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      ref={ref}
      className="h-full overflow-auto p-2 text-xs"
      role="region"
      aria-label="Visual changes"
    >
      {error && <p role="alert">{error}</p>}
      {error?.includes("changed on disk") && (
        <button
          type="button"
          disabled={busy}
          className="mb-2 underline"
          onClick={async () => {
            setBusy(true);
            try {
              await useAgentChatStore.getState().reloadReview();
              setError(useAgentChatStore.getState().error);
            } finally {
              setBusy(false);
            }
          }}
        >
          Reload review from disk
        </button>
      )}
      {(changes.length > 1 || items.length > 1) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void resolve(null, false)}
          className="mb-3 rounded-full bg-green-600 px-3 py-1 font-medium text-white hover:bg-green-700 focus-visible:outline focus-visible:outline-ring disabled:opacity-50"
        >
          Keep all changes
        </button>
      )}
      {items.map((item, index) => (
        <div key={item.id}>
          {item.quality === "unplaced" &&
            (index === 0 || items[index - 1].quality !== "unplaced") && (
              <h3 className="my-3 font-semibold">Unplaced changes</h3>
            )}
          <article
            data-selected={item.id === selected}
            className={`mb-3 rounded border p-3 ${selected === item.id ? "border-primary bg-primary/5" : "border-border bg-background"}`}
          >
            <button
              className="text-left font-semibold"
              onClick={() => onSelect(item.id)}
            >
              {index + 1}. {item.label}
            </button>
            <p className="my-1 break-all text-muted-foreground">{item.path}</p>
            {item.quality === "unplaced" ? (
              <p>Rendered location unavailable.</p>
            ) : (
              <p>
                {item.quality === "adjacent"
                  ? "Marker at surviving context · "
                  : ""}
                Page{" "}
                {Array.from(new Set(item.after.map((r) => r.page))).join(", ")}
              </p>
            )}
            {(["before", "after"] as const).map((side) => (
              <div key={side} className="my-2">
                <strong>{side === "before" ? "Before" : "After"}</strong>
                <p className="whitespace-pre-wrap">
                  {Array.from(new Set(item[side].map((r) => r.text)))
                    .join(" ")
                    .slice(0, 1200) ||
                    (item[side].length
                      ? "See rendered crop."
                      : "No rendered excerpt available.")}
                </p>
              </div>
            ))}
            {(item.before.length > 0 || item.after.length > 0) && (
              <button
                aria-expanded={expanded === item.id}
                onClick={() =>
                  setExpanded(expanded === item.id ? null : item.id)
                }
              >
                {" "}
                {expanded === item.id ? "Hide" : "Show"} rendered crops
              </button>
            )}
            {expanded === item.id &&
              (["before", "after"] as const).map((side) => (
                <div key={side}>
                  <strong>{side === "before" ? "Before" : "After"}</strong>
                  {item[side].map((region, i) => (
                    <details key={i}>
                      <summary>
                        Page {region.page}, region {i + 1}
                      </summary>
                      <LazyCrop doc={docs[side]} region={region} />
                    </details>
                  ))}
                </div>
              ))}
            <div className="mt-3 flex flex-col items-start gap-2">
              <button
                disabled={busy}
                onClick={() => void resolve(item.path, false)}
              >
                Keep all changes in this file
              </button>
              <button
                disabled={busy}
                onClick={() => void resolve(item.path, true)}
              >
                Undo all changes in this file
              </button>
              <button
                aria-expanded={sourcePath === item.path}
                onClick={() =>
                  setSourcePath(sourcePath === item.path ? null : item.path)
                }
              >
                Source diff
              </button>
              {sourcePath === item.path &&
                changes.find((c) => c.path === item.path) && (
                  <FileReview
                    change={changes.find((c) => c.path === item.path)!}
                    expanded={true}
                    toggle={() => setSourcePath(null)}
                    disabled={busy}
                    pending={busy}
                    decide={resolve}
                    showActions={false}
                  />
                )}
            </div>
          </article>
        </div>
      ))}
    </div>
  );
}
function LazyCrop(props: { doc: number; region: Region }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) =>
      setVisible(entries.some((e) => e.isIntersecting)),
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ minHeight: 40 }}>
      {visible && <Crop {...props} />}
    </div>
  );
}
