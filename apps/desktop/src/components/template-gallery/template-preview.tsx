import { useProjectCreation } from "@/hooks/use-project-creation";
import { DataSourceEditor } from "@/components/data-source-editor";
import { useState, useCallback, useEffect, useRef } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SparklesIcon,
  LoaderIcon,
  ArrowLeftIcon,
  FolderOpenIcon,
  ChevronDownIcon,
  MapPinIcon,
  Loader2Icon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useTemplateStore } from "@/stores/template-store";
import { getTemplatePdfBuffer } from "@/lib/template-preview-cache";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { PageSize } from "@/lib/mupdf/types";
import { createLogger } from "@/lib/debug/logger";

import { getProjectNameError, normalizeProjectName } from "@/lib/project-name";

const log = createLogger("template-preview");

// ─── Helpers ───

// ─── Component ───

type ModalStep = "preview" | "details";

export function TemplatePreview() {
  const previewTemplateId = useTemplateStore((s) => s.previewTemplateId);
  const closePreview = useTemplateStore((s) => s.closePreview);
  const template = useTemplateStore((s) =>
    s.templates.find((t) => t.id === s.previewTemplateId),
  );

  const [modalStep, setModalStep] = useState<ModalStep>("preview");

  // ── PDF preview state ──
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLandscape, setIsLandscape] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const consumedRetry = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const docIdRef = useRef(0);
  const pageSizesRef = useRef<PageSize[]>([]);
  const loadGenRef = useRef(0);

  // ── Creation form state ──
  const { purpose, setPurpose, attachments, setAttachments, sourceSettings, setSourceSettings,
    projectFolder, projectName, setProjectName, projectNameError, setProjectNameError,
    isCreating, isDragOver, handleChooseFolder, handleCreate, resetCreation } = useProjectCreation(template, modalStep === "details");
  const [locationOpen, setLocationOpen] = useState(false);
  const projectNameRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Dialog open/close ──
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closePreview();
        setModalStep("preview");
        setCurrentPage(1);
        setNumPages(0);
        setIsLandscape(false);
        setError(false);
        if (docIdRef.current > 0) {
          getMupdfClient()
            .closeDocument(docIdRef.current)
            .catch(() => {});
          docIdRef.current = 0;
        }
      }
    },
    [closePreview],
  );

  // Reset form when a new template is previewed
  useEffect(() => {
    if (previewTemplateId) {
      setModalStep("preview");
      resetCreation();
      setLocationOpen(false);
    }
  }, [previewTemplateId, resetCreation]);

  // Auto-focus textarea in details step
  useEffect(() => {
    if (modalStep === "details") {
      const timer = setTimeout(() => projectNameRef.current?.focus(), 150);
      return () => clearTimeout(timer);
    }
  }, [modalStep]);

  // ── PDF loading ──
  useEffect(() => {
    if (!template) return;

    const gen = ++loadGenRef.current;
    const abort = new AbortController();
    const retry = retryCount !== consumedRetry.current;
    consumedRetry.current = retryCount;
    setLoading(true);
    setError(false);
    setNumPages(0);
    setCurrentPage(1);

    (async () => {
      try {
        const buffer = await getTemplatePdfBuffer(template, true, retry);
        if (gen !== loadGenRef.current) return;

        const client = getMupdfClient();
        if (docIdRef.current > 0) {
          await client.closeDocument(docIdRef.current).catch(() => {});
        }

        if (abort.signal.aborted) return;
        const docId = await client.openDocument(buffer, undefined, { priority: "foreground", ownerId: `template:${template.id}` });
        if (gen !== loadGenRef.current) {
          client.closeDocument(docId).catch(() => {});
          return;
        }
        docIdRef.current = docId;

        const count = await client.countPages(docId, { signal: abort.signal, priority: "foreground", ownerId: `template:${template.id}` });
        if (gen !== loadGenRef.current) return;

        const sizes: PageSize[] = [];
        for (let i = 0; i < count; i++) {
          const size = await client.getPageSize(docId, i, { signal: abort.signal, priority: "foreground", ownerId: `template:${template.id}` });
          if (gen !== loadGenRef.current) return;
          sizes.push(size);
        }

        pageSizesRef.current = sizes;
        setNumPages(count);
        setCurrentPage(1);
        if (sizes.length > 0) {
          setIsLandscape(sizes[0].width > sizes[0].height);
        }
        setLoading(false);
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        log.warn("load error", { error: String(err) });
        setPreviewError(String(err));
        setLoading(false);
        setError(true);
      }
    })();
    return () => {
      abort.abort();
      ++loadGenRef.current;
      if (docIdRef.current > 0) {
        void getMupdfClient()
          .closeDocument(docIdRef.current)
          .catch(() => {});
        docIdRef.current = 0;
      }
    };
  }, [template, retryCount]);

  // Render after layout and whenever the dialog's preview area changes size.
  useEffect(() => {
    if (
      modalStep !== "preview" ||
      loading ||
      docIdRef.current <= 0 ||
      numPages === 0 ||
      !canvasRef.current ||
      !containerRef.current
    )
      return;

    const pageIndex = currentPage - 1;
    const size = pageSizesRef.current[pageIndex];
    if (!size) return;
    setIsLandscape(size.width > size.height);
    const container = containerRef.current;
    const client = getMupdfClient();
    const docId = docIdRef.current;
    const gen = loadGenRef.current;
    let cancelled = false;
    let revision = 0;
    let request: AbortController | undefined;
    let frame = 0;
    const render = () => {
      const current = ++revision;
      request?.abort();
      request = new AbortController();
      const maxW = container.clientWidth - 48;
      const maxH = container.clientHeight - 48;
      if (maxW <= 0 || maxH <= 0) return;
      const scale = Math.min(maxW / size.width, maxH / size.height);
      const displayW = size.width * scale;
      const displayH = size.height * scale;
      const dpi = scale * 72 * (window.devicePixelRatio || 1);
      void client.drawPage(docId, pageIndex, dpi, { signal: request.signal, priority: "foreground", ownerId: `template:${template?.id}` }).then((imageData) => {
        if (cancelled || current !== revision || gen !== loadGenRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        canvas.style.width = `${displayW}px`;
        canvas.style.height = `${displayH}px`;
        canvas.getContext("2d")!.putImageData(imageData, 0, 0);
      }).catch((err) => {
        if (cancelled || current !== revision || gen !== loadGenRef.current) return;
        log.warn("render error", { error: String(err) });
        setPreviewError(String(err));
        setError(true);
      });
    };
    const schedule = () => {
      request?.abort();
      ++revision; // Discard a render measured before the latest resize.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    schedule();
    return () => {
      cancelled = true;
      request?.abort();
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [currentPage, numPages, isLandscape, modalStep, loading]);

  // ── Page navigation ──
  const goToPrevPage = useCallback(
    () => setCurrentPage((p) => Math.max(1, p - 1)),
    [],
  );
  const goToNextPage = useCallback(
    () => setCurrentPage((p) => Math.min(numPages, p + 1)),
    [numPages],
  );

  useEffect(() => {
    if (!previewTemplateId || modalStep !== "preview") return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrevPage();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToNextPage();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewTemplateId, modalStep, goToPrevPage, goToNextPage]);

  const canCreate = Boolean(
    template && projectFolder && !getProjectNameError(projectName),
  );

  if (!template) return null;

  // ── Modal width depends on step ──
  const modalWidth =
    modalStep === "preview"
      ? isLandscape
        ? "w-[min(72rem,calc(100vw-4rem))]"
        : "w-[min(48rem,calc(100vw-6rem))]"
      : "w-[min(32rem,calc(100vw-4rem))]";

  return (
    <Dialog open={!!previewTemplateId} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={`flex max-w-none flex-col gap-0 overflow-hidden p-0 transition-[width] duration-300 sm:max-w-none ${modalWidth} ${modalStep === "preview" ? "h-[70vh]" : "max-h-[80vh]"}`}
      >
        {modalStep === "preview" ? (
          /* ═══════════════════ PREVIEW STEP ═══════════════════ */
          <>
            <DialogHeader className="shrink-0 border-border border-b px-6 py-3">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-sm">{template.name}</DialogTitle>
                  <DialogDescription className="mt-0.5 truncate text-xs">
                    {template.description} — {template.documentClass}
                    {template.packages.length > 0 &&
                      ` — ${template.packages.length} packages`}
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => setModalStep("details")}
                    className="gap-1.5"
                  >
                    <SparklesIcon className="size-3.5" />
                    Use Template
                  </Button>
                </div>
              </div>
            </DialogHeader>

            <div className="flex flex-1 overflow-hidden">
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <div
                  ref={containerRef}
                  className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-muted/30 p-6"
                >
                  {loading && (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <LoaderIcon className="size-5 animate-spin" />
                      <span className="text-sm">
                        {template.source === "private"
                          ? "Preparing local preview…"
                          : "Loading preview..."}
                      </span>
                    </div>
                  )}
                  {error && (
                    <div className="flex max-w-lg flex-col items-center gap-2 text-muted-foreground">
                      <span className="text-sm">Preview not available</span>
                      <p className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                        {template.source === "private"
                          ? previewError
                          : "The bundled preview could not be loaded."}
                      </p>
                      {template.source === "private" && (
                        <>
                          <span className="text-xs">
                            You can still use this template to create a project.
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRetryCount((n) => n + 1)}
                          >
                            Retry preview
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  {!loading && !error && numPages > 0 && (
                    <canvas ref={canvasRef} className="shadow-xl" />
                  )}
                </div>

                {numPages > 0 && (
                  <div className="flex shrink-0 items-center justify-center gap-3 border-border border-t bg-background py-2.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={goToPrevPage}
                      disabled={currentPage <= 1}
                    >
                      <ChevronLeftIcon className="size-4" />
                    </Button>
                    <span className="min-w-16 text-center text-muted-foreground text-xs tabular-nums">
                      {numPages > 1 ? `${currentPage} / ${numPages}` : "1 page"}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={goToNextPage}
                      disabled={currentPage >= numPages}
                    >
                      <ChevronRightIcon className="size-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          /* ═══════════════════ DETAILS STEP ═══════════════════ */
          <>
            {/* Header */}
            <DialogHeader className="shrink-0 border-border/60 border-b px-5 py-3">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 rounded-lg"
                  aria-label="Back to preview"
                  onClick={() => setModalStep("preview")}
                >
                  <ArrowLeftIcon className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-sm">{template.name}</DialogTitle>
                  <DialogDescription className="mt-0.5 truncate text-xs">
                    {template.description}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {/* Form content */}
            <div className="flex-1 overflow-y-auto">
              <div className="space-y-4 p-5">
                <div className="space-y-2">
                  <div>
                    <span className="font-semibold text-sm">Project name</span>
                    <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                      This becomes the folder name on disk.
                    </p>
                  </div>
                  <Input
                    ref={projectNameRef}
                    placeholder="e.g., conference-paper"
                    value={projectName}
                    onChange={(e) => {
                      setProjectName(e.target.value);
                      setProjectNameError("");
                    }}
                    onBlur={() =>
                      setProjectNameError(
                        getProjectNameError(projectName) ?? "",
                      )
                    }
                    className="rounded-xl border-border/60 bg-card/30 text-sm focus-visible:bg-card/50"
                  />
                  {projectNameError && (
                    <p className="text-destructive text-xs">
                      {projectNameError}
                    </p>
                  )}
                </div>
                {/* Purpose — hero element */}
                <div className="space-y-2">
                  <div>
                    <span className="font-semibold text-sm">
                      What are you writing?
                    </span>
                    <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                      Describe your document and Codex will generate tailored
                      content.
                    </p>
                  </div>
                  <Textarea
                    ref={textareaRef}
                    placeholder="e.g., A research paper on transformer architectures for protein structure prediction, targeting NeurIPS 2025..."
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    rows={3}
                    className="resize-none rounded-xl border-border/60 bg-card/30 text-sm leading-relaxed placeholder:text-muted-foreground/50 focus-visible:bg-card/50"
                  />
                </div>

                {/* Collapsible sections */}
                <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/60 bg-card/30">
            <section className="space-y-2 p-4" aria-label="Data sources">
              <h3 className="text-sm font-medium">Data sources</h3>
              <DataSourceEditor settings={sourceSettings} setSettings={setSourceSettings} files={attachments} setFiles={setAttachments} disabled={isCreating} />
              {isDragOver && <p className="text-xs">Drop files to add data sources</p>}
            </section>

            {/* Project location */}
                  <div>
                    <button
                      onClick={() => setLocationOpen(!locationOpen)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
                    >
                      <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50">
                        <MapPinIcon className="size-3 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-sm">
                          Project location
                        </span>
                      </div>
                      {!locationOpen && projectFolder && projectName.trim() && (
                        <span className="min-w-0 max-w-35 truncate rounded-md bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground/60">
                          .../{projectFolder.split(/[/\\]/).pop()}/
                          {normalizeProjectName(projectName)}
                        </span>
                      )}
                      <ChevronDownIcon
                        className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${locationOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {locationOpen && (
                      <div className="space-y-2 px-4 pb-3">
                        <div className="flex items-center gap-2">
                          <p className="min-w-0 flex-1 truncate rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground/60">
                            {projectFolder
                              ? `${projectFolder}/${normalizeProjectName(projectName) || "..."}`
                              : "Choose a location"}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0 gap-1.5 rounded-lg border-border/60"
                            onClick={handleChooseFolder}
                          >
                            <FolderOpenIcon className="size-3.5" />
                            {projectFolder ? "Change" : "Choose"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Create button — sticky footer */}
            <div className="shrink-0 border-border/60 border-t px-5 py-4">
              <Button
                className="w-full gap-2 rounded-xl font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.99]"
                size="lg"
                disabled={!canCreate || isCreating}
                onClick={async () => { if (await handleCreate()) closePreview(); }}
              >
                {isCreating ? (
                  <>
                    <Loader2Icon className="size-4 animate-spin" />
                    Creating project...
                  </>
                ) : purpose.trim() ? (
                  <>
                    <SparklesIcon className="size-4" />
                    Create & Generate with AI
                  </>
                ) : (
                  "Create Project"
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
