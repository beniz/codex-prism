import { useEffect, useRef, useState, type ReactNode } from "react";

import { collaboration } from "@/lib/collaboration";
import { openExternal } from "@/lib/backend/desktop-host";
import { Button } from "@/components/ui/button";

import { PdfViewer } from "./workspace/preview/pdf-viewer";

type Kind = "branches" | "pulls";
interface Entry {
  name: string;
  sha: string;
  base: string;
  author?: string;
  number?: number;
  draft?: boolean;
  link?: string;
}
interface Review {
  id: string;
  sha: string;
  baseSha: string;
  base: string;
  entry: Entry;
  diff: string;
  sources: Record<string, string>;
}
interface Box {
  file: string;
  line: number;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Build {
  artifactId: string;
  pdf: ArrayBuffer;
  locations: Box[];
  main: string;
}
const title = (e: Entry) => (e.number ? `PR #${e.number} · ${e.name}` : e.name);

export function RemoteWork({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const [kind, setKind] = useState<Kind>("branches");
  const [rows, setRows] = useState<Entry[]>([]);
  const [page, setPage] = useState(1);
  const [review, setReview] = useState<Review | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [main, setMain] = useState("");
  const [file, setFile] = useState("");
  const [pane, setPane] = useState<"diff" | "source">("diff");
  const [build, setBuild] = useState<Build | null>(null);
  const [scale, setScale] = useState(1);
  const [line, setLine] = useState(0);
  const [target, setTarget] = useState<Box | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const owned = useRef("");
  const source = useRef<HTMLPreElement>(null);
  const closeSession = (id: string) => {
    if (id)
      void collaboration(projectId, "remote_work_close", { id }).catch(
        () => {},
      );
  };
  useEffect(
    () => () => {
      epoch.current++;
      closeSession(owned.current);
    },
    [projectId],
  );
  useEffect(() => {
    source.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [line, file, pane]);
  function begin(message: string) {
    setBusy(message);
    setError("");
    return ++epoch.current;
  }
  function failed(n: number, e: unknown) {
    if (n === epoch.current) setError(String(e));
  }
  function finish(n: number) {
    if (n === epoch.current) setBusy("");
  }
  async function list(k: Kind, p = 1) {
    const n = begin("Reading remote work…");
    setKind(k);
    setPage(p);
    setRows([]);
    try {
      const data = await collaboration<Entry[]>(projectId, `remote_work_${k}`, {
        page: p,
      });
      if (n === epoch.current) setRows(data);
    } catch (e) {
      failed(n, e);
    } finally {
      finish(n);
    }
  }
  async function select(e: Entry, refresh = false) {
    const n = begin("Fetching revision…");
    try {
      const r = await collaboration<Review>(projectId, "remote_work_open", {
        ...e,
        refresh,
      });
      if (n !== epoch.current) {
        closeSession(r.id);
        return;
      }
      closeSession(owned.current);
      owned.current = r.id;
      setReview(r);
      setEntry({ ...r.entry, sha: r.sha, base: r.base });
      setBuild(null);
      setTarget(null);
      setLine(0);
      const files = Object.keys(r.sources);
      const first = files.includes("main.tex")
        ? "main.tex"
        : (files.find((f) => r.sources[f].includes("\\documentclass")) ??
          files[0] ??
          "");
      setMain(first);
      setFile(first);
      setPane("diff");
    } catch (err) {
      failed(n, err);
    } finally {
      finish(n);
    }
  }
  async function compile() {
    if (!review) return;
    const n = begin("Compiling reviewed revision…");
    setBuild(null);
    setTarget(null);
    try {
      const r = await collaboration<{ pdf: string; locations: Box[] }>(
        projectId,
        "remote_work_compile",
        { id: review.id, main },
      );
      if (n === epoch.current)
        setBuild({
          main,
          artifactId: `${review.id}/${n}`,
          pdf: Uint8Array.from(atob(r.pdf), (c) => c.charCodeAt(0)).buffer,
          locations: r.locations,
        });
    } catch (e) {
      failed(n, e);
    } finally {
      finish(n);
    }
  }
  function browse() {
    epoch.current++;
    closeSession(owned.current);
    owned.current = "";
    setReview(null);
    setEntry(null);
    setBuild(null);
    void list(kind);
  }
  useEffect(() => {
    const show = (ev: Event) => {
      if ((ev as CustomEvent).detail === projectId) {
        setVisible(true);
        if (!review) void list(kind);
      }
    };
    window.addEventListener("prism-browse-remote-work", show);
    return () => window.removeEventListener("prism-browse-remote-work", show);
  }, [projectId, review, kind]);
  function close() {
    epoch.current++;
    closeSession(owned.current);
    owned.current = "";
    setEntry(null);
    setReview(null);
    setBuild(null);
    setVisible(false);
    setBusy("");
    setError("");
  }
  return (
    <>
      {(visible || review) && (
        <nav
          aria-label="Workspace views"
          className="flex items-center gap-1 border-b p-1"
        >
          <Button
            variant={visible ? "ghost" : "secondary"}
            onClick={() => setVisible(false)}
          >
            Writing
          </Button>
          <Button
            variant={visible ? "secondary" : "ghost"}
            onClick={() => setVisible(true)}
          >
            {entry ? title(entry) : "Browse remote work"}
          </Button>
          <Button
            variant="ghost"
            onClick={close}
            aria-label="Close remote review"
          >
            ×
          </Button>
        </nav>
      )}
      <div className={visible ? "hidden" : "min-h-0 flex-1"}>{children}</div>
      {visible && (
        <section
          aria-label="Remote work review"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4"
        >
          <h2 className="font-semibold">
            {entry ? title(entry) : "Browse remote work"}
          </h2>
          <p className="text-muted-foreground text-xs">
            {entry && review
              ? `Read-only · ${review.sha.slice(0, 12)} · Compared with ${entry.base} (${review.baseSha.slice(0, 8)})`
              : "Select a remote branch or open pull request to review."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {entry ? (
              <>
                <Button variant="outline" onClick={browse}>
                  Browse remote work
                </Button>
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void select(entry, true)}
                >
                  Refresh review
                </Button>
                {entry.link && (
                  <Button
                    variant="outline"
                    onClick={() => void openExternal(entry.link!)}
                  >
                    Open pull request
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button
                  variant={kind === "branches" ? "default" : "outline"}
                  onClick={() => void list("branches")}
                >
                  Branches
                </Button>
                <Button
                  variant={kind === "pulls" ? "default" : "outline"}
                  onClick={() => void list("pulls")}
                >
                  Pull requests
                </Button>
                <Button
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => void list(kind, page)}
                >
                  Refresh list
                </Button>
              </>
            )}
          </div>
          {busy && <p role="status">{busy}</p>}
          {error && (
            <p
              role="alert"
              className="max-h-28 overflow-auto whitespace-pre-wrap text-destructive"
            >
              {error}
            </p>
          )}
          {!review ? (
            <div className="overflow-auto">
              {rows.map((e) => (
                <button
                  key={e.number ?? e.name}
                  disabled={!!busy}
                  className="flex w-full flex-col rounded border-b p-3 text-left hover:bg-muted"
                  onClick={() => void select(e)}
                >
                  <strong>
                    {title(e)}
                    {e.draft ? " · Draft" : ""}
                  </strong>
                  <span className="text-muted-foreground text-xs">
                    {e.author && `${e.author} · `}
                    {e.number && `into ${e.base} · `}
                    {e.sha.slice(0, 8)}
                  </span>
                </button>
              ))}
              {!rows.length && !busy && !error && (
                <p>
                  No{" "}
                  {kind === "branches"
                    ? "remote branches"
                    : "open pull requests"}{" "}
                  found.
                </p>
              )}
              {kind === "pulls" && (
                <div className="flex gap-2">
                  {page > 1 && (
                    <Button
                      disabled={!!busy}
                      onClick={() => void list(kind, page - 1)}
                    >
                      Previous
                    </Button>
                  )}
                  {rows.length === 50 && (
                    <Button
                      disabled={!!busy}
                      onClick={() => void list(kind, page + 1)}
                    >
                      Next
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={pane === "diff" ? "default" : "outline"}
                  onClick={() => setPane("diff")}
                >
                  Diff
                </Button>
                <Button
                  variant={pane === "source" ? "default" : "outline"}
                  onClick={() => setPane("source")}
                >
                  Source
                </Button>
                {main && (
                  <>
                    <select
                      aria-label="PDF root document"
                      value={main}
                      disabled={!!busy}
                      onChange={(e) => {
                        setMain(e.target.value);
                        setBuild(null);
                        setTarget(null);
                      }}
                    >
                      {Object.keys(review.sources).map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      title="Compile trusted sources with your local TeX installation"
                      onClick={() => void compile()}
                    >
                      Compile PDF
                    </Button>
                  </>
                )}
              </div>
              <div className="flex min-h-0 flex-1 gap-2">
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  {pane === "diff" ? (
                    <pre className="overflow-auto p-2 text-xs">
                      {review.diff || "No changes since the merge base."}
                    </pre>
                  ) : (
                    <>
                      <select
                        aria-label="Source file"
                        value={file}
                        onChange={(e) => {
                          setFile(e.target.value);
                          setLine(0);
                        }}
                      >
                        {Object.keys(review.sources).map((f) => (
                          <option key={f}>{f}</option>
                        ))}
                      </select>
                      <pre ref={source} className="overflow-auto p-2 text-xs">
                        {(review.sources[file] ?? "")
                          .split("\n")
                          .map((s, i) => (
                            <span
                              key={i}
                              className={
                                line === i + 1 ? "block bg-accent" : "block"
                              }
                              data-selected={line === i + 1}
                              onDoubleClick={() => {
                                const candidates = build?.locations.filter(
                                  (b) => b.file === file,
                                );
                                if (candidates?.length)
                                  setTarget({
                                    ...candidates.reduce((a, b) =>
                                      Math.abs(b.line - i - 1) <
                                      Math.abs(a.line - i - 1)
                                        ? b
                                        : a,
                                    ),
                                  });
                              }}
                            >
                              {s || " "}
                            </span>
                          ))}
                      </pre>
                    </>
                  )}
                </div>
                {build && (
                  <div className="relative min-w-0 flex-1">
                    <PdfViewer
                      data={build.pdf}
                      artifactId={build.artifactId}
                      documentScope={review.id}
                      ownerId={review.id}
                      isActive={visible}
                      rootFileId={build.main}
                      scale={scale}
                      onScaleChange={setScale}
                      sourceLocation={target}
                      onSynctexClick={(page, x, y) => {
                        const candidates = build.locations.filter(
                          (b) =>
                            b.page === page &&
                            Object.prototype.hasOwnProperty.call(
                              review.sources,
                              b.file,
                            ),
                        );
                        const distance = (b: Box) =>
                          Math.hypot(
                            Math.max(b.x - x, 0, x - b.x - b.w),
                            Math.max(b.y - y, 0, y - b.y - b.h),
                          );
                        if (candidates.length) {
                          const nearest = candidates.reduce((a, b) =>
                            distance(b) < distance(a) ? b : a,
                          );
                          setFile(nearest.file);
                          setLine(nearest.line);
                          setPane("source");
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
