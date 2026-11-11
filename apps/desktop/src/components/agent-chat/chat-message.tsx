import { memo, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatItem } from "@/stores/agent-chat-store";
import {
  activityPresentation,
  activityState,
  commandLanguage,
} from "@/lib/chat-activity";
import { openExternal } from "@/lib/backend/desktop-host";
import { toast } from "sonner";
import { ChatCode } from "./chat-code";
import { ActivityLabel, ActivityStatus } from "./activity-label";

import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";

function ChatLink({ href, ...props }: ComponentProps<"a">) {
  if (!href) return <a {...props} />;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <a href={href} {...props} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            void navigator.clipboard
              .writeText(href)
              .catch((error) =>
                toast.error(`Could not copy link: ${String(error)}`),
              );
          }}
        >
          Copy link address
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Stable renderers keep completed blocks mounted as later parts of a reply stream.
const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <ChatLink {...props} />,
  code: ({ className, children }) => (
    <ChatCode
      className={className}
      language={/\blanguage-([^\s]+)/.exec(className ?? "")?.[1]}
      code={String(children ?? "")}
    />
  ),
};

export const Message = memo(function Message({ item: m }: { item: ChatItem }) {
  if (m.type === "reasoning") return null;
  if (m.type === "commandExecution") return <CommandActivity item={m} />;
  if (
    m.type !== "agentMessage" &&
    m.type !== "userMessage" &&
    m.type !== "proposedPlan"
  ) {
    const activity = activityPresentation(m);
    return (
      <div
        className="space-y-1 px-1 text-xs text-muted-foreground"
        aria-label="Activity"
        role="group"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <ActivityLabel kind={activity.kind} label={activity.label} />{" "}
          <ActivityStatus state={activityState(m)} />
        </div>
        {activity.detail && (
          <div className="min-w-0 whitespace-pre-wrap break-words">
            {activity.detail}
          </div>
        )}
        {activity.urls.map((url) => (
          <ChatLink
            key={url}
            href={url}
            className="block break-all underline underline-offset-2 hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              void openExternal(url).catch((error) =>
                toast.error(String(error)),
              );
            }}
          >
            {url}
          </ChatLink>
        ))}
      </div>
    );
  }
  return (
    <article
      className={cn(
        "text-sm leading-relaxed",
        m.type === "userMessage"
          ? "ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2.5"
          : m.phase === "commentary"
            ? "min-w-0 px-1 text-muted-foreground"
            : "min-w-0 px-1 text-foreground",
      )}
      aria-label={m.type === "userMessage" ? "You" : "Codex"}
    >
      {m.type === "userMessage" && m.status === "failed" && (
        <ActivityStatus state={{ tone: "error", label: "Submission failed" }} />
      )}
      {(m.phase === "commentary" || m.type === "proposedPlan") && (
        <div className="mb-1">
          <ActivityLabel
            kind={m.type === "proposedPlan" ? "plan" : "progress"}
            label={m.type === "proposedPlan" ? "Plan" : "Progress"}
          />
        </div>
      )}
      <div className="chat-markdown break-words [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold">
        <ReactMarkdown
          components={markdownComponents}
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
        >
          {m.text}
        </ReactMarkdown>
      </div>
    </article>
  );
});

function CommandActivity({ item }: { item: ChatItem }) {
  const [expanded, setExpanded] = useState(false);
  const command = String(item.activity?.command ?? item.text.split("\n")[0]);
  return (
    <details
      className="group min-w-0 px-1 text-muted-foreground text-xs"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ActivityLabel kind="command" label="Command" />{" "}
        <span className="min-w-0 flex-1 truncate font-mono">
          {command.replace(/\s+/g, " ")}
        </span>{" "}
        <ActivityStatus state={activityState(item)} />
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 group-open:rotate-90"
        />
      </summary>
      {expanded && (
        <div className="chat-markdown">
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-xs">
            <ChatCode code={command} language={commandLanguage(item)} />
          </pre>
        </div>
      )}
    </details>
  );
}
