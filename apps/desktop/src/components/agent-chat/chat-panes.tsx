import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TabState } from "@/stores/agent-chat-store";
import { ChatHistory } from "./chat-history";
import { TranscriptActivity } from "./transcript-activity";

interface PaneState { offset: number | null; count: number; characters: number; scroll: number; follow: boolean }
const Pane = memo(function Pane({ tab, active, state }: { tab: TabState; active: boolean; state: PaneState }) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(state.follow);
  const [snapshot, setSnapshot] = useState(tab.messages);
  const [historyGeneration, setHistoryGeneration] = useState(0);
  const wasInactive = useRef(false);
  useEffect(() => {
    if (!active) { wasInactive.current = true; return; }
    if (snapshot === tab.messages) { wasInactive.current = false; return; }
    // Restored or background history is a snapshot, never a replay of old events.
    const resetPage = wasInactive.current || snapshot.length === 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        if (resetPage) {
          state.offset = null;
          state.follow = true;
          follow.current = true;
          setHistoryGeneration(n => n + 1);
        }
        wasInactive.current = false;
        setSnapshot(tab.messages);
      }, 0);
    });
    let timer: number | undefined;
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [active, tab.messages, snapshot, state]);
  useLayoutEffect(() => {
    if (!active || !viewport.current) return;
    follow.current = true;
    state.follow = true;
    viewport.current.scrollTop = viewport.current.scrollHeight;
    state.scroll = viewport.current.scrollTop;
  }, [active, state]);
  useLayoutEffect(() => {
    if (active && follow.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [snapshot]);
  return <div aria-hidden={!active} inert={!active} className="absolute inset-0 space-y-4 overflow-y-auto" style={{ opacity: active ? 1 : 0, pointerEvents: active ? "auto" : "none", contain: "layout paint", scrollBehavior: "auto", overflowAnchor: "none", willChange: "opacity" }}
    ref={viewport} onScroll={e => {
      const el = e.currentTarget;
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      state.scroll = el.scrollTop; state.follow = follow.current;
    }}>
    <TranscriptActivity value={active}>
      <ChatHistory key={historyGeneration} messages={snapshot} viewport={viewport} progressive active={active} retainedState={state} owner={{ projectPath: tab.projectPath, chatId: tab.id }} />
    </TranscriptActivity>
  </div>;
});

/** Inactive snapshots stay frozen; only three recently visited panes retain DOM. */
export function ChatPanes({ tabs, activeId }: { tabs: TabState[]; activeId: string }) {
  const recent = useRef<string[]>([]);
  const states = useRef(new Map<string, PaneState>());
  for (const id of states.current.keys()) if (!tabs.some(t => t.id === id)) states.current.delete(id);
  recent.current = [activeId, ...recent.current.filter(id => id !== activeId)]
    .filter(id => tabs.some(t => t.id === id)).slice(0, 3);
  const retained = useRef(new Map<string, TabState>());
  for (const id of recent.current) {
    const tab = tabs.find(t => t.id === id)!;
    if (!states.current.has(id)) states.current.set(id, { offset: null, count: 0, characters: 0, scroll: 0, follow: true });
    if (id === activeId || !retained.current.has(id)) retained.current.set(id, tab);
  }
  for (const id of retained.current.keys()) {
    if (!recent.current.includes(id)) retained.current.delete(id);
  }
  return <div className="relative min-h-0 flex-1">{[...retained.current].map(([id, tab]) => <Pane key={id} tab={tab} active={id === activeId} state={states.current.get(id)!} />)}</div>;
}
