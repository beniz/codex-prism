import { ThemeProvider, useTheme } from "next-themes";
import { ErrorBoundary } from "react-error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { ProjectPicker } from "@/components/project-picker";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/backend";
import { getCurrentWindow } from "@/lib/backend/desktop-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorFallback } from "@/components/error-fallback";
import { createLogger } from "@/lib/debug/logger";
import { EnvironmentOnboarding } from "@/components/environment-onboarding";

import {
  restoreUpdateSession,
  startUpdateChecks,
  useUpdateStore,
} from "@/stores/update-store";
import { UpdateDialog } from "@/components/app-updates";

const log = createLogger("app");

const LazyDebugPage = lazy(() =>
  import("@/components/debug/debug-page").then((m) => ({
    default: m.DebugPage,
  })),
);

function NativeWindowThemeBridge() {
  const { resolvedTheme, theme } = useTheme();

  useEffect(() => {
    const syncNativeTheme = () => {
      const isDark =
        document.documentElement.classList.contains("dark") ||
        resolvedTheme === "dark";
      const nativeTheme = isDark ? "dark" : "light";

      document.documentElement.style.colorScheme = nativeTheme;
      invoke("set_native_window_theme", { theme: nativeTheme })
        .catch((err) => {
          log.warn("Failed to sync native window theme via Rust command", {
            error: String(err),
          });
          return getCurrentWindow().setTheme(nativeTheme);
        })
        .catch((err) => {
          log.warn("Failed to sync native window theme via JS API", {
            error: String(err),
          });
        });
    };

    syncNativeTheme();

    const observer = new MutationObserver(syncNativeTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    systemThemeQuery.addEventListener("change", syncNativeTheme);

    return () => {
      observer.disconnect();
      systemThemeQuery.removeEventListener("change", syncNativeTheme);
    };
  }, [resolvedTheme, theme]);

  return null;
}

function WorkspaceWithAgent() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const initialized = useDocumentStore((s) => s.initialized);
  const restoringChats = useAgentChatStore((s) => s.restoringChats);
  const chatProjectRef = useRef<string | null>(null);

  // Update window title
  useEffect(() => {
    if (projectRoot) {
      const name = projectRoot.split(/[/\\]/).pop() || "codex-prism";
      getCurrentWindow().setTitle(`${name} - codex-prism`);
    }
  }, [projectRoot]);

  useEffect(() => {
    if (chatProjectRef.current === projectRoot) return;
    chatProjectRef.current = projectRoot;
    useAgentChatStore.getState().resetForProject(projectRoot ?? null);
  }, [projectRoot]);

  // Consume pending initial prompt from project wizard
  useEffect(() => {
    if (!initialized || restoringChats) return;
    // Delay to let AgentChatDrawer mount and register event listeners
    const timer = setTimeout(() => {
      const prompt = useAgentChatStore.getState().consumePendingInitialPrompt();
      if (prompt) {
        useAgentChatStore.getState().sendPrompt(prompt);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [initialized, restoringChats]);

  return <WorkspaceLayout />;
}

export function App({ onReady }: { onReady?: () => void }) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const [showDebug, setShowDebug] = useState(false);

  const updating = useUpdateStore((s) => s.phase === "installing");
  useEffect(() => {
    void restoreUpdateSession();
    return startUpdateChecks();
  }, []);
  useEffect(() => {
    if (!updating) return;
    const block = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [updating]);

  // Register global keyboard shortcuts (Cmd+S, Cmd+N) at the app level
  useKeyboardShortcuts();

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
    };

    document.addEventListener("contextmenu", preventNativeContextMenu);
    return () => {
      document.removeEventListener("contextmenu", preventNativeContextMenu);
    };
  }, []);

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  useEffect(() => {
    if (!projectRoot) {
      getCurrentWindow().setTitle("codex-prism");
    }
  }, [projectRoot]);

  // Listen for debug panel toggle (Ctrl+Shift+D)
  useEffect(() => {
    const handler = () => setShowDebug((prev) => !prev);
    window.addEventListener("toggle-debug-panel", handler);
    return () => window.removeEventListener("toggle-debug-panel", handler);
  }, []);

  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <TooltipProvider>
          <NativeWindowThemeBridge />
          <UpdateDialog />
          {updating && (
            <div
              className="fixed inset-0 z-[100] cursor-wait bg-background/60"
              role="status"
              aria-live="polite"
            >
              <p className="m-8 rounded bg-background p-4">
                Saving and updating codex-prism…
              </p>
            </div>
          )}
          <div className="contents" inert={updating}>
            {/* Global macOS titlebar drag region — sits above all content */}
            <div
              data-tauri-drag-region
              className="fixed inset-x-0 top-0 z-[9999] h-[var(--titlebar-height)]"
            />
            {projectRoot ? <WorkspaceWithAgent /> : <ProjectPicker />}
            <EnvironmentOnboarding />
            {showDebug && (
              <div className="fixed inset-0 z-[9998] flex items-end justify-center">
                <div
                  className="absolute inset-0 bg-black/20"
                  onClick={() => setShowDebug(false)}
                />
                <div className="relative h-[60vh] w-full border-border border-t bg-background shadow-lg">
                  <div className="flex h-8 items-center justify-between border-border border-b bg-muted/50 px-3">
                    <span className="font-medium text-xs">Debug Panel</span>
                    <button
                      className="text-muted-foreground text-xs hover:text-foreground"
                      onClick={() => setShowDebug(false)}
                    >
                      Close (Ctrl+Shift+D)
                    </button>
                  </div>
                  <div className="h-[calc(60vh-2rem)] overflow-auto">
                    <Suspense
                      fallback={
                        <div className="p-4 text-muted-foreground text-sm">
                          Loading...
                        </div>
                      }
                    >
                      <LazyDebugPage />
                    </Suspense>
                  </div>
                </div>
              </div>
            )}
            <Toaster />
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
