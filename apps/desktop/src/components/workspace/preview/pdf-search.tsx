import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type KeyboardEventHandler,
} from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { Rect } from "@/lib/mupdf/types";

export interface PdfMatch {
  docId: number;
  page: number;
  boxes: Rect[];
}

export function PdfSearch({
  docId,
  pages,
  ownerId,
  inputRef,
  onMatch,
  onClose,
  onShortcut,
}: {
  docId: number;
  pages: number;
  ownerId?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onMatch: (match: PdfMatch | undefined) => void;
  onClose: () => void;
  onShortcut: KeyboardEventHandler;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = useRef<PdfMatch[]>([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const needle = query.trim();
    matches.current = [];
    setCount(0);
    setIndex(0);
    onMatch(undefined);
    setStatus(needle ? "Searching…" : "");
    const timer = setTimeout(async () => {
      if (!docId || !needle) return;
      try {
        for (let page = 1; page <= pages; page++) {
          const hits = await getMupdfClient().searchPage(
            docId,
            page - 1,
            needle,
            {
              ownerId,
              priority: "background",
              signal,
            },
          );
          if (signal.aborted) return;
          const first = matches.current.length === 0;
          for (const boxes of hits)
            matches.current.push({ docId, page, boxes });
          if (hits.length) {
            setCount(matches.current.length);
            if (first) onMatch(matches.current[0]);
          }
        }
        setStatus(matches.current.length ? "" : "No matches");
      } catch {
        if (!signal.aborted) setStatus("Search failed");
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, docId, pages, ownerId, onMatch]);

  function step(direction: number) {
    if (!count) return;
    const next = (index + direction + count) % count;
    setIndex(next);
    onMatch(matches.current[next]);
  }

  return (
    <div
      role="search"
      aria-label="PDF search"
      className="flex flex-wrap items-center gap-2 border-b bg-background px-2 py-1 text-xs"
      onKeyDown={(e) => {
        onShortcut(e);
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        if (
          e.key === "Enter" &&
          !e.nativeEvent.isComposing &&
          e.target === inputRef.current
        ) {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }
      }}
    >
      <input
        ref={inputRef}
        aria-label="Find in PDF"
        placeholder="Find in PDF"
        className="w-32 min-w-16 flex-1 rounded border bg-background px-2 py-1"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <span role="status">
        {[count && `${index + 1} of ${count}`, status]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <button
        aria-label="Previous match"
        disabled={!count}
        onClick={() => step(-1)}
      >
        <ChevronUp size={16} />
      </button>
      <button aria-label="Next match" disabled={!count} onClick={() => step(1)}>
        <ChevronDown size={16} />
      </button>
      <button aria-label="Close PDF search" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
