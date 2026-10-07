import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  FileTextIcon,
  FolderIcon,
  HomeIcon,
  FolderPlusIcon,
  ImageIcon,
  PlusIcon,
  Trash2Icon,
  PencilIcon,
  UploadIcon,
  RefreshCwIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ListIcon,
  HashIcon,
  GithubIcon,
  PanelLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  AppWindowIcon,
  FlaskConicalIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { invoke } from "@/lib/backend";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useTheme } from "next-themes";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { open as openDialog } from "@/lib/backend/desktop-host";
import { getCurrentWebview } from "@/lib/backend/desktop-host";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { UvSetupDialog } from "@/components/uv-setup";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("sidebar");
const FILES_AUTO_REFRESH_INTERVAL_MS = 12_000;
const FILES_REFRESH_MIN_SPIN_MS = 400;

// ─── Table of Contents ───

interface TocItem {
  level: number;
  title: string;
  line: number;
}

function parseTableOfContents(content: string): TocItem[] {
  const lines = content.split("\n");
  const toc: TocItem[] = [];
  const sectionRegex =
    /\\(section|subsection|subsubsection|chapter|part)\*?\s*\{([^}]*)\}/;
  const levelMap: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
  };
  lines.forEach((line, index) => {
    const match = line.match(sectionRegex);
    if (match) {
      const [, type, title] = match;
      toc.push({
        level: levelMap[type] ?? 2,
        title: title.trim(),
        line: index + 1,
      });
    }
  });
  return toc;
}

// ─── File Tree Builder ───

interface TreeNode {
  name: string;
  relativePath: string;
  type: "folder" | "file";
  file?: ProjectFile;
  children: TreeNode[];
}

type FileTreeItemType = "file" | "folder";

interface FileTreeSelectionItem {
  type: FileTreeItemType;
  path: string;
}

function fileTreeSelectionKey(item: FileTreeSelectionItem) {
  return `${item.type}:${item.path}`;
}

function fileTreeSelectionItemFromKey(
  key: string,
): FileTreeSelectionItem | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;

  const type = key.slice(0, separator);
  const path = key.slice(separator + 1);
  if ((type !== "file" && type !== "folder") || !path) return null;

  return { type, path };
}

function isInsideFolder(path: string, folderPath: string) {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

function parentFolderOfPath(path: string): string | undefined {
  return path.includes("/")
    ? path.substring(0, path.lastIndexOf("/"))
    : undefined;
}

function normalizeSelectionItems(items: FileTreeSelectionItem[]) {
  const folders = items
    .filter((item) => item.type === "folder")
    .sort((a, b) => a.path.length - b.path.length)
    .filter(
      (item, index, all) =>
        !all
          .slice(0, index)
          .some((folder) => isInsideFolder(item.path, folder.path)),
    );

  const files = items.filter(
    (item) =>
      item.type === "file" &&
      !folders.some((folder) => isInsideFolder(item.path, folder.path)),
  );

  return { files, folders };
}

function buildFileTree(files: ProjectFile[], folders: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  function getOrCreateFolder(path: string): TreeNode[] {
    if (!path) return root;
    if (folderMap.has(path)) return folderMap.get(path)!.children;

    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");
    const parentChildren = getOrCreateFolder(parentPath);

    const folder: TreeNode = {
      name,
      relativePath: path,
      type: "folder",
      children: [],
    };
    folderMap.set(path, folder);
    parentChildren.push(folder);
    return folder.children;
  }

  // Ensure all known folders exist as nodes (including empty ones)
  for (const folderPath of folders) {
    getOrCreateFolder(folderPath);
  }

  for (const file of files) {
    const parts = file.relativePath.split("/");
    const fileName = parts[parts.length - 1];
    const folderPath = parts.slice(0, -1).join("/");
    const parentChildren = getOrCreateFolder(folderPath);

    parentChildren.push({
      name: fileName,
      relativePath: file.relativePath,
      type: "file",
      file,
      children: [],
    });
  }

  // Sort: folders first, then alphabetical
  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.type === "folder") sortNodes(node.children);
    }
  }
  sortNodes(root);

  return root;
}

// ─── File Icon ───

function getFileIcon(file: ProjectFile) {
  if (file.type === "image") return <ImageIcon className="size-4 shrink-0" />;
  if (file.type === "pdf")
    return <FileSpreadsheetIcon className="size-4 shrink-0" />;
  if (file.type === "style")
    return <FileCodeIcon className="size-4 shrink-0" />;
  if (file.type === "other") return <FileIcon className="size-4 shrink-0" />;
  return <FileTextIcon className="size-4 shrink-0" />;
}

// ─── App Version (resolved once from Tauri) ───

let _appVersion = "";
getVersion().then((v) => {
  _appVersion = v;
});
function useAppVersion() {
  const [version, setVersion] = useState(_appVersion);
  useEffect(() => {
    if (!version) getVersion().then(setVersion);
  }, [version]);
  return version || "…";
}

// ─── Sidebar ───

function LayoutPaneSwitcher({
  controls,
  collapsed = false,
  onQuickToggleSidebar,
  side = "bottom",
  align = "end",
  buttonClassName,
}: {
  controls?: LayoutControls;
  collapsed?: boolean;
  onQuickToggleSidebar?: () => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  buttonClassName?: string;
}) {
  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        "transition-transform duration-300 ease-in-out hover:scale-105",
        buttonClassName,
      )}
      onClick={onQuickToggleSidebar}
      title="Layout"
      aria-label="Layout"
    >
      <PanelLeftIcon
        className={cn(
          "size-3.5 transition-transform duration-300 ease-in-out",
          collapsed && "rotate-180",
        )}
      />
    </Button>
  );

  if (!controls) return trigger;

  return (
    <HoverCard openDelay={80} closeDelay={140}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent
        side={side}
        align={align}
        sideOffset={8}
        className="w-44 rounded-2xl border-border/70 bg-popover/95 p-1.5 shadow-2xl backdrop-blur"
      >
        <div className="space-y-1">
          <LayoutToggleRow
            icon={FileCodeIcon}
            label="Code"
            checked={controls.codeVisible}
            onCheckedChange={controls.setCodeVisible}
          />
          <LayoutToggleRow
            icon={FileTextIcon}
            label="PDF"
            checked={controls.pdfVisible}
            onCheckedChange={controls.setPdfVisible}
          />
          <LayoutToggleRow
            icon={PanelLeftIcon}
            label="Sidebar"
            checked={controls.sidebarVisible}
            onCheckedChange={controls.setSidebarVisible}
          />
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function LayoutToggleRow({
  icon: Icon,
  label,
  checked,
  onCheckedChange,
}: {
  icon: LucideIcon;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors hover:bg-accent/70",
        checked && "bg-accent/45 text-accent-foreground",
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium text-sm">
        {label}
      </span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-foreground" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-background transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  layoutControls?: LayoutControls;
}

interface LayoutControls {
  codeVisible: boolean;
  pdfVisible: boolean;
  sidebarVisible: boolean;
  setCodeVisible: (visible: boolean) => void;
  setPdfVisible: (visible: boolean) => void;
  setSidebarVisible: (visible: boolean) => void;
}

export function Sidebar({
  collapsed = false,
  onToggleCollapsed,
  layoutControls,
}: SidebarProps) {
  const appVersion = useAppVersion();
  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const deleteFile = useDocumentStore((s) => s.deleteFile);
  const deleteFolder = useDocumentStore((s) => s.deleteFolder);
  const renameFile = useDocumentStore((s) => s.renameFile);
  const renameProject = useDocumentStore((s) => s.renameProject);
  const createNewFile = useDocumentStore((s) => s.createNewFile);
  const createFolder = useDocumentStore((s) => s.createFolder);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const activeFileContent = useDocumentStore((s) => {
    const active = s.files.find((f) => f.id === s.activeFileId);
    return active?.content ?? "";
  });
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );
  const _insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const moveFile = useDocumentStore((s) => s.moveFile);
  const moveFolder = useDocumentStore((s) => s.moveFolder);
  const closeProject = useDocumentStore((s) => s.closeProject);
  const refreshFiles = useDocumentStore((s) => s.refreshFiles);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const folders = useDocumentStore((s) => s.folders);
  const [isRefreshingFiles, setIsRefreshingFiles] = useState(false);
  const refreshFilesInFlightRef = useRef<Promise<void> | null>(null);
  const { theme, setTheme } = useTheme();
  const projectName = useMemo(() => {
    const normalized = projectRoot?.replace(/[\\/]+$/, "");
    return normalized?.split(/[/\\]/).pop() || "Desktop";
  }, [projectRoot]);

  const runRefreshFiles = useCallback(
    async ({ showSpinner = true }: { showSpinner?: boolean } = {}) => {
      if (!projectRoot) return;
      if (refreshFilesInFlightRef.current) {
        await refreshFilesInFlightRef.current;
        return;
      }

      const startedAt = Date.now();
      if (showSpinner) setIsRefreshingFiles(true);

      const refreshTask = (async () => {
        try {
          await refreshFiles();
        } catch (err) {
          log.error("Refresh files failed", { error: String(err) });
        } finally {
          if (showSpinner) {
            const elapsed = Date.now() - startedAt;
            if (elapsed < FILES_REFRESH_MIN_SPIN_MS) {
              await new Promise((resolve) =>
                window.setTimeout(resolve, FILES_REFRESH_MIN_SPIN_MS - elapsed),
              );
            }
            setIsRefreshingFiles(false);
          }
          refreshFilesInFlightRef.current = null;
        }
      })();

      refreshFilesInFlightRef.current = refreshTask;
      await refreshTask;
    },
    [projectRoot, refreshFiles],
  );

  useEffect(() => {
    if (!projectRoot) return;

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void runRefreshFiles({ showSpinner: false });
      }
    };

    const intervalId = window.setInterval(
      refreshIfVisible,
      FILES_AUTO_REFRESH_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [projectRoot, runRefreshFiles]);

  // ─── Native OS file drop (Tauri onDragDropEvent) ───
  const sidebarFilesRef = useRef<HTMLDivElement>(null);
  const nativeDropTargetRef = useRef<string | null>(null);
  const [nativeDragOver, setNativeDragOver] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;

        if (type === "over" || type === "enter") {
          const payload = event.payload as {
            position: { x: number; y: number };
          };
          const { x, y } = payload.position;
          // Tauri reports physical pixels; elementFromPoint expects logical (CSS) pixels
          const logicalX = x / window.devicePixelRatio;
          const logicalY = y / window.devicePixelRatio;

          const el = document.elementFromPoint(logicalX, logicalY);
          const filesArea = sidebarFilesRef.current;

          if (!filesArea || !el || !filesArea.contains(el)) {
            // Not over the sidebar file tree
            if (nativeDropTargetRef.current !== null) {
              nativeDropTargetRef.current = null;
              setNativeDragOver(null);
            }
            return;
          }

          // Walk up from the hovered element to find the closest drop-folder target
          const folderEl = el.closest(
            "[data-drop-folder]",
          ) as HTMLElement | null;
          const folder = folderEl?.dataset.dropFolder ?? "__root__";
          nativeDropTargetRef.current = folder;
          setNativeDragOver(folder);
        } else if (type === "drop") {
          const payload = event.payload as {
            paths: string[];
            position: { x: number; y: number };
          };
          const { paths, position } = payload;
          const logicalX = position.x / window.devicePixelRatio;
          const logicalY = position.y / window.devicePixelRatio;

          const el = document.elementFromPoint(logicalX, logicalY);
          const filesArea = sidebarFilesRef.current;

          if (!filesArea || !el || !filesArea.contains(el)) {
            setNativeDragOver(null);
            nativeDropTargetRef.current = null;
            return;
          }

          const targetFolder =
            nativeDropTargetRef.current === "__root__"
              ? undefined
              : (nativeDropTargetRef.current ?? undefined);

          // Mark as handled so chat-composer doesn't also process it
          (window as any).__sidebarHandledDrop = true;
          setTimeout(() => {
            (window as any).__sidebarHandledDrop = false;
          }, 200);

          try {
            await importFiles(paths, targetFolder);
          } catch (err) {
            log.error("Native drop import failed", { error: String(err) });
          }

          setNativeDragOver(null);
          nativeDropTargetRef.current = null;
        } else if (type === "leave") {
          setNativeDragOver(null);
          nativeDropTargetRef.current = null;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not in Tauri environment (dev mode)
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [importFiles]);

  // Track selected folder for paste target
  const [pasteTargetFolder, setPasteTargetFolder] = useState<
    string | undefined
  >();

  // ─── Cmd+V paste files from OS clipboard ───
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "v") return;

      // Don't intercept paste in text inputs / editor (contentEditable)
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      )
        return;

      try {
        const paths = await invoke<string[]>("read_clipboard_file_paths");
        if (paths.length > 0) {
          e.preventDefault();
          await importFiles(paths, pasteTargetFolder);
        }
      } catch (err) {
        log.error("Read clipboard failed", { error: String(err) });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [importFiles, pasteTargetFolder]);

  const [selectedItemKeys, setSelectedItemKeys] = useState<Set<string>>(
    new Set(),
  );

  const existingItemKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const file of files) {
      keys.add(fileTreeSelectionKey({ type: "file", path: file.relativePath }));
    }
    for (const folder of folders) {
      keys.add(fileTreeSelectionKey({ type: "folder", path: folder }));
    }
    return keys;
  }, [files, folders]);

  useEffect(() => {
    setSelectedItemKeys((prev) => {
      const next = new Set(
        [...prev].filter((key) => existingItemKeys.has(key)),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [existingItemKeys]);

  const selectedItemsFromKeys = useCallback(
    (keys: Iterable<string>) =>
      Array.from(keys)
        .map(fileTreeSelectionItemFromKey)
        .filter((item): item is FileTreeSelectionItem => {
          if (!item) return false;
          return existingItemKeys.has(fileTreeSelectionKey(item));
        }),
    [existingItemKeys],
  );

  const getEffectiveSelectionItems = useCallback(
    (fallback: FileTreeSelectionItem) => {
      const fallbackKey = fileTreeSelectionKey(fallback);
      if (selectedItemKeys.has(fallbackKey)) {
        return selectedItemsFromKeys(selectedItemKeys);
      }
      return [fallback];
    },
    [selectedItemKeys, selectedItemsFromKeys],
  );

  const getEffectiveSelectionCount = useCallback(
    (fallback: FileTreeSelectionItem) =>
      getEffectiveSelectionItems(fallback).length,
    [getEffectiveSelectionItems],
  );

  const selectedAffectedFileCount = useCallback(
    (items: FileTreeSelectionItem[]) => {
      const { files: selectedFiles, folders: selectedFolders } =
        normalizeSelectionItems(items);
      const affected = new Set(selectedFiles.map((item) => item.path));

      for (const folder of selectedFolders) {
        for (const file of files) {
          if (isInsideFolder(file.relativePath, folder.path)) {
            affected.add(file.relativePath);
          }
        }
      }

      return affected.size;
    },
    [files],
  );

  const canDeleteSelection = useCallback(
    (fallback: FileTreeSelectionItem) => {
      const items = getEffectiveSelectionItems(fallback);
      const affected = selectedAffectedFileCount(items);
      return items.length > 0 && affected < files.length;
    },
    [files.length, getEffectiveSelectionItems, selectedAffectedFileCount],
  );

  const [pendingDeleteItems, setPendingDeleteItems] = useState<
    FileTreeSelectionItem[] | null
  >(null);
  const [isDeletingSelection, setIsDeletingSelection] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const canDeleteItems = useCallback(
    (items: FileTreeSelectionItem[]) => {
      const affected = selectedAffectedFileCount(items);
      return items.length > 0 && affected < files.length;
    },
    [files.length, selectedAffectedFileCount],
  );

  const requestDeleteItems = useCallback(
    (items: FileTreeSelectionItem[]) => {
      if (!canDeleteItems(items)) return;
      const { files: selectedFiles, folders: selectedFolders } =
        normalizeSelectionItems(items);
      setPendingDeleteItems([...selectedFolders, ...selectedFiles]);
      setDeleteError("");
    },
    [canDeleteItems],
  );

  const handleTreeItemContextMenu = useCallback(
    (item: FileTreeSelectionItem) => {
      const key = fileTreeSelectionKey(item);
      setPasteTargetFolder(
        item.type === "folder" ? item.path : parentFolderOfPath(item.path),
      );
      setSelectedItemKeys((prev) => (prev.has(key) ? prev : new Set([key])));
    },
    [],
  );

  const handleTreeItemClick = useCallback(
    (
      item: FileTreeSelectionItem,
      event: React.MouseEvent,
      onPrimaryClick: () => void,
    ) => {
      setPasteTargetFolder(
        item.type === "folder" ? item.path : parentFolderOfPath(item.path),
      );

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const key = fileTreeSelectionKey(item);
        setSelectedItemKeys((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }

      setSelectedItemKeys(new Set());
      onPrimaryClick();
    },
    [],
  );

  const requestDeleteSelection = useCallback(
    (fallback: FileTreeSelectionItem) => {
      requestDeleteItems(getEffectiveSelectionItems(fallback));
    },
    [getEffectiveSelectionItems, requestDeleteItems],
  );

  const confirmDeleteSelection = useCallback(async () => {
    if (!pendingDeleteItems || isDeletingSelection) return;

    setIsDeletingSelection(true);
    setDeleteError("");
    try {
      const { files: selectedFiles, folders: selectedFolders } =
        normalizeSelectionItems(pendingDeleteItems);

      for (const file of selectedFiles) {
        await Promise.resolve(deleteFile(file.path) as unknown);
      }
      for (const folder of selectedFolders) {
        await deleteFolder(folder.path);
      }

      setPendingDeleteItems(null);
      setSelectedItemKeys(new Set());
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeletingSelection(false);
    }
  }, [deleteFile, deleteFolder, isDeletingSelection, pendingDeleteItems]);

  useEffect(() => {
    const handleDeleteKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }

      const selectedItems = selectedItemsFromKeys(selectedItemKeys);
      if (selectedItems.length > 0) {
        event.preventDefault();
        requestDeleteItems(selectedItems);
        return;
      }

      if (activeFileId) {
        event.preventDefault();
        requestDeleteItems([{ type: "file", path: activeFileId }]);
      }
    };

    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  }, [
    activeFileId,
    requestDeleteItems,
    selectedItemKeys,
    selectedItemsFromKeys,
  ]);

  // dnd-kit drag-and-drop (uses PointerSensor — works in Tauri WKWebView)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [activeDrag, setActiveDrag] = useState<{
    id: string;
    type: "file" | "folder";
    name: string;
    count: number;
  } | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { type, name } = event.active.data.current as {
        type: "file" | "folder";
        name: string;
      };
      const item: FileTreeSelectionItem = {
        type,
        path: event.active.id as string,
      };
      const key = fileTreeSelectionKey(item);
      setActiveDrag({
        id: item.path,
        type,
        name,
        count: selectedItemKeys.has(key) ? getEffectiveSelectionCount(item) : 1,
      });
    },
    [getEffectiveSelectionCount, selectedItemKeys],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDrag(null);
      const { active, over } = event;
      if (!over) return;

      const draggedPath = active.id as string;
      const draggedType = (active.data.current as { type: string }).type;
      const targetId = over.id as string;
      const targetFolder = targetId === "__root__" ? null : targetId;

      const draggedItem: FileTreeSelectionItem = {
        type: draggedType === "folder" ? "folder" : "file",
        path: draggedPath,
      };
      const draggedKey = fileTreeSelectionKey(draggedItem);
      const movingItems = selectedItemKeys.has(draggedKey)
        ? selectedItemsFromKeys(selectedItemKeys)
        : [draggedItem];
      const { files: movingFiles, folders: movingFolders } =
        normalizeSelectionItems(movingItems);

      if (
        targetFolder &&
        movingFolders.some((folder) =>
          isInsideFolder(targetFolder, folder.path),
        )
      ) {
        return;
      }

      try {
        for (const file of movingFiles) {
          const parent = parentFolderOfPath(file.path) ?? null;
          if (targetFolder === parent) continue;
          await moveFile(file.path, targetFolder);
        }

        for (const folder of movingFolders) {
          const parent = parentFolderOfPath(folder.path) ?? null;
          if (targetFolder === parent) continue;
          await moveFolder(folder.path, targetFolder);
        }

        setSelectedItemKeys(new Set());
      } catch (err) {
        log.error("DnD move failed", { error: String(err) });
      }
    },
    [moveFile, moveFolder, selectedItemKeys, selectedItemsFromKeys],
  );

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogFolder, setAddDialogFolder] = useState<string | undefined>();
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogParent, setFolderDialogParent] = useState<
    string | undefined
  >();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [projectRenameDialogOpen, setProjectRenameDialogOpen] = useState(false);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [projectRenameError, setProjectRenameError] = useState("");
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");

  // Folder expand/collapse
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const tree = useMemo(() => buildFileTree(files, folders), [files, folders]);

  // Auto-expand parent folders of the active file so it stays visible
  useEffect(() => {
    if (!activeFileId) return;
    const parts = activeFileId.split("/");
    if (parts.length <= 1) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (!next.has(folder)) {
          next.add(folder);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeFileId]);

  const toggleFolder = useCallback((path: string) => {
    setPasteTargetFolder(path);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Outline
  const toc = useMemo(
    () => parseTableOfContents(activeFileContent),
    [activeFileContent],
  );
  const handleTocClick = useCallback(
    (line: number) => {
      const lines = activeFileContent.split("\n");
      let position = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) {
        position += lines[i].length + 1;
      }
      requestJumpToPosition(position);
    },
    [activeFileContent, requestJumpToPosition],
  );

  // Check if a name already exists in the given folder
  // Case-insensitive on macOS/Windows (default case-insensitive filesystems)
  const isCaseInsensitiveFs =
    navigator.platform.startsWith("Mac") ||
    navigator.platform.startsWith("Win");
  const nameExistsIn = useCallback(
    (name: string, folder?: string) => {
      const targetPath = folder ? `${folder}/${name}` : name;
      const cmp = (a: string, b: string) =>
        isCaseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
      const existsAsFile = files.some((f) => cmp(f.relativePath, targetPath));
      const existsAsFolder = folders.some((f) => cmp(f, targetPath));
      return existsAsFile || existsAsFolder;
    },
    [files, folders, isCaseInsensitiveFs],
  );

  // Handlers
  const [nameError, setNameError] = useState("");

  const handleAddFile = () => {
    const name = newFileName.trim();
    if (!name) return;
    if (nameExistsIn(name, addDialogFolder)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    // Auto-append .tex if no extension provided
    const finalName = /\.\w+$/.test(name) ? name : `${name}.tex`;
    const lower = finalName.toLowerCase();
    const type: "tex" | "image" = /\.(png|jpg|jpeg|gif|svg|bmp|webp)$/.test(
      lower,
    )
      ? "image"
      : "tex";
    createNewFile(finalName, type, addDialogFolder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(false);
    setAddDialogFolder(undefined);
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (nameExistsIn(name, folderDialogParent)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    createFolder(name, folderDialogParent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(false);
    setFolderDialogParent(undefined);
  };

  const handleImport = async (targetFolder?: string) => {
    const selected = await openDialog({
      multiple: true,
    });
    if (selected && projectRoot) {
      const paths = Array.isArray(selected) ? selected : [selected];
      await importFiles(paths, targetFolder);
    }
  };

  const openRenameDialog = (id: string, name: string) => {
    setRenameFileId(id);
    setRenameValue(name);
    setNameError("");
    setRenameDialogOpen(true);
  };

  const openProjectRenameDialog = () => {
    if (!projectRoot) return;
    setProjectRenameValue(projectName);
    setProjectRenameError("");
    setProjectRenameDialogOpen(true);
  };

  const handleProjectRename = async () => {
    const name = projectRenameValue.trim();
    if (!name || isRenamingProject) return;
    setIsRenamingProject(true);
    setProjectRenameError("");
    try {
      await renameProject(name);
      setProjectRenameDialogOpen(false);
    } catch (err) {
      setProjectRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRenamingProject(false);
    }
  };

  const handleRename = () => {
    const name = renameValue.trim();
    if (!renameFileId || !name) return;
    // Check duplicate: find the parent folder of the file being renamed
    const file = files.find((f) => f.id === renameFileId);
    const parentFolder = file?.relativePath.includes("/")
      ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
      : undefined;
    const isSameName = isCaseInsensitiveFs
      ? name.toLowerCase() === file?.name.toLowerCase()
      : name === file?.name;
    if (nameExistsIn(name, parentFolder) && !isSameName) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    renameFile(renameFileId, name);
    setRenameDialogOpen(false);
    setRenameFileId(null);
    setRenameValue("");
    setNameError("");
  };

  const openNewFileDialog = (folder?: string) => {
    setAddDialogFolder(folder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(true);
  };

  const openNewFolderDialog = (parent?: string) => {
    setFolderDialogParent(parent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(true);
  };

  // ─── Render ───

  const pendingDeleteCount = pendingDeleteItems?.length ?? 0;
  const pendingDeletePreview = pendingDeleteItems?.slice(0, 4) ?? [];

  const collapsedRail = (
    <div className="flex h-full w-full min-w-0 flex-col items-center bg-sidebar text-sidebar-foreground">
      <div className="flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] w-full items-center justify-center border-sidebar-border border-b">
        <LayoutPaneSwitcher
          controls={layoutControls}
          collapsed={collapsed}
          onQuickToggleSidebar={onToggleCollapsed}
          side="right"
          align="start"
          buttonClassName="size-7"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 transition-transform duration-300 ease-in-out hover:scale-105"
          onClick={onToggleCollapsed}
          title="Files"
          aria-label="Expand Files"
        >
          <FolderIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 transition-transform duration-300 ease-in-out hover:scale-105"
          onClick={onToggleCollapsed}
          title="Outline"
          aria-label="Expand Outline"
        >
          <ListIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 transition-transform duration-300 ease-in-out hover:scale-105"
          onClick={onToggleCollapsed}
          title="Environment"
          aria-label="Expand Environment"
        >
          <AppWindowIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex h-9 w-full items-center justify-center border-sidebar-border border-t">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 transition-transform duration-300 ease-in-out hover:scale-105"
          onClick={closeProject}
          title="Close Project"
          aria-label="Close Project"
        >
          <HomeIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="relative h-full overflow-hidden bg-sidebar text-sidebar-foreground">
      <div
        className={cn(
          "absolute inset-y-0 left-0 z-10 w-full transition-[opacity,transform] duration-300 ease-in-out",
          collapsed
            ? "translate-x-0 opacity-100"
            : "pointer-events-none -translate-x-1 opacity-0",
        )}
        aria-hidden={!collapsed}
      >
        {collapsedRail}
      </div>
      <div
        className={cn(
          "h-full w-full min-w-0 transition-[opacity,transform] duration-300 ease-in-out",
          collapsed
            ? "pointer-events-none -translate-x-2 opacity-0"
            : "translate-x-0 opacity-100",
        )}
        aria-hidden={collapsed}
      >
        <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
          {/* Header — padded top for macOS overlay titlebar */}
          <div className="grid h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-2 border-sidebar-border border-b px-3">
            <div className="flex items-center justify-start">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 transition-all duration-150 ease-out hover:scale-105"
                onClick={closeProject}
                title="Close Project"
                aria-label="Close Project"
              >
                <HomeIcon className="size-3.5" />
              </Button>
            </div>
            <button
              type="button"
              className={cn(
                "w-full min-w-0 rounded-md px-2 py-1 font-semibold text-sm transition-colors",
                projectRoot
                  ? "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  : "cursor-default",
              )}
              onClick={openProjectRenameDialog}
              disabled={!projectRoot}
              title={projectRoot ? "Rename project folder" : undefined}
              aria-label="Rename project folder"
            >
              <span className="block truncate">{projectName}</span>
            </button>
            <div className="flex items-center justify-end">
              <LayoutPaneSwitcher
                controls={layoutControls}
                collapsed={collapsed}
                onQuickToggleSidebar={onToggleCollapsed}
                side="bottom"
                align="end"
                buttonClassName="size-6"
              />
            </div>
          </div>

          {/* Resizable sections */}
          <PanelGroup direction="vertical" className="min-h-0 flex-1">
            {/* Files */}
            <Panel defaultSize={70} minSize={15}>
              <div
                ref={sidebarFilesRef}
                className="flex h-full flex-col"
                data-sidebar-files
              >
                <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-sidebar-border border-b px-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium text-xs">Files</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-5"
                      title="Refresh"
                      disabled={isRefreshingFiles}
                      onClick={() => void runRefreshFiles()}
                    >
                      <RefreshCwIcon
                        className={cn(
                          "size-3",
                          isRefreshingFiles && "animate-spin",
                        )}
                      />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5"
                          title="Add"
                        >
                          <PlusIcon className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openNewFileDialog()}>
                          <FileTextIcon className="mr-2 size-4" />
                          New LaTeX File
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openNewFolderDialog()}>
                          <FolderPlusIcon className="mr-2 size-4" />
                          New Folder
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handleImport()}>
                          <UploadIcon className="mr-2 size-4" />
                          Import File
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <DndContext
                  sensors={sensors}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <DroppableRoot
                        nativeDragOver={nativeDragOver === "__root__"}
                      >
                        {tree.map((node) => (
                          <FileTreeNode
                            key={node.relativePath}
                            node={node}
                            depth={0}
                            activeFileId={activeFileId}
                            selectedItemKeys={selectedItemKeys}
                            expandedFolders={expandedFolders}
                            onToggleFolder={toggleFolder}
                            onSelectFile={(id: string) => {
                              const parent = parentFolderOfPath(id);
                              setPasteTargetFolder(parent);
                              setActiveFile(id);
                            }}
                            onItemClick={handleTreeItemClick}
                            onItemContextMenu={handleTreeItemContextMenu}
                            onNewFile={openNewFileDialog}
                            onNewFolder={openNewFolderDialog}
                            onImport={handleImport}
                            onRename={openRenameDialog}
                            onDeleteSelection={requestDeleteSelection}
                            canDeleteSelection={canDeleteSelection}
                            getEffectiveSelectionCount={
                              getEffectiveSelectionCount
                            }
                            nativeDragOver={nativeDragOver}
                          />
                        ))}
                      </DroppableRoot>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => openNewFileDialog()}>
                        <FileTextIcon className="mr-2 size-4" />
                        New File
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => openNewFolderDialog()}>
                        <FolderPlusIcon className="mr-2 size-4" />
                        New Folder
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => handleImport()}>
                        <UploadIcon className="mr-2 size-4" />
                        Import File
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  <DragOverlay dropAnimation={null}>
                    {activeDrag && (
                      <div className="flex items-center gap-2 rounded-md bg-sidebar px-2 py-1 text-sm shadow-lg ring-1 ring-ring">
                        {activeDrag.type === "folder" ? (
                          <FolderIcon className="size-4 shrink-0" />
                        ) : (
                          <FileTextIcon className="size-4 shrink-0" />
                        )}
                        <span className="truncate">
                          {activeDrag.count > 1
                            ? `${activeDrag.count} selected`
                            : activeDrag.name}
                        </span>
                      </div>
                    )}
                  </DragOverlay>
                </DndContext>
              </div>
            </Panel>

            <PanelResizeHandle className="h-px bg-sidebar-border transition-colors hover:bg-ring data-resize-handle-active:bg-ring" />

            {/* Outline */}
            <Panel defaultSize={30} minSize={10}>
              <div className="flex h-full flex-col">
                <div className="flex h-8 shrink-0 items-center justify-center gap-2 px-3">
                  <ListIcon className="size-3.5 text-muted-foreground" />
                  <span className="font-medium text-xs">Outline</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {toc.length > 0 ? (
                    toc.map((item, index) => (
                      <button
                        key={index}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
                        style={{
                          paddingLeft: `${(item.level - 1) * 12 + 8}px`,
                        }}
                        onClick={() => handleTocClick(item.line)}
                      >
                        <HashIcon className="size-3 shrink-0 text-muted-foreground" />
                        <span className="truncate">{item.title}</span>
                      </button>
                    ))
                  ) : (
                    <div className="px-2 py-1 text-muted-foreground text-xs">
                      No sections found
                    </div>
                  )}
                </div>
              </div>
            </Panel>

          </PanelGroup>

          {/* Environment section — Python + Skills */}
          <EnvironmentSection projectPath={projectRoot} />

          {/* Footer */}
          <div className="flex h-9 items-center justify-between border-sidebar-border border-t px-3 text-muted-foreground text-xs">
            <span className="truncate">codex-prism v{appVersion}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon" className="size-6" asChild>
                <a
                  href="https://git.jolibrain.com/beniz/codex-prism"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="GitHub"
                >
                  <GithubIcon className="size-3.5" />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => {
                  if (theme === "system") setTheme("light");
                  else if (theme === "light") setTheme("dark");
                  else setTheme("system");
                }}
                title={
                  theme === "system"
                    ? "System theme"
                    : theme === "light"
                      ? "Light mode"
                      : "Dark mode"
                }
              >
                {theme === "system" ? (
                  <MonitorIcon className="size-3.5" />
                ) : theme === "light" ? (
                  <SunIcon className="size-3.5" />
                ) : (
                  <MoonIcon className="size-3.5" />
                )}
              </Button>
            </div>
          </div>

          {/* New File Dialog */}
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogContent className="overflow-hidden sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  New File{addDialogFolder ? ` in ${addDialogFolder}` : ""}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Input
                  placeholder="filename.tex"
                  value={newFileName}
                  onChange={(e) => {
                    setNewFileName(e.target.value);
                    setNameError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddFile();
                  }}
                  autoFocus
                />
                {nameError && (
                  <p className="text-destructive text-xs">{nameError}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setAddDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={handleAddFile} disabled={!newFileName.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* New Folder Dialog */}
          <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  New Folder
                  {folderDialogParent ? ` in ${folderDialogParent}` : ""}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Input
                  placeholder="folder name"
                  value={newFolderName}
                  onChange={(e) => {
                    setNewFolderName(e.target.value);
                    setNameError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateFolder();
                  }}
                  autoFocus
                />
                {nameError && (
                  <p className="text-destructive text-xs">{nameError}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setFolderDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim()}
                >
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Rename Project Dialog */}
          <Dialog
            open={projectRenameDialogOpen}
            onOpenChange={(open) => {
              if (!isRenamingProject) setProjectRenameDialogOpen(open);
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Rename Project</DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Input
                  value={projectRenameValue}
                  onChange={(e) => {
                    setProjectRenameValue(e.target.value);
                    setProjectRenameError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleProjectRename();
                  }}
                  autoFocus
                />
                {projectRenameError && (
                  <p className="text-destructive text-xs">
                    {projectRenameError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setProjectRenameDialogOpen(false)}
                  disabled={isRenamingProject}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleProjectRename}
                  disabled={!projectRenameValue.trim() || isRenamingProject}
                >
                  {isRenamingProject ? "Renaming..." : "Rename"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Rename Dialog */}
          <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Rename</DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Input
                  value={renameValue}
                  onChange={(e) => {
                    setRenameValue(e.target.value);
                    setNameError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename();
                  }}
                  autoFocus
                />
                {nameError && (
                  <p className="text-destructive text-xs">{nameError}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setRenameDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={handleRename}>Rename</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Delete confirmation */}
          <Dialog
            open={!!pendingDeleteItems}
            onOpenChange={(open) => {
              if (!open && !isDeletingSelection) {
                setPendingDeleteItems(null);
                setDeleteError("");
              }
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  Delete {pendingDeleteCount === 1 ? "Item" : "Items"}
                </DialogTitle>
                <DialogDescription>
                  {pendingDeleteCount === 1
                    ? "This item will be removed from disk."
                    : `${pendingDeleteCount} selected items will be removed from disk.`}
                </DialogDescription>
              </DialogHeader>
              {pendingDeletePreview.length > 0 && (
                <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-muted/40 px-3 py-2">
                  <div className="space-y-1">
                    {pendingDeletePreview.map((item) => (
                      <div
                        key={fileTreeSelectionKey(item)}
                        className="min-w-0 break-all font-mono text-muted-foreground text-xs"
                      >
                        {item.type === "folder" ? "Folder" : "File"}:{" "}
                        {item.path}
                      </div>
                    ))}
                    {pendingDeleteCount > pendingDeletePreview.length && (
                      <div className="text-muted-foreground text-xs">
                        +{pendingDeleteCount - pendingDeletePreview.length} more
                      </div>
                    )}
                  </div>
                </div>
              )}
              {deleteError && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                  {deleteError}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (isDeletingSelection) return;
                    setPendingDeleteItems(null);
                    setDeleteError("");
                  }}
                  disabled={isDeletingSelection}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void confirmDeleteSelection()}
                  disabled={!pendingDeleteItems || isDeletingSelection}
                >
                  {isDeletingSelection ? "Deleting..." : "Delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}

// ─── File Tree Node ───

// ─── dnd-kit helpers ───

function DroppableRoot({
  children,
  nativeDragOver,
}: {
  children: React.ReactNode;
  nativeDragOver?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "__root__" });
  return (
    <div
      ref={setNodeRef}
      data-drop-folder="__root__"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto p-1",
        (isOver || nativeDragOver) && "bg-accent/30",
      )}
    >
      {children}
    </div>
  );
}

function DroppableFolder({
  id,
  children,
  nativeDragOver,
}: {
  id: string;
  children: React.ReactNode;
  nativeDragOver?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-drop-folder={id}
      className={cn((isOver || nativeDragOver) && "rounded-md bg-accent/30")}
    >
      {children}
    </div>
  );
}

// ─── File Tree Node ───

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  activeFileId: string;
  selectedItemKeys: Set<string>;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (id: string) => void;
  onItemClick: (
    item: FileTreeSelectionItem,
    event: React.MouseEvent,
    onPrimaryClick: () => void,
  ) => void;
  onItemContextMenu: (item: FileTreeSelectionItem) => void;
  onNewFile: (folder?: string) => void;
  onNewFolder: (parent?: string) => void;
  onImport: (folder?: string) => void;
  onRename: (id: string, name: string) => void;
  onDeleteSelection: (fallback: FileTreeSelectionItem) => void;
  canDeleteSelection: (fallback: FileTreeSelectionItem) => boolean;
  getEffectiveSelectionCount: (fallback: FileTreeSelectionItem) => number;
  nativeDragOver?: string | null;
}

function FileTreeNode({
  node,
  depth,
  activeFileId,
  selectedItemKeys,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onItemClick,
  onItemContextMenu,
  onNewFile,
  onNewFolder,
  onImport,
  onRename,
  onDeleteSelection,
  canDeleteSelection,
  getEffectiveSelectionCount,
  nativeDragOver,
}: FileTreeNodeProps) {
  const isExpanded = expandedFolders.has(node.relativePath);

  if (node.type === "folder") {
    const folderItem: FileTreeSelectionItem = {
      type: "folder",
      path: node.relativePath,
    };
    const isSelected = selectedItemKeys.has(fileTreeSelectionKey(folderItem));
    const effectiveSelectionCount = getEffectiveSelectionCount(folderItem);
    const batchOperation = effectiveSelectionCount > 1;

    return (
      <DroppableFolder
        id={node.relativePath}
        nativeDragOver={nativeDragOver === node.relativePath}
      >
        <DraggableItem id={node.relativePath} type="folder" name={node.name}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                aria-pressed={isSelected}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50",
                  isSelected &&
                    "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
                onClick={(event) =>
                  onItemClick(folderItem, event, () =>
                    onToggleFolder(node.relativePath),
                  )
                }
                onContextMenu={() => onItemContextMenu(folderItem)}
              >
                {isExpanded ? (
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <FolderIcon className="size-4 shrink-0" />
                <span className="truncate">{node.name}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onNewFile(node.relativePath)}>
                <FileTextIcon className="mr-2 size-4" />
                New File Here
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onNewFolder(node.relativePath)}>
                <FolderPlusIcon className="mr-2 size-4" />
                New Folder
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onImport(node.relativePath)}>
                <UploadIcon className="mr-2 size-4" />
                Import File Here
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onRename(node.relativePath, node.name)}
                disabled={batchOperation}
              >
                <PencilIcon className="mr-2 size-4" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => onDeleteSelection(folderItem)}
                disabled={!canDeleteSelection(folderItem)}
              >
                <Trash2Icon className="mr-2 size-4" />
                {batchOperation
                  ? `Delete ${effectiveSelectionCount} selected`
                  : "Delete"}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </DraggableItem>
        {isExpanded &&
          node.children.map((child) => (
            <FileTreeNode
              key={child.relativePath}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              selectedItemKeys={selectedItemKeys}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
              onItemClick={onItemClick}
              onItemContextMenu={onItemContextMenu}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onImport={onImport}
              onRename={onRename}
              onDeleteSelection={onDeleteSelection}
              canDeleteSelection={canDeleteSelection}
              getEffectiveSelectionCount={getEffectiveSelectionCount}
              nativeDragOver={nativeDragOver}
            />
          ))}
      </DroppableFolder>
    );
  }

  // File node
  const file = node.file!;
  const fileItem: FileTreeSelectionItem = {
    type: "file",
    path: file.relativePath,
  };
  const isSelected = selectedItemKeys.has(fileTreeSelectionKey(fileItem));
  const effectiveSelectionCount = getEffectiveSelectionCount(fileItem);
  const batchOperation = effectiveSelectionCount > 1;

  return (
    <DraggableItem id={file.relativePath} type="file" name={node.name}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            aria-pressed={isSelected}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              (file.id === activeFileId || isSelected) &&
                "bg-sidebar-accent text-sidebar-accent-foreground",
              file.id !== activeFileId &&
                !isSelected &&
                "hover:bg-sidebar-accent/50",
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={(event) =>
              onItemClick(fileItem, event, () => {
                useHistoryStore.getState().stopReview();
                onSelectFile(file.id);
              })
            }
            onContextMenu={() => onItemContextMenu(fileItem)}
          >
            {getFileIcon(file)}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {file.isDirty && (
              <span
                className="ml-auto size-2 shrink-0 rounded-full bg-blue-500"
                title="Modified"
              />
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => onRename(file.id, file.name)}
            disabled={batchOperation}
          >
            <PencilIcon className="mr-2 size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => onDeleteSelection(fileItem)}
            disabled={!canDeleteSelection(fileItem)}
          >
            <Trash2Icon className="mr-2 size-4" />
            {batchOperation
              ? `Delete ${effectiveSelectionCount} selected`
              : "Delete"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </DraggableItem>
  );
}

// ─── Environment Section (Python + Skills) ───

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

function EnvironmentSection({
  projectPath: _projectPath,
}: {
  projectPath: string | null;
}) {
  // ── Python / uv ──
  const venvReady = useUvSetupStore((s) => s.venvReady);
  const uvStatus = useUvSetupStore((s) => s.status);
  const [showUvDialog, setShowUvDialog] = useState(false);

  // ── Scientific Skills ──
  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const checkSkillsStatus = useCallback(async () => {
    try {
      const globalStatus = await invoke<SkillsStatus>(
        "check_skills_installed",
        {
          projectPath: null,
        },
      );
      setSkillsStatus(globalStatus);
    } catch {
      // Ignore errors silently
    }
  }, []);

  useEffect(() => {
    checkSkillsStatus();
  }, [checkSkillsStatus]);

  // Lazy import onboarding
  const [OnboardingComponent, setOnboardingComponent] =
    useState<React.ComponentType<{
      onClose: () => void;
    }> | null>(null);

  useEffect(() => {
    if (showOnboarding && !OnboardingComponent) {
      import(
        "@/components/scientific-skills/scientific-skills-onboarding"
      ).then((mod) =>
        setOnboardingComponent(() => mod.ScientificSkillsOnboarding),
      );
    }
  }, [showOnboarding, OnboardingComponent]);

  const pythonLabel = venvReady
    ? "Active"
    : uvStatus === "not-installed"
      ? "Not installed"
      : uvStatus === "ready"
        ? "No venv"
        : "";
  const skillsLabel = skillsStatus?.installed
    ? `${skillsStatus.skill_count} skills`
    : "Not installed";

  return (
    <>
      <div className="border-sidebar-border border-t">
        <div className="flex h-8 shrink-0 items-center justify-center gap-2 px-3">
          <AppWindowIcon className="size-3.5 text-muted-foreground" />
          <span className="font-medium text-xs">Environment</span>
        </div>
        <div className="space-y-0.5 px-1 pb-1.5">
          {/* Python / uv row */}
          <button
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
            onClick={() => setShowUvDialog(true)}
          >
            <TerminalIcon
              className={cn(
                "size-3.5 shrink-0",
                venvReady ? "text-foreground" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs">Python</span>
            <span
              className={cn(
                "shrink-0 text-xs",
                venvReady ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {pythonLabel}
            </span>
          </button>
          {/* Scientific Skills row */}
          <button
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
            onClick={() => setShowOnboarding(true)}
          >
            <FlaskConicalIcon
              className={cn(
                "size-3.5 shrink-0",
                skillsStatus?.installed
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs">Skills</span>
            <span
              className={cn(
                "shrink-0 text-xs",
                skillsStatus?.installed
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {skillsLabel}
            </span>
          </button>
        </div>
      </div>

      <UvSetupDialog
        open={showUvDialog}
        onClose={() => setShowUvDialog(false)}
      />

      {showOnboarding && OnboardingComponent && (
        <OnboardingComponent
          onClose={() => {
            setShowOnboarding(false);
            checkSkillsStatus();
          }}
        />
      )}
    </>
  );
}

// ─── Draggable wrapper ───

function DraggableItem({
  id,
  type,
  name,
  children,
}: {
  id: string;
  type: "file" | "folder";
  name: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { type, name },
  });

  // Wrap listeners to log pointer events
  const wrappedListeners = listeners
    ? Object.fromEntries(
        Object.entries(listeners).map(([key, handler]) => [
          key,
          (e: React.PointerEvent) => {
            (handler as (e: React.PointerEvent) => void)(e);
          },
        ]),
      )
    : {};

  return (
    <div
      ref={setNodeRef}
      {...wrappedListeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      {children}
    </div>
  );
}
