import { memo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatItem } from "@/stores/agent-chat-store";
import { summarizeActivity } from "@/lib/chat-activity";
import { openExternal } from "@/lib/backend/desktop-host";
import { toast } from "sonner";

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
            void navigator.clipboard.writeText(href).catch((error) =>
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

export const Message = memo(function Message({ item: m }: { item: ChatItem }) {
  if (m.type === "reasoning") return null;
  if (m.type === "commandExecution") {
    const command = m.activity?.command ?? m.text.split("\n")[0];
    const exitCode = m.activity?.exitCode;
    return (
      <details className="group min-w-0 px-1 text-muted-foreground text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="shrink-0">Command:</span>
          <span className="min-w-0 flex-1 truncate font-mono">
            {command.replace(/\s+/g, " ")}
          </span>
          {exitCode != null && exitCode !== 0 && (
            <span className="shrink-0">exit {exitCode}</span>
          )}
          {m.status && <span className="shrink-0">{m.status}</span>}
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 group-open:rotate-90"
          />
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
          {command}
        </pre>
      </details>
    );
  }
  if (m.type !== "agentMessage" && m.type !== "userMessage") {
    const activity = summarizeActivity(m);
    return (
      <div
        className="space-y-1 px-1 text-xs text-muted-foreground"
        aria-label="Activity"
      >
        <p className="whitespace-pre-wrap break-words">
          {activity.summary}
          {m.status ? ` · ${m.status}` : ""}
        </p>
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
      <div className="break-words [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold">
        <ReactMarkdown
          components={{ a: ({ node: _node, ...props }) => <ChatLink {...props} /> }}
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
        >
          {m.text}
        </ReactMarkdown>
      </div>
    </article>
  );
});
