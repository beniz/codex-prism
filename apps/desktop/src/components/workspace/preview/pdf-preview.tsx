import { useFirstChangedPage } from "@/hooks/use-first-changed-page";
import { useChatPdf, safeChatSource, chatHeadingLocation } from "@/hooks/use-chat-pdf";
import { ProposalReport } from "../proposal-preview";
import { usePdfNavigationStore } from "@/stores/pdf-navigation-store";
import { toast } from "sonner";
import { useVisualReview } from "@/hooks/use-visual-review";
import { VisualReviewPanel } from "./visual-review-panel";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getPdfArrayBuffer } from "@/lib/mupdf/pdf-data";
import {
  FileTextIcon,
  SpellCheckIcon,
  AlertCircleIcon,
  LoaderIcon,
  RefreshCwIcon,
  MinusIcon,
  PlusIcon,
  HistoryIcon,
  MousePointerClickIcon,
  CrosshairIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from "lucide-react";
import { backend } from "@/lib/backend";
import {
  useDocumentStore,
  getCurrentPdfBytes,
  getCurrentPdfRootId,
  hasPdfData,
} from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { usePdfSourceNavigation } from "@/hooks/use-pdf-source-navigation";
import { useAutoRecompile } from "@/hooks/use-auto-recompile";
import { useSettingsStore } from "@/stores/settings-store";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { HistoryPanel } from "@/components/workspace/history-panel";
import {
  compileLatex,
  loadExistingPdf,
  synctexEdit,
  resolveCompileTarget,
  formatCompileError,
} from "@/lib/latex-compiler";
import { ErrorBoundary } from "react-error-boundary";
import {
  SelectionToolbar,
  type ToolbarAction,
} from "@/components/workspace/editor/selection-toolbar";
import { PdfExportButton } from "./pdf-export-button";
import {
  PdfViewer,
  type PdfTextSelection,
  type CaptureResult,
} from "./pdf-viewer";
import { resolveTexRoot } from "@/stores/document-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("pdf-preview");

type FitMode = "fit-width" | "fit-height" | null;

/** Per-root zoom state cache: rootFileId -> { scale, fitMode } */
const zoomCache = new Map<string, { scale: number; fitMode: FitMode }>();

/** Max number of PdfViewer instances kept alive simultaneously. */
const MAX_ALIVE_VIEWERS = 5;

/** Clear zoom cache (e.g., on project close). */
export function clearZoomCache(): void {
  zoomCache.clear();
}

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

export function PdfPreview() {
  const incremental = useSettingsStore((s) => s.incrementalCompilation);
  const setIncremental = useSettingsStore((s) => s.setIncrementalCompilation);
  const autoRecompile = useSettingsStore((s) => s.autoRecompile);
  const setAutoRecompile = useSettingsStore((s) => s.setAutoRecompile);
  const visualChangeReports = useSettingsStore((s) => s.visualChangeReports);
  const setVisualChangeReports = useSettingsStore(
    (s) => s.setVisualChangeReports,
  );
  const contentGeneration = useDocumentStore((s) => s.contentGeneration);
  const agentActive = useAgentChatStore((s) => s.review.active);
  const pdfRevision = useDocumentStore((s) => s.pdfRevision);
  const mainCompileError = useDocumentStore((s) => s.compileError);
  const mainIsCompiling = useDocumentStore((s) => s.isCompiling);
  const isSaving = useDocumentStore((s) => s.isSaving);
  const setPdfData = useDocumentStore((s) => s.setPdfData);
  const setCompileError = useDocumentStore((s) => s.setCompileError);
  const setIsCompiling = useDocumentStore((s) => s.setIsCompiling);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const projectId = useDocumentStore((s) => s.projectId);
  const files = useDocumentStore((s) => s.files);
  const saveAllFiles = useDocumentStore((s) => s.saveAllFiles);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const activeFile = useDocumentStore((s) => {
    return s.files.find((f) => f.id === s.activeFileId) ?? null;
  });
  const activeFileType = activeFile?.type ?? "tex";
  const isTexActive = activeFileType === "tex";
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInputValue, setPageInputValue] = useState<string>("1");
  const [isEditingPage, setIsEditingPage] = useState(false);
  const scrollToPageRef = useRef<((page: number) => void) | null>(null);
  const [scale, setScale] = useState<number>(1.0);
  const [captureMode, setCaptureMode] = useState(false);
  const [fitMode, setFitMode] = useState<FitMode>("fit-width");
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  // A fresh callback reattaches the viewer's ResizeObserver, whose initial
  // notification can otherwise trigger another render indefinitely.
  const handleContainerResize = useCallback((width: number, height: number) => {
    setContainerSize((previous) =>
      previous?.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  }, []);
  const [firstPageSize, setFirstPageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const hasInitialCompile = useRef<string | null>(null);
  const initialized = useDocumentStore((s) => s.initialized);

  // Derive pdfData from external cache, re-read whenever pdfRevision bumps
  const mainPdfData = useMemo(() => getCurrentPdfBytes(), [pdfRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep-alive: track which root files have PdfViewer instances alive (LRU order)
  const sourceRootFileId =
    activeFile?.type === "tex"
      ? resolveTexRoot(activeFile.id, files)
      : (getCurrentPdfRootId() ?? resolveTexRoot(activeFile?.id ?? "", files));
  const mainFile = files.find((f) => f.id === sourceRootFileId)?.relativePath;
  const chatPdf = useChatPdf(mainFile);
  const artifact = chatPdf.artifact;
  const changePageTarget = useFirstChangedPage(artifact, projectId);
  const shownChanges = useRef(new Set<string>());
  const markChangeShown = useCallback((key: string) => { shownChanges.current.add(key); }, []);
  useEffect(() => { shownChanges.current.clear(); }, [projectId]);
  const artifactRef = useRef(artifact);
  artifactRef.current = artifact;
  const pdfData = artifact?.bytes ?? mainPdfData;
  const compileError = chatPdf.proposal ? chatPdf.error : mainCompileError;
  const isCompiling = chatPdf.proposal ? chatPdf.busy : mainIsCompiling;
  const currentRootFileId = JSON.stringify([
    projectRoot,
    artifact?.proposal.id ?? "main",
    sourceRootFileId,
  ]);
  const viewerData = useRef(new Map<string, { bytes: Uint8Array; artifactId?: string }>());
  if (pdfData) viewerData.current.set(currentRootFileId, { bytes: pdfData, artifactId: artifact?.build.artifactId });
  const visual = useVisualReview(mainFile, !chatPdf.proposal);
  useEffect(() => {
    setPdfError(null);
    setPdfSelection(null);
    setResolvedSource(null);
    setCaptureMode(false);
  }, [currentRootFileId, chatPdf.key]);
  const [reviewPanelOpen, setReviewPanelOpen] = useState(true);
  const selectChange = (id: string) => {
    visual.setSelected(id);
    setReviewPanelOpen(true);
    const item = visual.items.find((c) => c.id === id);
    if (item?.after[0]) scrollToPageRef.current?.(item.after[0].page);
  };
  const changeOverlay = (page: number) => (
    <div className="pointer-events-none absolute inset-0 z-10">
      {visual.items.flatMap((item, index) =>
        item.after
          .filter((r) => r.page === page)
          .map((r, i) => (
            <div
              key={`${item.id}:${i}`}
              className={`absolute border ${visual.selected === item.id ? "border-amber-600 bg-amber-300/30" : "border-amber-400 bg-amber-200/20"}`}
              style={{
                left: r.x * scale,
                top: r.y * scale,
                width: r.w * scale,
                height: r.h * scale,
              }}
            >
              <button
                aria-label={`Change ${index + 1}: ${item.label}`}
                aria-pressed={visual.selected === item.id}
                onClick={() => selectChange(item.id)}
                className="pointer-events-auto absolute top-0 -left-5 rounded bg-amber-200 px-1 text-black text-xs"
              >
                {index + 1}
              </button>
            </div>
          )),
      )}
    </div>
  );
  const [aliveOrder, setAliveOrder] = useState<string[]>([]);
  const prevRootRef = useRef(currentRootFileId);

  // Save/restore zoom state per root file on switch
  useEffect(() => {
    const prev = prevRootRef.current;
    if (prev && prev !== currentRootFileId) {
      // Save previous root's zoom
      zoomCache.set(prev, { scale, fitMode });
    }
    // Restore new root's zoom
    const cached = zoomCache.get(currentRootFileId);
    if (cached) {
      setScale(cached.scale);
      setFitMode(cached.fitMode);
    } else {
      setFitMode("fit-width");
    }
    prevRootRef.current = currentRootFileId;
  }, [currentRootFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update alive set when active root changes and has PDF data
  useEffect(() => {
    if (!currentRootFileId || (!pdfData && !visual.active)) return;
    setAliveOrder((prev) => {
      if (prev[0] === currentRootFileId) return prev; // already at front
      const without = prev.filter((id) => id !== currentRootFileId);
      return [currentRootFileId, ...without].slice(0, MAX_ALIVE_VIEWERS);
    });
  }, [currentRootFileId, pdfData, visual.active]);
  useEffect(() => {
    for (const key of viewerData.current.keys()) {
      if (!aliveOrder.includes(key) && key !== currentRootFileId)
        viewerData.current.delete(key);
    }
  }, [aliveOrder, currentRootFileId]);

  // PDF text selection toolbar
  const [pdfSelection, setPdfSelection] = useState<PdfTextSelection | null>(
    null,
  );
  const previewContainerRef = useRef<HTMLDivElement>(null);

  const mainSourceLocation = usePdfSourceNavigation({
    projectRoot,
    projectId: useDocumentStore((state) => state.projectId),
    mainFile,
    activeFilePath: activeFile?.relativePath,
    data: visual.active
      ? visual.bytes.current
      : pdfData
        ? getPdfArrayBuffer(pdfData)
        : null,
    artifactId: visual.active ? visual.metadata.after : undefined,
    // A visible PDF remains navigable during a build or after a failed build.
    // The backend verifies its revision before using SyncTeX.
    enabled: !artifact,
  });

  const navigationChatId = useAgentChatStore(s => s.activeTabId);
  const navigation = usePdfNavigationStore((s) => s.request);
  const [chatSourceLocation, setChatSourceLocation] = useState<
    import("@/lib/visual-review").SourceBox | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    setChatSourceLocation(null);
    if (artifact && navigation && (!navigation.chatId || navigation.chatId === navigationChatId) && navigation.projectRoot === projectRoot) {
      void chatHeadingLocation(artifact, navigation)
        .then((box) => {
          if (!cancelled) {
            setChatSourceLocation(box);
            if (!box && navigation.origin === "editor") toast.info("No matching position in the current PDF; compile the document and try again.");
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [artifact, navigation, navigationChatId, projectRoot, contentGeneration]);
  const sourceLocation = artifact ? chatSourceLocation : mainSourceLocation;
  const locateDisplayedSource = useCallback(
    async (page: number, x: number, y: number) => {
      if (!artifact) {
        const bytes = visual.active ? visual.bytes.current : pdfData ? getPdfArrayBuffer(pdfData) : null;
        return projectRoot && mainFile && bytes ? synctexEdit(projectRoot, mainFile, bytes, page, x, y) : null;
      }
      const box = artifact.build.locations
        .filter((b) => b.page === page)
        .sort(
          (a, b) =>
            Math.abs(a.y - y) +
            Math.abs(a.x - x) -
            Math.abs(b.y - y) -
            Math.abs(b.x - x),
        )[0];
      if (!box) return null;
      return safeChatSource(artifact, box).catch(() => null);
    },
    [artifact, projectRoot, mainFile, pdfData, visual.active, visual.bytes.current, navigationChatId],
  );

  const sourceLookupRef = useRef(locateDisplayedSource);
  sourceLookupRef.current = locateDisplayedSource;
  const sourceClickGeneration = useRef(0);

  const handleSynctexClick = useCallback(
    async (page: number, x: number, y: number) => {
      if (!projectRoot) return;
      const generation = ++sourceClickGeneration.current;
      const result = await locateDisplayedSource(page, x, y);
      if (generation !== sourceClickGeneration.current || sourceLookupRef.current !== locateDisplayedSource) return;
      if (!result) {
        toast.info(artifact
          ? "This PDF contains unapplied edits. No verified location in the main document is available."
          : "No matching source in the current PDF; compile the document and try again.");
        return;
      }

      const normalize = (p: string) =>
        p.replace(/\\/g, "/").replace(/^\.\//, "");
      const normalizedTarget = normalize(result.file);
      const targetFile = useDocumentStore
        .getState()
        .files.find((f) => normalize(f.relativePath) === normalizedTarget);
      if (!targetFile) return;

      const state = useDocumentStore.getState();
      const needsSwitch = state.activeFileId !== targetFile.id;
      if (needsSwitch) {
        setActiveFile(targetFile.id);
      }

      const fileContent = targetFile.content ?? "";
      const fileLines = fileContent.split("\n");
      const targetLine = Math.max(1, Math.min(result.line, fileLines.length));
      let offset = 0;
      for (let i = 0; i < targetLine - 1; i++) {
        offset += fileLines[i].length + 1;
      }
      if (result.column > 0) {
        offset += Math.min(
          result.column,
          fileLines[targetLine - 1]?.length ?? 0,
        );
      }

      if (needsSwitch) {
        setTimeout(() => {
          if (generation === sourceClickGeneration.current && sourceLookupRef.current === locateDisplayedSource && useDocumentStore.getState().activeFileId === targetFile.id) requestJumpToPosition(offset);
        }, 100);
      } else {
        requestJumpToPosition(offset);
      }
    },
    [
      projectRoot,
      setActiveFile,
      requestJumpToPosition,
      locateDisplayedSource,
      artifact,
    ],
  );

  // Resolved source location from synctex
  const [resolvedSource, setResolvedSource] = useState<{
    file: string;
    line: number;
    column: number;
  } | null>(null);

  const handleTextSelect = useCallback((selection: PdfTextSelection | null) => {
    setPdfSelection(selection);
    setResolvedSource(null);
  }, []);

  // When PDF selection changes, resolve source via synctex
  useEffect(() => {
    if (!pdfSelection || !projectRoot) return;
    let cancelled = false;
    setResolvedSource(null);
    locateDisplayedSource(
      pdfSelection.pageNumber,
      pdfSelection.pdfX,
      pdfSelection.pdfY,
    )
      .then((result) => {
        if (cancelled || !result) return;
        setResolvedSource(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdfSelection, projectRoot, locateDisplayedSource, contentGeneration]);

  const pdfContextLabel = resolvedSource
    ? `~@${resolvedSource.file}:${resolvedSource.line}`
    : pdfSelection
      ? `~@PDF page ${pdfSelection.pageNumber}`
      : "";

  const navigateToSource = useCallback(() => {
    if (!resolvedSource) {
      if (artifact)
        toast.info(
          "This PDF contains unapplied edits. No verified location in the main document is available.",
        );
      return;
    }
    const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
    const normalizedTarget = normalize(resolvedSource.file);
    const targetFile = files.find(
      (f) => normalize(f.relativePath) === normalizedTarget,
    );
    if (!targetFile) return;

    const state = useDocumentStore.getState();
    const needsSwitch = state.activeFileId !== targetFile.id;
    if (needsSwitch) setActiveFile(targetFile.id);

    const fileContent = targetFile.content ?? "";
    const fileLines = fileContent.split("\n");
    const targetLine = Math.max(
      1,
      Math.min(resolvedSource.line, fileLines.length),
    );
    let offset = 0;
    for (let i = 0; i < targetLine - 1; i++) {
      offset += fileLines[i].length + 1;
    }
    if (resolvedSource.column > 0) {
      offset += Math.min(
        resolvedSource.column,
        fileLines[targetLine - 1]?.length ?? 0,
      );
    }

    if (needsSwitch) {
      setTimeout(() => requestJumpToPosition(offset), 100);
    } else {
      requestJumpToPosition(offset);
    }
  }, [resolvedSource, files, setActiveFile, requestJumpToPosition, artifact]);

  const buildPdfContext = useCallback(
    (text: string) => {
      const locationNote = resolvedSource
        ? `near ${resolvedSource.file}:${resolvedSource.line}`
        : pdfSelection
          ? `PDF page ${pdfSelection.pageNumber}`
          : "PDF";
      return `[Selected from PDF output, approximate source location: ${locationNote}]\n${text}`;
    },
    [resolvedSource, pdfSelection],
  );

  const handlePdfToolbarSendPrompt = useCallback(
    (prompt: string) => {
      if (!pdfSelection) return;
      const label = pdfContextLabel;
      const sel = pdfSelection;
      setPdfSelection(null);
      window.getSelection()?.removeAllRanges();
      useAgentChatStore.getState().sendPrompt(prompt, {
        label,
        filePath: resolvedSource?.file ?? "document.pdf",
        selectedText: buildPdfContext(sel.text),
      });
    },
    [pdfSelection, pdfContextLabel, resolvedSource, buildPdfContext],
  );

  const pdfToolbarActions: ToolbarAction[] = useMemo(
    () => [
      {
        id: "proofread",
        label: "Proofread",
        icon: <SpellCheckIcon className="size-4" />,
      },
      {
        id: "navigate",
        label: "Navigate to source",
        icon: <FileTextIcon className="size-4" />,
        hint: "dbl-click",
      },
    ],
    [],
  );

  const handlePdfToolbarAction = useCallback(
    (actionId: string) => {
      if (!pdfSelection) return;
      const label = pdfContextLabel;
      const sel = pdfSelection;
      setPdfSelection(null);
      window.getSelection()?.removeAllRanges();
      if (actionId === "proofread") {
        useAgentChatStore
          .getState()
          .sendPrompt("Proofread and fix any errors in this text", {
            label,
            filePath: resolvedSource?.file ?? "document.pdf",
            selectedText: buildPdfContext(sel.text),
          });
      } else if (actionId === "navigate") {
        navigateToSource();
      }
    },
    [
      pdfSelection,
      pdfContextLabel,
      resolvedSource,
      navigateToSource,
      buildPdfContext,
    ],
  );

  const handlePdfToolbarDismiss = useCallback(() => {
    setPdfSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const pdfToolbarPosition = (() => {
    if (!pdfSelection || !previewContainerRef.current) return null;
    const containerRect = previewContainerRef.current.getBoundingClientRect();
    const relTop = pdfSelection.position.top - containerRect.top + 4;
    const relLeft = Math.max(
      8,
      Math.min(
        pdfSelection.position.left - containerRect.left,
        containerRect.width - 272,
      ),
    );
    return { top: relTop, left: relLeft };
  })();

  useEffect(() => {
    if (chatPdf.proposal) return;
    if (hasInitialCompile.current === projectRoot) return;
    if (!initialized || !projectRoot) return;
    if (pdfData || isCompiling || compileError) return;

    hasInitialCompile.current = projectRoot;

    const compile = async () => {
      setIsCompiling(true);
      try {
        const { files: allFiles, activeFileId } = useDocumentStore.getState();
        const resolved = resolveCompileTarget(activeFileId, allFiles);
        if (!resolved) {
          setCompileError(
            "No .tex file found in this project. Create a main.tex file to compile.",
          );
          return;
        }
        const { rootId, targetPath } = resolved;
        const existing = await loadExistingPdf(projectRoot, targetPath);
        if (useDocumentStore.getState().projectRoot !== projectRoot) return;
        if (existing) {
          setPdfData(existing, rootId, false);
          return;
        }
        await saveAllFiles();
        const data = await compileLatex(projectRoot, targetPath);
        if (useDocumentStore.getState().projectRoot === projectRoot)
          setPdfData(data, rootId);
      } catch (error) {
        if (useDocumentStore.getState().projectRoot === projectRoot)
          setCompileError(formatCompileError(error));
      } finally {
        setIsCompiling(false);
      }
    };
    compile();
  }, [
    initialized,
    projectRoot,
    pdfData,
    isCompiling,
    compileError,
    setIsCompiling,
    setPdfData,
    setCompileError,
    saveAllFiles,
    files,
    activeFile,
  ]);

  // Recompute scale when fit mode is active and container/page size changes
  useEffect(() => {
    if (!fitMode || !containerSize || !firstPageSize) return;
    const PADDING = 32; // p-4 on each side
    if (fitMode === "fit-width") {
      const newScale = (containerSize.width - PADDING) / firstPageSize.width;
      setScale(Math.max(0.25, Math.min(4, newScale)));
    } else if (fitMode === "fit-height") {
      const newScale = (containerSize.height - PADDING) / firstPageSize.height;
      setScale(Math.max(0.25, Math.min(4, newScale)));
    }
  }, [fitMode, containerSize, firstPageSize]);

  const zoomIn = () => {
    setFitMode(null);
    setScale((s) => Math.min(4, s + 0.1));
  };
  const zoomOut = () => {
    setFitMode(null);
    setScale((s) => Math.max(0.25, s - 0.1));
  };

  const handleCurrentPageChange = useCallback(
    (page: number) => {
      setCurrentPage((prev) => {
        if (prev === page) return prev;
        if (!isEditingPage) setPageInputValue(String(page));
        return page;
      });
    },
    [isEditingPage],
  );

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(numPages, page));
      scrollToPageRef.current?.(clamped);
    },
    [numPages],
  );

  const handlePageInputCommit = useCallback(() => {
    setIsEditingPage(false);
    const parsed = parseInt(pageInputValue, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= numPages) {
      goToPage(parsed);
    } else {
      setPageInputValue(String(currentPage));
    }
  }, [pageInputValue, numPages, currentPage, goToPage]);

  const handleLoadSuccess = useCallback(
    (pages: number) => setNumPages(pages),
    [],
  );
  const handleFirstPageSize = useCallback(
    (width: number, height: number) => setFirstPageSize({ width, height }),
    [],
  );
  const handleCancelCapture = useCallback(() => setCaptureMode(false), []);
  const handleScaleChange = useCallback((newScale: number) => {
    setFitMode(null);
    setScale(newScale);
  }, []);

  const handleCompile = async (force = false, automatic = false) => {
    if (chatPdf.proposal) {
      await chatPdf.compile();
      return;
    }
    // Read all guard values from the store to avoid stale closures
    const state = useDocumentStore.getState();
    if (!state.projectRoot) return;
    if (state.isCompiling) {
      // Queue a recompile after the current one finishes
      state.setPendingRecompile(true);
      return;
    }
    const allFiles = state.files;
    const activeFileId = state.activeFileId;
    const activeEntry = allFiles.find((f) => f.id === activeFileId);
    if (!automatic && (!activeEntry || activeEntry.type !== "tex")) return;
    const resolved = resolveCompileTarget(
      automatic ? sourceRootFileId : activeFileId,
      allFiles,
    );
    if (!resolved) {
      setCompileError(
        "No .tex file found in this project. Create a main.tex file to compile.",
      );
      return;
    }
    const { rootId, targetPath: targetFile } = resolved;
    // Skip recompile if no edits since last successful compile of this root
    // (unless force=true, e.g. user clicked Recompile button)
    if (!force) {
      const lastGen = state.lastCompiledGenerations.get(rootId);
      if (
        hasPdfData() &&
        lastGen !== undefined &&
        state.contentGeneration === lastGen
      )
        return;
    }
    useHistoryStore.getState().stopReview();
    setIsCompiling(true);
    state.setPendingRecompile(false);
    setPdfError(null);
    const compileStart = Date.now();
    try {
      await saveAllFiles();
      const data = await compileLatex(state.projectRoot, targetFile);
      if (useDocumentStore.getState().projectRoot === state.projectRoot)
        setPdfData(data, rootId);
    } catch (error) {
      if (useDocumentStore.getState().projectRoot === state.projectRoot)
        setCompileError(formatCompileError(error), rootId);
    } finally {
      // Ensure the spinner is visible for at least 500ms for visual feedback
      const elapsed = Date.now() - compileStart;
      if (elapsed < 500) {
        await new Promise((r) => setTimeout(r, 500 - elapsed));
      }
      setIsCompiling(false);
      // If a recompile was requested while we were compiling, trigger it now
      // Use setTimeout to avoid unbounded recursion on the call stack
      if (useDocumentStore.getState().pendingRecompile) {
        setTimeout(() => handleCompile(), 0);
      }
    }
  };

  useEffect(() => {
    const compile = () => {
      void chatPdf.compile();
    };
    window.addEventListener("compile-chat-pdf", compile);
    return () => window.removeEventListener("compile-chat-pdf", compile);
  }, [chatPdf.key, chatPdf.proposal?.id, chatPdf.proposal?.generation]);

  useAutoRecompile({
    enabled: autoRecompile && !chatPdf.proposal,
    documentKey: projectRoot
      ? JSON.stringify([projectRoot, currentRootFileId])
      : null,
    generation: contentGeneration,
    busy: isCompiling || agentActive || !initialized,
    compile: () => handleCompile(true, true),
  });

  const handleCapture = useCallback(
    async (result: CaptureResult) => {
      setCaptureMode(false);
      if (!projectRoot) return;

      const owner = useAgentChatStore.getState().activeTabId;
      const fileName = `capture-p${result.pageNumber}-${Date.now()}.png`;
      const relativePath = `attachments/${fileName}`;

      try {
        const project = await backend.projects.register(projectRoot);

        const base64 = result.dataUrl.split(",")[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await backend.files.write(
          { projectId: project.id, path: relativePath },
          [...bytes],
          null,
        );

        await useDocumentStore.getState().refreshFiles();

        if (
          useDocumentStore.getState().projectRoot !== projectRoot ||
          !useAgentChatStore.getState().tabs.some((t) => t.id === owner)
        )
          return;
        useAgentChatStore.getState().addPendingAttachment({
          chatId: owner,
          label: `@${relativePath}`,
          filePath: relativePath,
          selectedText: `[Captured region from PDF page ${result.pageNumber}]`,
          imageDataUrl: result.dataUrl,
        });
      } catch (err) {
        log.error("Capture failed to save", { error: String(err) });
      }
    },
    [projectRoot],
  );

  // Listen for global Capture & Ask shortcut (Cmd+Shift+X / Ctrl+Shift+X)
  useEffect(() => {
    const handleToggleCapture = () => {
      if (pdfData) setCaptureMode((prev) => !prev);
    };
    window.addEventListener("toggle-capture-mode", handleToggleCapture);
    return () =>
      window.removeEventListener("toggle-capture-mode", handleToggleCapture);
  }, [pdfData]);

  const renderContent = () => {
    if (compileError && !visual.active && !pdfData) {
      const errors = [
        ...new Set(
          compileError
            .split(/\s*!\s*/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s !== "Compilation failed"),
        ),
      ];

      const handleFixWithChat = () => {
        const errorList = errors.map((e) => `- ${e}`).join("\n");
        useAgentChatStore
          .getState()
          .sendPrompt(
            `[Compilation errors]\n${errorList}\n\nFix these LaTeX compilation errors.`,
          );
      };

      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-6">
          <div className="w-full max-w-lg">
            <div className="mb-4 flex items-center gap-2 text-destructive">
              <AlertCircleIcon className="size-5" />
              <h2 className="font-semibold text-base">Compilation Failed</h2>
              <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-xs">
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </span>
            </div>
            <div className="rounded-lg border border-destructive/20 bg-background">
              <div className="max-h-60 divide-y divide-border overflow-y-auto">
                {errors.map((error, i) => (
                  <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                    <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
                    <span className="text-foreground text-sm">{error}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={handleFixWithChat}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground text-xs shadow-sm transition-colors hover:bg-primary/90"
              >
                <MousePointerClickIcon className="size-3.5" />
                Fix with Chat
              </button>
              <button
                onClick={() => handleCompile(true)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-muted"
              >
                <RefreshCwIcon className="size-3.5" />
                Retry
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (!pdfData && !visual.active) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <FileTextIcon className="mb-4 size-16 text-muted-foreground/50" />
          <h2 className="mb-2 font-medium text-lg text-muted-foreground">
            PDF Preview
          </h2>
          <p className="mb-4 text-center text-muted-foreground text-sm">
            Press Cmd+Enter to compile your document
          </p>
          {isTexActive && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => handleCompile(true)}
            >
              <RefreshCwIcon className="size-3.5" />
              Compile
            </Button>
          )}
        </div>
      );
    }
    if (pdfError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <AlertCircleIcon className="mb-4 size-12 text-destructive" />
          <h2 className="mb-2 font-medium text-destructive text-lg">
            PDF Load Error
          </h2>
          <p className="max-w-md text-center text-muted-foreground text-sm">
            {pdfError}
          </p>
        </div>
      );
    }

    // Keep-alive rendering: one PdfViewer per root file, toggle via CSS.
    // Use visibility:hidden + absolute positioning instead of display:none
    // so that the browser preserves scrollTop on the overflow container.
    return (
      <div className="relative flex min-h-0 flex-1">
        {aliveOrder.map((rootId) => {
          const data =
            viewerData.current.get(rootId)?.bytes ??
            (rootId === currentRootFileId && visual.active
              ? new Uint8Array(visual.bytes.current!)
              : null);
          if (!data) return null;
          const isActive = rootId === currentRootFileId;
          return (
            <ErrorBoundary
              key={rootId}
              fallback={
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/30 p-8">
                  <AlertCircleIcon className="size-10 text-destructive" />
                  <p className="text-muted-foreground text-sm">
                    PDF viewer crashed. Try recompiling.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => handleCompile(true)}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    Recompile
                  </Button>
                </div>
              }
            >
              <div
                className={
                  isActive
                    ? "absolute inset-0 flex flex-col"
                    : "pointer-events-none invisible absolute inset-0 flex flex-col"
                }
              >
                <PdfViewer
                  data={
                    isActive && visual.active
                      ? visual.bytes.current!
                      : getPdfArrayBuffer(data)
                  }
                  changePageTarget={isActive && changePageTarget && !shownChanges.current.has(changePageTarget.key) ? changePageTarget : undefined}
                  onChangePageShown={markChangeShown}
                  sourceLocation={isActive ? sourceLocation : null}
                  selectedRegion={
                    isActive && visual.active
                      ? visual.items.find((c) => c.id === visual.selected)
                          ?.after[0]
                      : undefined
                  }
                  onPageClick={
                    isActive && visual.active
                      ? (page, x, y) => {
                          const item = visual.items.find((c) =>
                            c.after.some(
                              (r) =>
                                r.page === page &&
                                x >= r.x &&
                                x <= r.x + r.w &&
                                y >= r.y &&
                                y <= r.y + r.h,
                            ),
                          );
                          if (item) {
                            visual.setSelected(item.id);
                            setReviewPanelOpen(true);
                          }
                        }
                      : undefined
                  }
                  artifactId={
                    isActive && visual.active
                      ? visual.metadata.after
                      : viewerData.current.get(rootId)?.artifactId
                  }
                  renderOverlay={
                    isActive && visual.active ? changeOverlay : undefined
                  }
                  scale={scale}
                  rootFileId={rootId}
                  isActive={isActive}
                  onError={isActive ? setPdfError : undefined}
                  onLoadSuccess={isActive ? handleLoadSuccess : undefined}
                  onScaleChange={isActive ? handleScaleChange : undefined}
                  onSynctexClick={isActive ? handleSynctexClick : undefined}
                  onTextSelect={isActive ? handleTextSelect : undefined}
                  onFirstPageSize={isActive ? handleFirstPageSize : undefined}
                  onContainerResize={
                    isActive ? handleContainerResize : undefined
                  }
                  onCurrentPageChange={
                    isActive ? handleCurrentPageChange : undefined
                  }
                  scrollToPageRef={isActive ? scrollToPageRef : undefined}
                  captureMode={isActive ? captureMode : false}
                  onCapture={isActive ? handleCapture : undefined}
                  onCancelCapture={isActive ? handleCancelCapture : undefined}
                />
              </div>
            </ErrorBoundary>
          );
        })}
      </div>
    );
  };

  return (
    <div
      ref={previewContainerRef}
      className="@container/pv relative flex h-full flex-col bg-muted/50"
    >
      <div className="flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] shrink-0 flex-nowrap items-center border-border border-b bg-background px-2">
        <div className="flex min-w-0 shrink-0 items-center gap-1">
          <span
            className="max-w-32 truncate px-1 text-xs text-muted-foreground"
            title={chatPdf.label}
          >
            {chatPdf.label}
          </span>
          {isSaving && (
            <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
              <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              <span className="@[38rem]/pv:inline hidden font-medium text-muted-foreground text-xs">
                Saving...
              </span>
            </div>
          )}
          {!isSaving && isCompiling && (
            <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
              <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              <span className="@[38rem]/pv:inline hidden font-medium text-muted-foreground text-xs">
                Compiling...
              </span>
            </div>
          )}
          {!isSaving && !isCompiling && !compileError && isTexActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 @[42rem]/pv:px-2.5 px-2 text-xs"
              onClick={() => handleCompile(true)}
              title={pdfData ? "Recompile" : "Compile"}
            >
              <RefreshCwIcon className="size-3.5" />
              <span className="@[42rem]/pv:inline hidden">
                {pdfData ? "Recompile" : "Compile"}
              </span>
            </Button>
          )}
          {!isSaving && !isCompiling && compileError && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-destructive text-xs hover:text-destructive"
              onClick={() => handleCompile(true)}
              disabled={!isTexActive}
              title="Retry compile"
            >
              <RefreshCwIcon className="size-3.5" />
              <span className="@[42rem]/pv:inline hidden">Retry</span>
            </Button>
          )}
          <Button
            variant={autoRecompile ? "secondary" : "ghost"}
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
            role="switch"
            aria-label="Auto-recompile"
            aria-checked={autoRecompile}
            title="Automatically recompile after 15 seconds without edits"
            onClick={() => setAutoRecompile(!autoRecompile)}
          >
            <span
              className={
                autoRecompile
                  ? "size-1.5 rounded-full bg-primary"
                  : "size-1.5 rounded-full bg-muted-foreground/40"
              }
            />
            Auto
          </Button>
          <Button
            variant={incremental ? "secondary" : "ghost"}
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
            role="switch"
            aria-label="Incremental compilation"
            aria-checked={incremental}
            title="Reuse validated build state; when off, requested builds run the full compilation sequence"
            onClick={() => setIncremental(!incremental)}
          >
            <span className={incremental ? "size-1.5 rounded-full bg-primary" : "size-1.5 rounded-full bg-muted-foreground/40"} />
            Incremental
          </Button>
          <Button
            variant={visualChangeReports ? "secondary" : "ghost"}
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
            role="switch"
            aria-label="Visual change reports"
            aria-checked={visualChangeReports}
            title="Show visual change reports after agent edits"
            onClick={() => setVisualChangeReports(!visualChangeReports)}
          >
            <span
              className={
                visualChangeReports
                  ? "size-1.5 rounded-full bg-primary"
                  : "size-1.5 rounded-full bg-muted-foreground/40"
              }
            />
            Changes
          </Button>
        </div>
        {visualChangeReports &&
          !chatPdf.proposal &&
          visual.metadata.state === "ready" &&
          visual.metadata.main ===
            files.find((f) => f.id === sourceRootFileId)?.relativePath && (
            <div className="flex items-center gap-1 text-xs">
              <span>{visual.items.length} changes</span>
              {visual.shown && (
                <button
                  aria-expanded={reviewPanelOpen}
                  onClick={() => setReviewPanelOpen(!reviewPanelOpen)}
                >
                  Review panel
                </button>
              )}
              <button
                aria-label="Previous change"
                disabled={!visual.items.length}
                onClick={() => {
                  visual.setShown(true);
                  const i = visual.items.findIndex(
                    (c) => c.id === visual.selected,
                  );
                  selectChange(
                    visual.items[
                      ((i < 0 ? 0 : i) - 1 + visual.items.length) %
                        visual.items.length
                    ].id,
                  );
                }}
              >
                ↑
              </button>
              <button
                aria-label="Next change"
                disabled={!visual.items.length}
                onClick={() => {
                  visual.setShown(true);
                  const i = visual.items.findIndex(
                    (c) => c.id === visual.selected,
                  );
                  selectChange(visual.items[(i + 1) % visual.items.length].id);
                }}
              >
                ↓
              </button>
            </div>
          )}
        <div data-tauri-drag-region className="min-w-2 flex-1 self-stretch" />
        <div className="ml-auto flex min-w-0 shrink-0 flex-nowrap items-center justify-end gap-1">
          {pdfData && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                title="Page Up"
              >
                <ChevronUpIcon className="size-3.5" />
              </Button>
              {isEditingPage ? (
                <input
                  type="text"
                  inputMode="numeric"
                  className="h-6 w-7 shrink-0 rounded border border-border bg-background text-center text-foreground text-xs outline-none focus:ring-1 focus:ring-ring"
                  value={pageInputValue}
                  onChange={(e) => setPageInputValue(e.target.value)}
                  onBlur={handlePageInputCommit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handlePageInputCommit();
                    if (e.key === "Escape") {
                      setIsEditingPage(false);
                      setPageInputValue(String(currentPage));
                    }
                  }}
                />
              ) : (
                <button
                  className="flex h-6 w-7 shrink-0 items-center justify-center rounded text-muted-foreground text-xs tabular-nums hover:bg-muted"
                  onClick={() => {
                    setIsEditingPage(true);
                    setPageInputValue(String(currentPage));
                  }}
                  title="Click to jump to page"
                >
                  {currentPage}
                </button>
              )}
              <span className="shrink-0 text-muted-foreground/80 text-xs tabular-nums">
                /
              </span>
              <span className="flex h-6 w-7 shrink-0 items-center justify-center text-muted-foreground text-xs tabular-nums">
                {numPages}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= numPages}
                title="Page Down"
              >
                <ChevronDownIcon className="size-3.5" />
              </Button>
              <div className="mx-1 @[34rem]/pv:block hidden h-4 w-px bg-border" />
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={zoomOut}
                disabled={scale <= 0.25}
              >
                <MinusIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={zoomIn}
                disabled={scale >= 4}
              >
                <PlusIcon className="size-3.5" />
              </Button>
              <Select
                value={fitMode ?? scale.toString()}
                onValueChange={(v) => {
                  if (v === "fit-width" || v === "fit-height") {
                    setFitMode(v);
                  } else {
                    setFitMode(null);
                    setScale(Number(v));
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-7! @[48rem]/pv:w-[7.5rem] w-[5rem] text-xs"
                >
                  <SelectValue>
                    {fitMode === "fit-width"
                      ? "Fit width"
                      : fitMode === "fit-height"
                        ? "Fit height"
                        : `${Math.round(scale * 100)}%`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectItem value="fit-width">Fit to width</SelectItem>
                  <SelectItem value="fit-height">Fit to height</SelectItem>
                  <SelectSeparator />
                  {ZOOM_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="mx-1 @[34rem]/pv:block hidden h-4 w-px bg-border" />
              {/* Capture mode */}
              <Button
                variant={captureMode ? "default" : "secondary"}
                size="sm"
                className={`h-7 gap-1.5 @[56rem]/pv:px-2.5 px-2 text-xs ${
                  captureMode
                    ? "ring-2 ring-primary/30"
                    : "bg-foreground text-background hover:bg-foreground/90"
                }`}
                onClick={() => setCaptureMode(!captureMode)}
                title={`Capture & Ask (${navigator.userAgent.includes("Mac") ? "Cmd+Shift+X" : "Ctrl+Shift+X"})`}
              >
                <CrosshairIcon className="size-3.5 shrink-0" />
                <span className="@[56rem]/pv:inline hidden">Capture & Ask</span>
                <kbd className="pointer-events-none ml-0.5 @[64rem]/pv:inline hidden rounded border border-background/30 bg-background/20 px-1 py-0.5 font-medium text-[10px] text-background leading-none">
                  {navigator.userAgent.includes("Mac") ? "Cmd+Shift+X" : "Ctrl+Shift+X"}
                </kbd>
              </Button>
              <div className="mx-1 @[34rem]/pv:block hidden h-4 w-px bg-border" />
              <PdfExportButton
                projectRoot={projectRoot}
                getPdf={() => {
                  if (visual.active) return visual.bytes.current;
                  const data = pdfData;
                  return data ? getPdfArrayBuffer(data) : null;
                }}
              />
            </>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="History"
              >
                <HistoryIcon className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96">
              <HistoryPanel maxHeight="max-h-[32rem]" />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {visualChangeReports && visual.metadata.state === "preparing" && (
        <p className="px-3 text-xs" role="status">
          Preparing visual changes…
        </p>
      )}
      {visualChangeReports && visual.metadata.error && (
        <p className="px-3 text-xs" role="status">
          {visual.metadata.error}
          <br />
          {visual.metadata.state === "stale"
            ? "Visual changes unavailable because project files changed."
            : !visual.metadata.before
              ? "Visual changes unavailable for this turn: no successful baseline."
              : "Visual changes unavailable until compilation succeeds."}
        </p>
      )}
      {compileError && pdfData && (
        <div
          role="alert"
          className="max-h-28 shrink-0 overflow-auto border-b p-2 text-xs"
        >
          <p>{compileError}</p>
          <button
            onClick={() =>
              void useAgentChatStore
                .getState()
                .sendPrompt(
                  `[Compilation errors]\n${compileError}\nFix these LaTeX compilation errors.`,
                )
            }
          >
            Fix with Chat
          </button>
          <button onClick={() => void handleCompile(true)}>Retry</button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {renderContent()}
        {visualChangeReports &&
          artifact &&
          chatPdf.current &&
          !chatPdf.busy && (
            <ProposalReport
              key={artifact.build.artifactId}
              proposal={artifact.proposal}
              main={artifact.main}
              result={artifact.build}
            />
          )}
        {visual.active && reviewPanelOpen && visual.docs.current && (
          <aside className="@[900px]/pv:static absolute inset-y-0 right-0 z-20 w-[300px] max-w-full @[900px]/pv:shrink-0 border-l bg-background">
            <VisualReviewPanel
              items={visual.items}
              selected={visual.selected}
              onSelect={selectChange}
              docs={visual.docs.current}
            />
          </aside>
        )}
      </div>
      {/* PDF selection toolbar */}
      {pdfToolbarPosition && pdfSelection && (
        <SelectionToolbar
          position={pdfToolbarPosition}
          contextLabel={pdfContextLabel}
          actions={pdfToolbarActions}
          onSendPrompt={handlePdfToolbarSendPrompt}
          onAction={handlePdfToolbarAction}
          onDismiss={handlePdfToolbarDismiss}
        />
      )}
      {/* Capture mode floating banner */}
      {captureMode && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-sm">
            <CrosshairIcon className="size-3.5 text-primary" />
            <span className="text-foreground text-xs">
              Drag to select a region
            </span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground">
              ESC
            </kbd>
            <span className="text-[10px] text-muted-foreground">or</span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground">
              {navigator.userAgent.includes("Mac") ? "Cmd+" : "Ctrl+"}X
            </kbd>
            <span className="text-[10px] text-muted-foreground">to cancel</span>
          </div>
        </div>
      )}
    </div>
  );
}
