import { memo } from "react";
import { useShallow } from "zustand/shallow";
import {
  CircleAlertIcon,
  ClockIcon,
  InfoIcon,
  Loader2Icon,
} from "lucide-react";
import { activeProposal, useAgentChatStore } from "@/stores/agent-chat-store";
import { useAgentSetupStore } from "@/stores/agent-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { activityLabels, useActivityStore } from "@/stores/activity-store";
import { useProposalPdfError } from "@/hooks/use-chat-pdf";

/** This component subscribes to lifecycle metadata only, never drafts or messages. */
export const ActivityLine = memo(function ActivityLine({
  attaching,
  onConnect,
}: {
  attaching: boolean;
  onConnect: () => void;
}) {
  const chat = useAgentChatStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      const requests = tab?.sessionId
        ? s.requests.filter((r) => r.params.threadId === tab.sessionId)
        : [];
      return {
        projectPath: s.activeProjectPath,
        activeId: s.activeTabId,
        error: tab?.error || s.error,
        streaming: !!tab?.isStreaming,
        restoring: s.restoringChats || !!tab?.restoring,
        legacy: !s.review.active && s.review.changes.length > 0,
        waiting: requests.some((r) => r.method === "item/tool/requestUserInput")
          ? "answer"
          : requests.length
            ? "approval"
            : null,
        proposal: activeProposal(s),
        // A stable primitive prevents transcript/draft changes from publishing a new selection.
        tabSummary: JSON.stringify(
          s.tabs.map((t) => [t.id, t.title, t.isStreaming]),
        ),
      };
    }),
  );
  const operations = useActivityStore((s) => s.operations);
  const setup = useAgentSetupStore((s) => s.status);
  const opening = useDocumentStore((s) => s.openingPhase);
  const compiling = useDocumentStore((s) => s.isCompiling);
  const saving = useDocumentStore((s) => s.isSaving);
  const compileError = useDocumentStore((s) => s.compileError);
  const proposalPdfError = useProposalPdfError(chat.proposal);
  const tabs = JSON.parse(chat.tabSummary) as [string, string, boolean][];
  const current = operations.filter((o) => o.projectPath === chat.projectPath);
  // Prefer project acceptance, then active-chat operations, then its tools/builds.
  const rank = (o: (typeof current)[number]) =>
    o.projectWide
      ? 0
      : o.chatId === chat.activeId
        ? o.group === "operation"
          ? 1
          : o.group === "agent"
            ? 2
            : 3
        : 4;
  const ordered = current
    .slice()
    .sort((a, b) => rank(a) - rank(b) || b.id - a.id);
  const operation = ordered[0];
  const titles = new Map(tabs.map(([id, title]) => [id, title]));
  const otherChats = new Set([
    ...current
      .map((o) => o.chatId)
      .filter((id): id is string => !!id && id !== chat.activeId),
    ...tabs
      .filter(([id, , running]) => id !== chat.activeId && running)
      .map(([id]) => id),
  ]);
  let text = "Project context included";
  let detail: string | undefined;
  let tone: "idle" | "busy" | "waiting" | "error" = "idle";
  let connect = false;
  const pdfError =
    proposalPdfError ||
    (!chat.proposal && !compiling && !current.some((o) => o.projectWide)
      ? compileError
      : null);
  if (chat.error || pdfError) {
    text = chat.error
      ? "Action failed — see error details"
      : "PDF preparation failed — see error details";
    detail = chat.error || pdfError || undefined;
    tone = "error";
  } else if (chat.waiting) {
    text =
      chat.waiting === "answer"
        ? "Waiting for your answer"
        : "Waiting for approval";
    tone = "waiting";
  } else if (opening) {
    text = opening === "registering" ? "Opening project…" : opening === "scanning" ? "Discovering project files…" : "Reading document sources…";
    tone = "busy";
  } else if (
    operation &&
    (operation.projectWide ||
      operation.chatId === chat.activeId ||
      (!chat.streaming &&
        !attaching &&
        !chat.restoring &&
        !compiling &&
        !saving))
  ) {
    if (operation.chatId && operation.chatId !== chat.activeId)
      otherChats.delete(operation.chatId);
    text = activityLabels[operation.kind];
    if (operation.chatId && operation.chatId !== chat.activeId)
      text += ` · ${titles.get(operation.chatId) ?? "Another chat"}`;
    tone = "busy";
  } else if (chat.restoring) {
    text = "Restoring conversations…";
    tone = "busy";
  } else if (attaching) {
    text = "Adding files…";
    tone = "busy";
  } else if (chat.streaming) {
    text = "Codex is working…";
    tone = "busy";
  } else if (compiling || saving) {
    text = compiling ? "Preparing PDF…" : "Saving project files…";
    tone = "busy";
  } else if (otherChats.size) {
    text = `${otherChats.size} other ${otherChats.size === 1 ? "chat is" : "chats are"} working…`;
    otherChats.clear();
    tone = "busy";
  } else if (chat.legacy) {
    text = "Resolve the legacy review before sending";
    tone = "waiting";
  } else if (chat.proposal?.state === "conflicts") {
    text = "Conflicts need attention";
    tone = "waiting";
  } else if (chat.proposal?.state === "applying") {
    text = "Interrupted application — retry in review";
    tone = "waiting";
  } else if (
    chat.proposal?.changes.length &&
    !["running", "repairing"].includes(chat.proposal.state)
  ) {
    text = "Changes ready to review";
    tone = "waiting";
  } else if (setup !== "ready") {
    text = "Connect Codex to start chatting";
    connect = true;
  }
  if (otherChats.size)
    text += ` · ${otherChats.size} other ${otherChats.size === 1 ? "chat active" : "chats active"}`;
  if (!detail && tone === "busy") {
    const pending = [...new Set(current.map(o => activityLabels[o.kind]))];
    if (chat.restoring) pending.push("Restoring conversations…");
    if (compiling) pending.push("Preparing PDF…");
    detail = [text, ...pending.filter(label => label !== text)].join("\n");
  }
  const Icon =
    tone === "busy"
      ? Loader2Icon
      : tone === "error"
        ? CircleAlertIcon
        : tone === "waiting"
          ? ClockIcon
          : InfoIcon;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-activity-tone={tone}
      className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]"
      title={detail ?? text}
    >
      <Icon
        aria-hidden="true"
        className={`size-3 shrink-0 ${tone === "busy" ? "animate-spin motion-reduce:animate-none" : ""} ${tone === "error" ? "text-destructive" : tone === "waiting" ? "text-amber-500" : ""}`}
      />
      {connect ? (
        <button
          className="truncate underline underline-offset-2"
          onClick={onConnect}
        >
          {text}
        </button>
      ) : (
        <span className="truncate">{text}</span>
      )}
    </span>
  );
});
