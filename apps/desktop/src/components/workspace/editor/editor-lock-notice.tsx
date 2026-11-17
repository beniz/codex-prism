import { useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCollaborationLock } from "@/lib/collaboration";
import { EDIT_BLOCKED_EVENT } from "@/lib/editor-edit-lock";
import { Button } from "@/components/ui/button";

export function EditorLockNotice() {
  const chat = useAgentChatStore(
    useShallow((s) => ({
      locked: s.locked,
      tabs: s.tabs,
      proposals: s.proposals,
      review: s.review,
      restoring: s.restoringChats,
    })),
  );
  const projectId = useDocumentStore((s) => s.projectId);
  const syncing = useCollaborationLock(
    (s) => projectId !== null && s.projectId === projectId,
  );
  const locked = chat.locked || syncing;
  const [attention, setAttention] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setAttention(false);
    if (!locked) return;
    const highlight = () => {
      // One announcement per burst of typing; no timers or polling while idle.
      if (timer.current !== undefined) return;
      setAttention(true);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setAttention(false);
      }, 2000);
    };
    window.addEventListener(EDIT_BLOCKED_EVENT, highlight);
    return () => {
      window.removeEventListener(EDIT_BLOCKED_EVENT, highlight);
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [locked]);
  if (!locked) return null;

  const owners = new Map<
    string,
    { tabId?: string; threadId?: string; title: string; running: boolean }
  >();
  for (const p of chat.proposals.filter(
    (p) => p.blocksEditing !== false && p.projectId === projectId,
  )) {
    const tab = chat.tabs.find(
      (t) => t.id === p.chatId || (!!t.sessionId && t.sessionId === p.threadId),
    );
    const key = tab?.id ?? p.threadId ?? p.id;
    owners.set(key, {
      tabId: tab?.id,
      threadId: p.threadId ?? undefined,
      title: tab?.title || "Closed chat",
      running: !!tab?.isStreaming || ["running", "repairing"].includes(p.state),
    });
  }
  for (const tab of chat.tabs.filter((t) => t.isStreaming)) {
    owners.set(tab.id, { tabId: tab.id, title: tab.title, running: true });
  }
  const targets = [...owners.values()];
  const running = targets.some((t) => t.running) || chat.review.active;
  const legacy = chat.review.active || chat.review.changes.length > 0;
  const message = syncing
    ? "Editing is paused while collaborator changes are applied."
    : targets.length === 1 && running
      ? `${targets[0].title} is editing this document. Wait for the agent to finish, then resolve any pending changes to edit LaTeX.`
      : targets.length > 1
        ? `${targets.length} chats have running work or pending changes. Finish running work and keep or discard pending changes to edit LaTeX.`
        : targets.length === 1
          ? `Resolve pending changes in ${targets[0].title} to edit LaTeX. Keep or discard them first.`
          : legacy
            ? "Resolve the legacy review to edit LaTeX. Wait for any running work, then keep or discard pending changes."
            : chat.restoring
              ? "Checking running work and pending changes before enabling editing…"
              : "Editing is paused until the project's review status is available.";

  async function goTo(target?: (typeof targets)[number]) {
    useDocumentStore.getState().setThreadOpen(true);
    if (target?.tabId) useAgentChatStore.getState().setActiveTab(target.tabId);
    else if (target?.threadId)
      await useAgentChatStore
        .getState()
        .resumeSession(target.threadId, target.title);
  }
  return (
    <div
      className={`shrink-0 border-b px-3 py-2 text-xs ${attention ? "bg-amber-500/20 ring-2 ring-amber-500 ring-inset" : "bg-amber-500/10"}`}
      data-edit-lock=""
      data-highlighted={attention}
    >
      <div className="flex items-start gap-2">
        <LockKeyhole
          className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <p>
          {message}{" "}
          <span className="text-muted-foreground">
            You can still select and copy text.
          </span>
        </p>
      </div>
      {!syncing && (
        <div className="flex flex-wrap gap-1">
          {targets
            .filter((t) => t.tabId || t.threadId)
            .map((target, i) => (
              <Button
                key={target.tabId ?? target.threadId ?? i}
                variant="link"
                size="sm"
                className="mr-3 h-auto px-0 py-1 text-xs"
                onClick={() => void goTo(target)}
              >
                {target.running ? "Go to chat" : "Go to changes"}
                {targets.length > 1 ? ` · ${target.title}` : ""}
              </Button>
            ))}
          {legacy && (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 py-1 text-xs"
              onClick={() => void goTo()}
            >
              Go to legacy review
            </Button>
          )}
        </div>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {attention ? `Edit blocked. ${message}` : ""}
      </span>
    </div>
  );
}
