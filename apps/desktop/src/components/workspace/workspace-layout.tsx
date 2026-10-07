import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { Sidebar } from "./sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { AgentChatDrawer } from "@/components/agent-chat/agent-chat-drawer";
import { ProposedChangesPanel } from "@/components/agent-chat/proposed-changes-panel";
import { useDocumentStore } from "@/stores/document-store";
import { usePreviewStore } from "@/stores/preview-store";

const SIDEBAR_DEFAULT_SIZE = 15;
const SIDEBAR_MIN_SIZE = 10;
const SIDEBAR_COLLAPSED_WIDTH_PX = 48;
const SIDEBAR_COLLAPSED_SIZE_FALLBACK = 8;
const SIDEBAR_ANIMATION_MS = 280;

function easeInOutSmooth(progress: number) {
  return progress * progress * (3 - 2 * progress);
}

export function WorkspaceLayout() {
  const initialized = useDocumentStore((s) => s.initialized);
  const previewVisible = usePreviewStore((s) => s.visible);
  const setPreviewVisible = usePreviewStore((s) => s.setVisible);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarAnimationFrameRef = useRef<number | null>(null);
  const sidebarAnimatingRef = useRef(false);
  const expandedSidebarSizeRef = useRef(SIDEBAR_DEFAULT_SIZE);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarCollapsedSize, setSidebarCollapsedSize] = useState(
    SIDEBAR_COLLAPSED_SIZE_FALLBACK,
  );
  const [codeVisible, setCodeVisible] = useState(false);

  const getCollapsedSidebarSize = useCallback(() => {
    const workspaceWidth =
      workspaceRef.current?.clientWidth ?? window.innerWidth;
    if (!workspaceWidth) return SIDEBAR_COLLAPSED_SIZE_FALLBACK;
    return Math.min(
      18,
      Math.max(2.5, (SIDEBAR_COLLAPSED_WIDTH_PX / workspaceWidth) * 100),
    );
  }, []);

  const animateSidebarToSize = useCallback((targetSize: number) => {
    const sidebarPanel = sidebarPanelRef.current;
    if (!sidebarPanel) return;

    if (sidebarAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarAnimationFrameRef.current);
    }

    const startSize = sidebarPanel.getSize();
    const sizeDelta = targetSize - startSize;
    const startedAt = performance.now();
    sidebarAnimatingRef.current = true;

    const step = (now: number) => {
      const progress = Math.min((now - startedAt) / SIDEBAR_ANIMATION_MS, 1);
      const nextSize = startSize + sizeDelta * easeInOutSmooth(progress);

      sidebarPanel.resize(nextSize);

      if (progress < 1) {
        sidebarAnimationFrameRef.current = window.requestAnimationFrame(step);
        return;
      }

      sidebarPanel.resize(targetSize);
      sidebarAnimationFrameRef.current = null;
      sidebarAnimatingRef.current = false;
    };

    sidebarAnimationFrameRef.current = window.requestAnimationFrame(step);
  }, []);

  const setSidebarPaneCollapsed = useCallback(
    (nextCollapsed: boolean) => {
      const sidebarPanel = sidebarPanelRef.current;
      if (!sidebarPanel) return;

      if (!nextCollapsed) {
        setSidebarCollapsed(false);
        animateSidebarToSize(expandedSidebarSizeRef.current);
      } else {
        const collapsedSize = getCollapsedSidebarSize();
        const currentSize = sidebarPanel.getSize();
        if (currentSize >= SIDEBAR_MIN_SIZE) {
          expandedSidebarSizeRef.current = currentSize;
        }
        setSidebarCollapsedSize(collapsedSize);
        setSidebarCollapsed(true);
        animateSidebarToSize(collapsedSize);
      }
    },
    [animateSidebarToSize, getCollapsedSidebarSize],
  );

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarPaneCollapsed(!sidebarCollapsed);
  }, [setSidebarPaneCollapsed, sidebarCollapsed]);

  const setCodePaneVisible = useCallback(
    (visible: boolean) => {
      if (!visible && !previewVisible) {
        setPreviewVisible(true);
      }
      setCodeVisible(visible);
    },
    [previewVisible, setPreviewVisible],
  );

  const setPdfPaneVisible = useCallback(
    (visible: boolean) => {
      if (!visible && !codeVisible) {
        setCodeVisible(true);
      }
      setPreviewVisible(visible);
    },
    [codeVisible, setPreviewVisible],
  );

  // Cmd+\ / Ctrl+\ toggles the PDF preview pane.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setPdfPaneVisible(!previewVisible);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [previewVisible, setPdfPaneVisible]);

  useEffect(() => {
    return () => {
      if (sidebarAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarAnimationFrameRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const updateCollapsedSize = () => {
      const nextSize = getCollapsedSidebarSize();
      setSidebarCollapsedSize(nextSize);

      if (sidebarCollapsed && !sidebarAnimatingRef.current) {
        sidebarPanelRef.current?.resize(nextSize);
      }
    };

    updateCollapsedSize();

    const workspaceElement = workspaceRef.current;
    if (!workspaceElement) return;

    const resizeObserver = new ResizeObserver(updateCollapsedSize);
    resizeObserver.observe(workspaceElement);

    return () => resizeObserver.disconnect();
  }, [getCollapsedSidebarSize, sidebarCollapsed]);

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading project...</div>
      </div>
    );
  }

  return (
    <div ref={workspaceRef} className="h-full">
      <PanelGroup direction="horizontal" className="h-full">
        <Panel
          id="sidebar"
          order={0}
          ref={sidebarPanelRef}
          defaultSize={SIDEBAR_DEFAULT_SIZE}
          minSize={SIDEBAR_MIN_SIZE}
          maxSize={25}
          collapsible
          collapsedSize={sidebarCollapsedSize}
          onCollapse={() => setSidebarCollapsed(true)}
          onExpand={() => setSidebarCollapsed(false)}
          onResize={(size) => {
            if (!sidebarAnimatingRef.current && size >= SIDEBAR_MIN_SIZE) {
              expandedSidebarSizeRef.current = size;
            }
          }}
          className="min-w-0 overflow-hidden"
        >
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebarCollapsed}
            layoutControls={{
              codeVisible,
              pdfVisible: previewVisible,
              sidebarVisible: !sidebarCollapsed,
              setCodeVisible: setCodePaneVisible,
              setPdfVisible: setPdfPaneVisible,
              setSidebarVisible: (visible) => setSidebarPaneCollapsed(!visible),
            }}
          />
        </Panel>

        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

        <Panel
          id="editor-chat"
          order={1}
          defaultSize={previewVisible ? 42.5 : 85}
          minSize={25}
          className="min-w-0"
        >
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {codeVisible && (
              <div className="min-h-0 flex-1 overflow-hidden">
                <LatexEditor />
              </div>
            )}
            <ProposedChangesPanel />
            <AgentChatDrawer fillHeight={!codeVisible} />
          </div>
        </Panel>

        {previewVisible && (
          <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />
        )}

        {previewVisible && (
          <Panel
            id="pdf-preview"
            order={2}
            defaultSize={42.5}
            minSize={25}
            className="min-w-0"
          >
            <PdfPreview />
          </Panel>
        )}
      </PanelGroup>
    </div>
  );
}
