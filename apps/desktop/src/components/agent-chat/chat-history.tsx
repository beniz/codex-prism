import { beginActivity, type ActivityOwner } from "@/stores/activity-store";
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ChatItem } from "@/stores/agent-chat-store";
import { Message } from "./chat-message";

const PAGE_SIZE = 60;

/** Avoid parsing an entire resumed conversation before showing its latest reply. */
export const ChatHistory = memo(function ChatHistory({
  messages,
  viewport,
  progressive = false,
  active = true,
  retainedState,
  owner,
}: {
  messages: ChatItem[];
  owner?: ActivityOwner;
  retainedState?: { offset: number | null; count: number; characters: number; scroll: number; follow: boolean };
  progressive?: boolean;
  active?: boolean;
  viewport: RefObject<HTMLDivElement | null>;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const previousHeight = useRef<number | null>(null);
  const visible = messages.filter((m) => m.type !== "reasoning");
  // Anchor an explicitly expanded history so streaming doesn't shift old messages out.
  const start = useRef<number | null>(retainedState?.offset ?? null);
  if (start.current === null && visible.length)
    start.current = Math.max(0, visible.length - PAGE_SIZE);
  const offset = start.current ?? 0;
  const [rendered, setRendered] = useState(progressive ? 0 : Infinity);
  const restoreScroll = useRef(!!retainedState);
  const count = visible.length - offset;
  const preparing = progressive && restoreScroll.current && rendered < count;
  useLayoutEffect(() => {
    if (count > 0 && rendered >= count && restoreScroll.current && viewport.current) {
      if (retainedState?.follow) viewport.current.scrollTop = viewport.current.scrollHeight;
      restoreScroll.current = false;
    }
  }, [rendered, count, viewport]);
  const busy = progressive && rendered < count;
  useEffect(() => {
    if (!active || !busy || !owner) return;
    const activity = beginActivity(owner, "conversation");
    return () => activity.finish();
  }, [active, busy, owner?.projectPath, owner?.chatId]);
  if (retainedState) {
    retainedState.offset = offset;
    retainedState.count = count;
    retainedState.characters = visible.slice(offset).reduce((n, m) => n + (m.text?.length ?? 0), 0);
  }
  useEffect(() => {
    if (!active || rendered >= count) return;
    const timer = window.setTimeout(() => { if (!preparing) previousHeight.current = viewport.current?.scrollHeight ?? null; setRendered(n => n + 1); }, 8);
    return () => clearTimeout(timer);
  }, [active, rendered, count, preparing]);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && previousHeight.current !== null) {
      el.scrollTop += el.scrollHeight - previousHeight.current;
      previousHeight.current = null;
    }
  }, [limit, rendered, viewport]);
  return (
    <>
      {!preparing && offset > 0 && (
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
      {rendered < count && <p role="status" className="px-1 text-sm leading-relaxed text-muted-foreground">Loading conversation history…</p>}
      <div aria-hidden={preparing || undefined} inert={preparing} className="space-y-4"
        style={preparing ? { position: "absolute", insetInline: 0, top: 0, height: 0, overflow: "hidden", contain: "layout paint", visibility: "hidden", pointerEvents: "none" } : undefined}>
      {visible.slice(Math.max(offset, visible.length - rendered)).map((item) => (
        <Message key={item.id} item={item} />
      ))}
      </div>
    </>
  );
});
