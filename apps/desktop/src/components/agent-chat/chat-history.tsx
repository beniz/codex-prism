import { memo, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ChatItem } from "@/stores/agent-chat-store";
import { Message } from "./chat-message";

const PAGE_SIZE = 60;

/** Avoid parsing an entire resumed conversation before showing its latest reply. */
export const ChatHistory = memo(function ChatHistory({
  messages,
  viewport,
}: {
  messages: ChatItem[];
  viewport: RefObject<HTMLDivElement | null>;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const previousHeight = useRef<number | null>(null);
  const visible = messages.filter((m) => m.type !== "reasoning");
  // Anchor an explicitly expanded history so streaming doesn't shift old messages out.
  const start = useRef<number | null>(null);
  if (start.current === null && visible.length)
    start.current = Math.max(0, visible.length - PAGE_SIZE);
  const offset = start.current ?? 0;
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && previousHeight.current !== null) {
      el.scrollTop += el.scrollHeight - previousHeight.current;
      previousHeight.current = null;
    }
  }, [limit, viewport]);
  return (
    <>
      {offset > 0 && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => {
            previousHeight.current = viewport.current?.scrollHeight ?? null;
            start.current = Math.max(0, offset - PAGE_SIZE);
            setLimit((n) => n + PAGE_SIZE);
          }}
        >
          Show earlier messages ({offset})
        </button>
      )}
      {visible.slice(offset).map((item) => (
        <Message key={item.id} item={item} />
      ))}
    </>
  );
});
