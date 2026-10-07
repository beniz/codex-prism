import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
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
  type ChatItem,
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

export function AgentChatDrawer({ fillHeight = false }: { fillHeight?: boolean }) {
  const s = useAgentChatStore();
  const setup = useAgentSetupStore();
  const [open, setOpen] = useState(true);
  const [settings, setSettings] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [filePicker, setFilePicker] = useState(false);
  const [query, setQuery] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useDocumentStore((d) => d.files);
  const t = s.tabs.find((t) => t.id === s.activeTabId)!;
  const reportError = (e: unknown) =>
    useAgentChatStore.setState({ error: String(e) });
  useEffect(() => {
    const el = viewport.current;
    if (el && followMessages.current) el.scrollTop = el.scrollHeight;
  }, [t.messages, s.requests, open]);
  useEffect(() => {
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
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(input.current.scrollHeight, 128)}px`;
    }
  }, [t.draft, open]);
  const model =
    setup.models.find((m) => m.model === s.selectedModel) ||
    setup.models.find((m) => m.isDefault);
  const canSend =
    !!t.draft.trim() &&
    (t.isStreaming || !s.locked) &&
    setup.status === "ready" &&
    !attaching;
  const setDraft = (draft: string) =>
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((x) => (x.id === t.id ? { ...x, draft } : x)),
    }));
  const send = () => {
    if (!canSend) return;
    const prompt = t.draft;
    setDraft("");
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
      const paths = await useDocumentStore
        .getState()
        .importFiles(
          Array.isArray(selected) ? selected : [selected],
          "attachments",
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
                  <span className="truncate">{x.title}</span>
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
              {s.tabs.map((x) => (
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
                    {x.title}
                  </button>
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
              ))}
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
            {!t.messages.length && (
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
            {t.messages.map((m) => (
              <Message key={m.id} item={m} />
            ))}
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
            <p
              role="alert"
              className="mx-3 mb-2 max-h-20 overflow-auto rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {s.error || t.error}
            </p>
          )}
          <div className="max-h-[70%] shrink-0 overflow-auto px-3 pb-3 pt-1">
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
              <textarea
                ref={input}
                rows={2}
                aria-label="Message Codex"
                className="block max-h-32 min-h-14 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70"
                placeholder={
                  t.isStreaming
                    ? "Guide the current turn…"
                    : s.locked
                      ? "Review the changes to continue…"
                      : "Ask Codex anything about your project…"
                }
                value={t.draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
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
                      Files are copied into project attachments.
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
                ) : s.locked ? (
                  "Project editing paused during execution and review"
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
                Enter to send · Shift+Enter for newline
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Message({ item: m }: { item: ChatItem }) {
  if (m.type !== "agentMessage" && m.type !== "userMessage")
    return (
      <details className="rounded-lg border bg-muted/20 px-3 py-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {(
            {
              reasoning: "Thinking",
              commandExecution: "Command",
              fileChange: "File changes",
              plan: "Plan",
            } as Record<string, string>
          )[m.type] || "Activity"}
          {m.status ? ` · ${m.status}` : ""}
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
          {m.text}
        </pre>
      </details>
    );
  return (
    <article
      className={cn(
        "text-sm leading-relaxed",
        m.type === "userMessage"
          ? "ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2.5"
          : "min-w-0 px-1",
      )}
      aria-label={m.type === "userMessage" ? "You" : "Codex"}
    >
      <div className="break-words [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
        >
          {m.text}
        </ReactMarkdown>
      </div>
    </article>
  );
}
function Request({ event: e }: { event: AgentEvent }) {
  const respond = useAgentChatStore((s) => s.respond);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const p = e.params;
  if (e.method === "item/tool/requestUserInput")
    return (
      <div className="rounded border p-3">
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
                {o.label}{" "}
              </Button>
            ))}
          </label>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void respond(e, {
              answers: Object.fromEntries(
                Object.entries(answers).map(([id, value]) => [
                  id,
                  { answers: [value] },
                ]),
              ),
            })
          }
        >
          Answer
        </Button>
      </div>
    );
  const permissions = e.method === "item/permissions/requestApproval";
  const approval = e.method.endsWith("/requestApproval");
  return (
    <div className="rounded border p-3">
      <strong>
        {approval ? "Permission requested" : "Interaction requested"}
      </strong>
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
        Changes outside the project are not covered by project Undo.
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
