import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import type { ReviewChange } from "@/lib/backend";
import type { ReviewDiffLine } from "@/lib/review-diff";
import { loadReviewDiff } from "@/lib/review-diff-client";
import { cn } from "@/lib/utils";

export function ProposedChangesPanel() {
  const review = useAgentChatStore((s) => s.review);
  const resolve = useAgentChatStore((s) => s.resolveReview);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null | undefined>(
    undefined,
  );
  const expandedPath =
    selected === undefined ? review.changes[0]?.path : selected;
  if (review.active || !review.changes.length) return null;
  const decide = async (path: string, undo: boolean) => {
    if (busy) return;
    setBusy(path);
    try {
      await resolve(path, undo);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      aria-label="Review Codex changes"
      className="max-h-72 shrink-0 overflow-auto border-t"
    >
      {review.changes.map((change) => (
        <FileReview
          key={change.path}
          change={change}
          expanded={expandedPath === change.path}
          toggle={() =>
            setSelected(expandedPath === change.path ? null : change.path)
          }
          disabled={busy !== null}
          pending={busy === change.path}
          decide={decide}
        />
      ))}
    </section>
  );
}

function FileReview({
  change,
  expanded,
  toggle,
  disabled,
  pending,
  decide,
}: {
  change: ReviewChange;
  expanded: boolean;
  toggle: () => void;
  disabled: boolean;
  pending: boolean;
  decide: (path: string, undo: boolean) => Promise<void>;
}) {
  const before = change.oldContent ?? "";
  const after = change.newContent ?? "";
  const [result, setResult] = useState<{
    before: string;
    after: string;
    rows: ReviewDiffLine[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded || change.binary) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    setError(null);
    setScrollTop(0);
    if (viewport.current) viewport.current.scrollTop = 0;
    void loadReviewDiff(before, after, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setResult({ before, after, rows });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(String(error));
      });
    return () => controller.abort();
  }, [expanded, change.binary, before, after]);
  const rows =
    result?.before === before && result.after === after ? result.rows : null;
  const start = Math.max(
    0,
    Math.min(Math.floor(scrollTop / 20) - 5, (rows?.length ?? 1) - 1),
  );
  const visibleRows = rows?.slice(start, start + 24) ?? [];
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40"
      >
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>
          {change.path}
        </span>
        <span>{change.kind}</span>
      </button>
      {expanded &&
        (change.binary ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Binary asset {change.kind}
          </p>
        ) : (
          <div
            ref={viewport}
            className="overflow-auto font-mono text-xs leading-5"
            style={{ maxHeight: 240 }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            aria-label={`Changes to ${change.path}`}
          >
            {error ? (
              <p role="alert" className="px-3 py-2">
                {error}
              </p>
            ) : rows === null ? (
              <p role="status" className="px-3 py-2">
                Loading changes…
              </p>
            ) : rows.length ? (
              <div style={{ height: rows.length * 20, position: "relative" }}>
                <div
                  style={{
                    position: "absolute",
                    top: start * 20,
                    minWidth: "100%",
                  }}
                >
                  {visibleRows.map((row, index) => (
                    <div
                      key={start + index}
                      style={{ height: 20 }}
                      className={cn(
                        "flex min-w-max",
                        row.kind === "removed" &&
                          "bg-red-500/10 text-red-800 dark:text-red-300",
                        row.kind === "added" &&
                          "bg-green-500/10 text-green-800 dark:text-green-300",
                        (row.kind === "context" || row.kind === "gap") &&
                          "text-muted-foreground",
                      )}
                    >
                      <span className="w-12 shrink-0 select-none pr-2 text-right opacity-60">
                        {row.number ?? ""}
                      </span>
                      <span className="w-5 shrink-0 select-none">
                        {row.kind === "added"
                          ? "+"
                          : row.kind === "removed"
                            ? "−"
                            : ""}
                      </span>
                      <span className="whitespace-pre pr-3">
                        {row.text || " "}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="px-3 py-2 text-muted-foreground">
                {change.kind === "modified"
                  ? "File metadata or line endings changed"
                  : `Empty file ${change.kind}`}
              </p>
            )}
          </div>
        ))}
      <div className="sticky bottom-0 flex justify-end bg-background/95 px-3 py-1.5">
        <div
          className="inline-flex items-center rounded-full bg-muted p-0.5 text-xs"
          aria-label={`Review ${change.path}`}
        >
          <button
            type="button"
            disabled={disabled}
            onClick={() => void decide(change.path, true)}
            title={`Undo all changes to ${change.path}`}
            className="rounded-full px-3 py-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline focus-visible:outline-ring disabled:opacity-50"
          >
            Undo
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void decide(change.path, false)}
            title={`Keep all changes to ${change.path}`}
            className="rounded-full bg-green-600 px-3 py-1 font-medium text-white hover:bg-green-700 focus-visible:outline focus-visible:outline-ring disabled:opacity-50"
          >
            {pending ? "…" : "Keep"}
          </button>
        </div>
      </div>
    </div>
  );
}
