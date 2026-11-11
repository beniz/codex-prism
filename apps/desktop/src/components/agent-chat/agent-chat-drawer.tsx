import { SourceCompletion } from "./source-completion";
import { listContinuation } from "@/lib/composer-lists";
import { ChatHistory } from "./chat-history";
import { ActivityLabel } from "./activity-label";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  SquareIcon,
  PaperclipIcon,
  FileTextIcon,
  UploadIcon,
  XIcon,
  PlusIcon,
  HistoryIcon,
  Settings2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PencilIcon,
  ArchiveIcon,
  SparklesIcon,
  Loader2Icon,
  CheckIcon,
  SearchIcon,
} from "lucide-react";
import { useDocumentStore } from "@/stores/document-store";
import { backend, type AgentEvent, type Session } from "@/lib/backend";
import { open as openFiles } from "@/lib/backend/desktop-host";
import {
  useAgentChatStore,
  ensureAgentEvents,
} from "@/stores/agent-chat-store";
import { useAgentSetupStore } from "@/stores/agent-setup-store";
import { AgentSetup } from "@/components/agent-setup";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { isImageUpload } from "@/lib/project-images";

export function AgentChatDrawer({
  fillHeight = false,
}: {
  fillHeight?: boolean;
}) {
  const s = {
    activeTabId: useAgentChatStore((state) => state.activeTabId),
    addPendingAttachment: useAgentChatStore(
      (state) => state.addPendingAttachment,
    ),
    cancelExecution: useAgentChatStore((state) => state.cancelExecution),
    closeTab: useAgentChatStore((state) => state.closeTab),
    createTab: useAgentChatStore((state) => state.createTab),
    effortLevel: useAgentChatStore((state) => state.effortLevel),
    error: useAgentChatStore((state) => state.error),
    restoringChats: useAgentChatStore((state) => state.restoringChats),
    isStreaming: useAgentChatStore((state) => state.isStreaming),
    locked: useAgentChatStore((state) => state.locked),
    pendingAttachments: useAgentChatStore(
      (state) => state.pendingAttachments,
    ).filter(
      (a) => !a.chatId || a.chatId === useAgentChatStore.getState().activeTabId,
    ),
    projectId: useAgentChatStore((state) => state.projectId),
    requestPinnedContextRemoval: useAgentChatStore(
      (state) => state.requestPinnedContextRemoval,
    ),
    requests: useAgentChatStore((state) => state.requests),
    respond: useAgentChatStore((state) => state.respond),
    resumeSession: useAgentChatStore((state) => state.resumeSession),
    selectedModel: useAgentChatStore((state) => state.selectedModel),
    sendPrompt: useAgentChatStore((state) => state.sendPrompt),
    setActiveTab: useAgentChatStore((state) => state.setActiveTab),
    tabs: useAgentChatStore((state) => state.tabs),
    pendingReview: useAgentChatStore(
      (state) => !state.review.active && state.review.changes.length > 0,
    ),
  };
  const setup = {
    status: useAgentSetupStore((state) => state.status),
    models: useAgentSetupStore((state) => state.models),
    checkStatus: useAgentSetupStore((state) => state.checkStatus),
  };
  const [open, setOpen] = useState(true);
  const [settings, setSettings] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [filePicker, setFilePicker] = useState(false);
  const [query, setQuery] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const promptHistory = useRef<{ chatId: string; prompts: string[]; index: number; value: string } | null>(null);
  const composer = useRef<HTMLDivElement>(null);
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const resizeInput = (height: number) => {
    const el = composer.current;
    const field = input.current;
    if (!el || !field) return;
    const available =
      (el.parentElement?.clientHeight ?? 0) * 0.7 -
      (el.offsetHeight - field.offsetHeight);
    setInputHeight(Math.max(56, Math.min(height, Math.max(56, available))));
  };
  const files = useDocumentStore((d) => d.files);
  const proposals = useAgentChatStore((state) => state.proposals);
  const t = s.tabs.find((t) => t.id === s.activeTabId)!;
  const reportError = (e: unknown) =>
    useAgentChatStore.setState({ error: String(e) });
  useEffect(() => {
    const el = viewport.current;
    if (el && followMessages.current) el.scrollTop = el.scrollHeight;
  }, [t.messages, s.requests, open]);
  useEffect(() => {
    promptHistory.current = null;
    followMessages.current = true;
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [t.id]);
  useEffect(() => {
    void ensureAgentEvents().catch(reportError);
    void setup.checkStatus();
  }, []);
  useEffect(() => {
    let current = true;
    if (s.projectId)
      void backend.agent
        .sessions(s.projectId)
        .then((value) => {
          if (current) setSessions(value);
        })
        .catch(reportError);
    else setSessions([]);
    return () => {
      current = false;
    };
  }, [s.projectId, s.isStreaming]);
  useEffect(() => {
    if (input.current) {
      if (inputHeight !== null) {
        input.current.style.height = `${inputHeight}px`;
      } else {
        input.current.style.height = "auto";
        input.current.style.height = `${Math.min(input.current.scrollHeight, 128)}px`;
      }
    }
  }, [t.draft, open, inputHeight]);
  const model =
    setup.models.find((m) => m.model === s.selectedModel) ||
    setup.models.find((m) => m.isDefault);

  const canSend =
    !s.restoringChats &&
    !!t.draft.trim() &&
    !s.pendingReview &&
    setup.status === "ready" &&
    !attaching;
  const setDraft = (draft: string) =>
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((x) => (x.id === t.id ? { ...x, draft } : x)),
    }));
  const send = () => {
    if (!canSend) return;
    const prompt = t.draft;
    promptHistory.current = null;
    followMessages.current = true;
    void s.sendPrompt(prompt);
  };
  const attach = (path: string) => {
    if (
      !useAgentChatStore
        .getState()
        .pendingAttachments.some((a) => a.filePath === path)
    )
      s.addPendingAttachment({ label: path, filePath: path, selectedText: "" });
    input.current?.focus();
  };
  const upload = async () => {
    const root = useDocumentStore.getState().projectRoot;
    setFilePicker(false);
    setAttaching(true);
    try {
      const selected = await openFiles({
        multiple: true,
        directory: false,
        title: "Attach files to your prompt",
      });
      if (!selected) return;
      if (useDocumentStore.getState().projectRoot !== root)
        throw new Error("The project changed. Please choose the files again.");
      const sources = Array.isArray(selected) ? selected : [selected];
      const doc = useDocumentStore.getState();
      const paths = await doc.importFiles(sources.filter(isImageUpload));
      if (useDocumentStore.getState().projectRoot !== root)
        throw new Error("The project changed. Please choose the files again.");
      paths.push(
        ...(await doc.importFiles(
          sources.filter((path) => !isImageUpload(path)),
          "attachments",
        )),
      );
      if (useDocumentStore.getState().projectRoot === root)
        paths.forEach(attach);
    } catch (e) {
      reportError(e);
    } finally {
      setAttaching(false);
    }
  };
  const rename = async () => {
    const title = window.prompt("Chat title", t.title);
    if (!title || !s.projectId || !t.sessionId) return;
    try {
      await backend.agent.thread(s.projectId, t.sessionId, "rename", title);
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((x) => (x.id === t.id ? { ...x, title } : x)),
      }));
      setSessions((list) =>
        list.map((x) => (x.id === t.sessionId ? { ...x, title } : x)),
      );
    } catch (e) {
      reportError(e);
    }
  };
  const archive = async () => {
    if (!s.projectId || !t.sessionId) return;
    try {
      await backend.agent.thread(s.projectId, t.sessionId, "archive");
      s.closeTab(t.id);
      setSessions((list) => list.filter((x) => x.id !== t.sessionId));
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <section
      aria-label="Codex chat"
      className={cn(
        "flex min-h-0 shrink-0 flex-col overflow-hidden border-t bg-background",
        open && (fillHeight ? "flex-1" : "h-[min(28rem,55%)]"),
      )}
    >
      <header className="flex shrink-0 items-center gap-1 px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="mr-auto gap-2 px-1.5"
          aria-expanded={open}
          aria-controls="codex-chat-content"
          onClick={() => setOpen(!open)}
        >
          <SparklesIcon className="size-4 text-muted-foreground" />{" "}
          <span>Codex</span>
          <span
            className={cn(
              "size-1.5 rounded-full",
              setup.status === "ready"
                ? "bg-emerald-500"
                : "bg-muted-foreground/40",
            )}
            title={setup.status === "ready" ? "Connected" : "Connection needed"}
          />
          {open ? (
            <ChevronDownIcon className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3 text-muted-foreground" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="New chat"
          aria-label="New chat"
          onClick={() => {
            s.createTab();
            setOpen(true);
          }}
        >
          <PlusIcon />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Previous chats"
              aria-label="Previous chats"
            >
              <HistoryIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-64 max-w-72">
            {sessions.length ? (
              sessions.map((x) => (
                <DropdownMenuItem
                  key={x.id}
                  onSelect={() => {
                    setOpen(true);
                    void s.resumeSession(x.id, x.title).catch(reportError);
                  }}
                >
                  <span className="truncate">
                    {x.title}{" "}
                    {proposals.find(
                      (p) => p.threadId === x.id && p.state !== "original",
                    )?.state === "conflicts"
                      ? " · Conflicts"
                      : proposals.some((p) => p.threadId === x.id)
                        ? " · Changes ready"
                        : ""}
                  </span>
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>No previous chats</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Codex connection"
          aria-label="Codex connection"
          onClick={() => setSettings(true)}
        >
          <Settings2Icon />
        </Button>
        {t.sessionId && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Chat options">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void rename()}>
                <PencilIcon />
                Rename chat
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={s.locked}
                onSelect={() => void archive()}
              >
                <ArchiveIcon />
                Archive chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Codex connection</DialogTitle>
          </DialogHeader>
          <AgentSetup onSaved={() => setSettings(false)} />
        </DialogContent>
      </Dialog>
      {open && (
        <div id="codex-chat-content" className="flex min-h-0 flex-1 flex-col">
          {s.tabs.length > 1 && (
            <nav
              aria-label="Open chats"
              className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-1"
            >
              {s.tabs.map((x) => {
                const proposal = proposals.find((p) =>
                  p.projectId === s.projectId && p.state !== "original" &&
                  ((x.sessionId && p.threadId === x.sessionId) || p.chatId === x.id));
                const awaitingReview = !!proposal?.changes.length &&
                  !x.isStreaming &&
                  !["running", "repairing", "applying"].includes(proposal.state);
                return (
                <div
                  key={x.id}
                  className={cn(
                    "flex max-w-48 items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground",
                    x.id === t.id && "bg-muted text-foreground",
                  )}
                >
                  <button
                    className="truncate"
                    onClick={() => s.setActiveTab(x.id)}
                  >
                    {x.title}{" "}
                    {proposal?.state === "conflicts"
                      ? " · Conflicts"
                      : proposal?.state === "repairing"
                        ? " · Repairing"
                        : x.isStreaming
                          ? " · Running"
                          : awaitingReview
                            ? " · Changes ready"
                            : ""}
                  </button>
                  {awaitingReview && (
                    <span
                      role="img"
                      aria-label={`${x.title}: changes awaiting review`}
                      title="Changes awaiting review"
                      className="size-2 shrink-0 rounded-full bg-amber-500"
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={x.isStreaming}
                    aria-label={`Close ${x.title}`}
                    onClick={() => s.closeTab(x.id)}
                  >
                    <XIcon />
                  </Button>
                </div>
              );
              })}
            </nav>
          )}
          <div
            ref={viewport}
            onScroll={(e) => {
              const el = e.currentTarget;
              followMessages.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3"
          >
            {!s.restoringChats && !t.messages.length && (
              <div className="flex h-full min-h-16 flex-col items-center justify-center gap-2 text-center">
                <SparklesIcon className="size-5 text-muted-foreground/60" />
                <p className="text-sm font-medium">
                  What would you like to work on?
                </p>
                <p className="max-w-72 text-xs text-muted-foreground">
                  Edit your paper, explore an idea, or attach a file for
                  context.
                </p>
              </div>
            )}
            {s.restoringChats && (
              <p role="status" className="text-xs text-muted-foreground">
                Restoring conversations…
              </p>
            )}
            <ChatHistory key={t.id} messages={t.messages} viewport={viewport} />
            {!t.isStreaming && !t.error && t.mode === "plan" && t.messages.some((m) => m.type === "proposedPlan" && m.status === "completed") && [...t.messages].reverse().find((m) => m.type === "userMessage" || m.type === "proposedPlan")?.status === "completed" && (
              <div className="flex gap-2" role="group" aria-label="Plan actions">
                <Button onClick={() => {
                  useAgentChatStore.setState((state) => ({ tabs: state.tabs.map((tab) => tab.id === t.id ? { ...tab, mode: "default" } : tab) }));
                  void s.sendPrompt("Implement the plan.");
                }}>Implement plan</Button>
                <Button variant="outline" onClick={() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()}>Refine plan</Button>
              </div>
            )}
            {t.isStreaming && (
              <div
                role="status"
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <Loader2Icon className="size-3 animate-spin" />
                Codex is working…
              </div>
            )}
            {s.requests
              .filter((r) => r.params.threadId === t.sessionId)
              .map((r) => (
                <Request key={String(r.id)} event={r} />
              ))}
          </div>
          {(s.error || t.error) && (
            <div
              role="alert"
              className="mx-3 mb-2 max-h-20 overflow-auto rounded-lg bg-destructive/10 px-3 py-2 text-xs text-foreground"
            >
              <ActivityLabel kind="error" label="Error" />
              <p>{s.error || t.error}</p>
            </div>
          )}
          <div
            ref={composer}
            className="max-h-[70%] shrink-0 overflow-auto px-3 pb-3 pt-1"
          >
            <button
              type="button"
              aria-label="Resize message input"
              title="Drag up to enlarge; use arrow keys to resize. Double-click to reset."
              className="group flex h-3 w-full touch-none cursor-ns-resize items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-ring"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.focus();
                e.currentTarget.setPointerCapture(e.pointerId);
                resizeStart.current = {
                  y: e.clientY,
                  height: input.current?.offsetHeight ?? 56,
                };
              }}
              onPointerMove={(e) => {
                const start = resizeStart.current;
                if (start) resizeInput(start.height + start.y - e.clientY);
              }}
              onPointerUp={(e) => {
                resizeStart.current = null;
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onLostPointerCapture={() => {
                resizeStart.current = null;
              }}
              onPointerCancel={() => {
                resizeStart.current = null;
              }}
              onDoubleClick={() => setInputHeight(null)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  resizeInput(
                    (input.current?.offsetHeight ?? 56) +
                      (e.key === "ArrowUp" ? 24 : -24),
                  );
                }
              }}
            >
              <span className="h-1 w-8 rounded-full bg-border group-hover:bg-muted-foreground/60" />
            </button>
            <div className="rounded-2xl border border-input bg-muted/20 p-2 shadow-xs transition-shadow focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/10">
              {s.pendingAttachments.length > 0 && (
                <div className="flex max-h-24 flex-wrap gap-1.5 overflow-auto px-1 pb-2">
                  {s.pendingAttachments.map((a) => (
                    <div
                      key={a.label}
                      title={a.filePath || a.label}
                      className="flex max-w-full items-center gap-1.5 rounded-lg border bg-background py-1 pl-2 pr-1 text-xs"
                    >
                      {a.imageDataUrl ? (
                        <img
                          src={a.imageDataUrl}
                          alt="Attached capture"
                          className="size-6 rounded object-cover"
                        />
                      ) : (
                        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="max-w-40 truncate">
                        {a.label.split("/").pop()}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${a.label}`}
                        onClick={() => s.requestPinnedContextRemoval([a.label])}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <SourceCompletion projectId={s.projectId} chatId={t.id} draft={t.draft} input={input} change={setDraft} />
              <textarea
                ref={input}
                rows={2}
                disabled={s.restoringChats}
                aria-label="Message Codex"
                className="block min-h-14 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70"
                placeholder={
                  t.isStreaming
                    ? "Guide the current turn…"
                    : s.pendingReview
                      ? "Resolve the legacy review…"
                      : "Ask Codex anything about your project…"
                }
                value={t.draft}
                onChange={(e) => { promptHistory.current = null; setDraft(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    let history = promptHistory.current;
                    if (history && (history.chatId !== t.id || history.value !== t.draft)) {
                      promptHistory.current = null;
                      history = null;
                    }
                    if (!history && e.key === "ArrowUp" && t.draft === "") {
                      const prompts = t.messages.filter(m => m.type === "userMessage" && m.text?.trim()).map(m => m.text!);
                      if (prompts.length) history = { chatId: t.id, prompts, index: prompts.length, value: "" };
                    }
                    if (history) {
                      e.preventDefault();
                      history.index = Math.max(0, Math.min(history.prompts.length, history.index + (e.key === "ArrowUp" ? -1 : 1)));
                      history.value = history.prompts[history.index] ?? "";
                      promptHistory.current = history.index === history.prompts.length ? null : history;
                      setDraft(history.value);
                      return;
                    }
                  }

                  if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !t.isStreaming && !s.restoringChats) {
                    e.preventDefault();
                    useAgentChatStore.setState((state) => ({ tabs: state.tabs.map((tab) => tab.id === t.id ? { ...tab, mode: tab.mode === "plan" ? "default" : "plan" } : tab) }));
                    return;
                  }
                  if (
                    e.key === "Enter" &&
                    e.shiftKey &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.altKey
                  ) {
                    const field = e.currentTarget;
                    const edit = listContinuation(
                      field.value,
                      field.selectionStart,
                      field.selectionEnd,
                    );
                    if (edit) {
                      e.preventDefault();
                      field.setRangeText(edit.text, edit.from, edit.to, "end");
                      setDraft(field.value);
                    }
                    return;
                  }
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="flex flex-wrap items-center gap-1 pt-1">
                <Popover open={filePicker} onOpenChange={setFilePicker}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={s.locked || attaching}
                      title="Attach files"
                      aria-label="Attach files"
                    >
                      {attaching ? (
                        <Loader2Icon className="animate-spin" />
                      ) : (
                        <PaperclipIcon />
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" className="w-72 p-2">
                    <Button
                      variant="ghost"
                      className="w-full justify-start"
                      onClick={() => void upload()}
                    >
                      <UploadIcon />
                      Upload from computer
                    </Button>
                    <p className="px-3 pb-2 text-[11px] text-muted-foreground">
                      Files are copied into the project; images use its image
                      folder.
                    </p>
                    <div className="border-t pt-2">
                      <div className="mb-2 flex items-center gap-2 rounded-md border px-2">
                        <SearchIcon className="size-3.5 text-muted-foreground" />
                        <input
                          aria-label="Search project files"
                          placeholder="Search project files…"
                          className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </div>
                      <div className="max-h-44 overflow-auto">
                        {files
                          .filter((f) =>
                            f.relativePath
                              .toLowerCase()
                              .includes(query.toLowerCase()),
                          )
                          .map((f) => {
                            const selected = s.pendingAttachments.some(
                              (a) => a.filePath === f.relativePath,
                            );
                            return (
                              <Button
                                key={f.id}
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start font-normal"
                                disabled={selected}
                                onClick={() => attach(f.relativePath)}
                              >
                                <FileTextIcon className="size-3.5 shrink-0" />
                                <span className="truncate text-xs">
                                  {f.relativePath}
                                </span>
                                {selected && (
                                  <CheckIcon className="ml-auto size-3 shrink-0" />
                                )}
                              </Button>
                            );
                          })}
                        {!files.some((f) =>
                          f.relativePath
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                        ) && (
                          <p className="p-2 text-xs text-muted-foreground">
                            No matching project files
                          </p>
                        )}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
                <select
                  aria-label="Model"
                  title="Model"
                  className="h-8 min-w-0 max-w-[45%] cursor-pointer rounded-lg bg-transparent px-1 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  value={s.selectedModel}
                  onChange={(e) =>
                    useAgentChatStore.setState({
                      selectedModel: e.target.value,
                      effortLevel: "",
                    })
                  }
                >
                  <option value="">
                    {model?.displayName || "Codex default"}
                  </option>
                  {setup.models.map((m) => (
                    <option key={m.id} value={m.model}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Reasoning effort"
                  title="Reasoning effort"
                  className="h-8 min-w-0 max-w-[25%] cursor-pointer rounded-lg bg-transparent px-1 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  value={s.effortLevel}
                  onChange={(e) =>
                    useAgentChatStore.setState({ effortLevel: e.target.value })
                  }
                >
                  <option value="">Effort</option>
                  {model?.supportedReasoningEfforts.map((e) => (
                    <option key={e.reasoningEffort} value={e.reasoningEffort}>
                      {e.reasoningEffort}
                    </option>
                  ))}
                </select>
                <div className="ml-auto flex gap-1">
                  {t.isStreaming && (
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="rounded-full"
                      title="Stop Codex"
                      aria-label="Stop Codex"
                      onClick={() => void s.cancelExecution()}
                    >
                      <SquareIcon className="size-3 fill-current" />
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    className="rounded-full"
                    disabled={!canSend}
                    title={
                      t.isStreaming ? "Guide current turn" : "Send message"
                    }
                    aria-label={
                      t.isStreaming ? "Guide current turn" : "Send message"
                    }
                    onClick={send}
                  >
                    <ArrowUpIcon />
                  </Button>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 px-1 pt-1.5 text-[10px] text-muted-foreground">
              <span>
                {attaching ? (
                  "Adding files…"
                ) : s.pendingReview ? (
                  "Resolve the legacy review before sending"
                ) : s.locked ? (
                  "Project editing paused during execution"
                ) : setup.status !== "ready" ? (
                  <button
                    className="underline underline-offset-2"
                    onClick={() => setSettings(true)}
                  >
                    Connect Codex to start chatting
                  </button>
                ) : (
                  "Project context included"
                )}
              </span>
              <span className="shrink-0">
                {t.mode === "plan" ? "Plan" : "Agent"} · Shift+Tab to switch · Enter to send
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Request({ event: e }: { event: AgentEvent }) {
  const respond = useAgentChatStore((s) => s.respond);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const p = e.params;
  if (e.method === "item/tool/requestUserInput")
    return (
      <div className="space-y-2 rounded border p-3">
        <ActivityLabel kind="approval" label="Input needed" />
        {(p.questions ?? []).map((q: any) => (
          <label key={q.id} className="block">
            {q.question}
            <input
              className="block rounded border p-1"
              value={answers[q.id] ?? ""}
              onChange={(ev) =>
                setAnswers({ ...answers, [q.id]: ev.target.value })
              }
            />
            {q.options?.map((o: any) => (
              <Button
                variant="outline"
                size="sm"
                key={o.label}
                onClick={() => setAnswers({ ...answers, [q.id]: o.label })}
              >
                {o.label}{o.description ? ` — ${o.description}` : ""}
              </Button>
            ))}
          </label>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={submitting || (p.questions ?? []).some((q: any) => !answers[q.id]?.trim())}
          onClick={() => {
            if (submitting) return;
            setSubmitting(true);
            void respond(e, {
              answers: Object.fromEntries(
                Object.entries(answers).map(([id, value]) => [
                  id,
                  { answers: [value] },
                ]),
              ),
            }).finally(() => setSubmitting(false));
          }}
        >
          Answer
        </Button>
      </div>
    );
  const permissions = e.method === "item/permissions/requestApproval";
  const approval = e.method.endsWith("/requestApproval");
  return (
    <div className="space-y-2 rounded border p-3">
      <ActivityLabel kind="approval" label={approval ? "Permission requested" : "Interaction requested"} />
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
        {[
          p.reason,
          p.command,
          p.cwd ? `Working directory: ${p.cwd}` : null,
          p.grantRoot ? `Requested access: ${p.grantRoot}` : null,
          p.permissions ? JSON.stringify(p.permissions, null, 2) : null,
          p.message,
        ]
          .filter(Boolean)
          .join("\n") || "Codex needs your permission to continue."}
      </pre>
      <p className="text-xs">
        Project edits belong in this chat’s proposal workspace. Approved
        unrestricted commands can access files outside it.
      </p>
      {approval ? (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void respond(
                e,
                permissions
                  ? { permissions: p.permissions, scope: "turn" }
                  : { decision: "accept" },
              )
            }
          >
            Allow once
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-3"
            onClick={() =>
              void respond(
                e,
                permissions
                  ? { permissions: {}, scope: "turn" }
                  : { decision: "decline" },
              )
            }
          >
            Deny
          </Button>
        </>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void respond(e, { action: "cancel", content: null })}
        >
          Cancel unsupported interaction
        </Button>
      )}
    </div>
  );
}
