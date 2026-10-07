import { ThemeProvider, useTheme } from "next-themes";
import { ErrorBoundary } from "react-error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { ProjectPicker } from "@/components/project-picker";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke, backend } from "@/lib/backend";
import { getCurrentWindow } from "@/lib/backend/desktop-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { ErrorFallback } from "@/components/error-fallback";
import { createLogger } from "@/lib/debug/logger";
import { EnvironmentOnboarding } from "@/components/environment-onboarding";

const log = createLogger("app");

const LazyDebugPage = lazy(() =>
  import("@/components/debug/debug-page").then((m) => ({
    default: m.DebugPage,
  })),
);

interface AgentSessionInfo {
  session_id: string;
  title: string;
  last_modified: number;
}

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
  const autoResumedProjectRef = useRef<string | null>(null);
  const chatProjectRef = useRef<string | null>(null);

  // Update window title
  useEffect(() => {
    if (projectRoot) {
      const name = projectRoot.split(/[/\\]/).pop() || "Codex-Prism";
      getCurrentWindow().setTitle(`${name} - Codex-Prism`);
    }
  }, [projectRoot]);

  useEffect(() => {
    if (chatProjectRef.current === projectRoot) return;
    chatProjectRef.current = projectRoot;
    useAgentChatStore.getState().resetForProject(projectRoot ?? null);
  }, [projectRoot]);

  // Auto-setup Python venv when project opens
  useEffect(() => {
    if (!initialized || !projectRoot) return;
    const uvStore = useUvSetupStore.getState();
    uvStore
      .checkStatus()
      .then(() => {
        const { status } = useUvSetupStore.getState();
        if (status === "ready") {
          return uvStore.setupVenv(projectRoot);
        }
      })
      .catch((err) => {
        log.error("Failed to setup Python venv", { error: String(err) });
      });
  }, [initialized, projectRoot]);

  // Open the most recent chat when entering a project.
  useEffect(() => {
    if (!projectRoot) {
      autoResumedProjectRef.current = null;
      return;
    }
    if (!initialized) return;
    if (autoResumedProjectRef.current === projectRoot) return;

    const chatState = useAgentChatStore.getState();
    if (chatState.pendingInitialPrompt) return;

    autoResumedProjectRef.current = projectRoot;
    let cancelled = false;

    backend.projects.register(projectRoot).then(p => backend.agent.sessions(p.id)).then(sessions => sessions.map(s => ({session_id:s.id,title:s.title,last_modified:0})))
      .then((sessions) => {
        if (cancelled) return;
        const latest = sessions
          .slice()
          .sort((a, b) => b.last_modified - a.last_modified)[0];

        const current = useAgentChatStore.getState();
        if (current.pendingInitialPrompt || current.isStreaming) {
          return;
        }

        if (!latest?.session_id) {
          current.newSession();
          return;
        }

        current.resumeSession(latest.session_id, latest.title).catch((err) => {
          log.warn("Failed to auto-resume latest chat session", {
            sessionId: latest.session_id,
            error: String(err),
          });
        });
      })
      .catch((err) => {
        log.warn("Failed to auto-resume latest chat session", {
          error: String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [initialized, projectRoot]);

  // Consume pending initial prompt from project wizard
  useEffect(() => {
    if (!initialized) return;
    // Delay to let AgentChatDrawer mount and register event listeners
    const timer = setTimeout(() => {
      const prompt = useAgentChatStore
        .getState()
        .consumePendingInitialPrompt();
      if (prompt) {
        useAgentChatStore.getState().sendPrompt(prompt);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [initialized]);

  return <WorkspaceLayout />;
}

export function App({ onReady }: { onReady?: () => void }) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const [showDebug, setShowDebug] = useState(false);

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
      getCurrentWindow().setTitle("Codex-Prism");
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
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
