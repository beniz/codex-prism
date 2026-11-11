import { useEffect, useRef, useState, type RefObject } from "react";
import { mentionAt, referenceText, sourceRequest, type SourceCatalogue, type SourceListing } from "@/lib/source-completion";
import { useAgentChatStore } from "@/stores/agent-chat-store";
interface Choice { label: string; insertion: string }
export function SourceCompletion({ projectId, chatId, draft, input, change }: { projectId: string | null; chatId: string; draft: string; input: RefObject<HTMLTextAreaElement | null>; change: (text: string) => void }) {
  const ownership = useAgentChatStore(s => { const t = s.tabs.find(t => t.id === chatId); const p = s.proposals.find(p => p.state !== "original" && (p.chatId === chatId || (t?.sessionId && p.threadId === t.sessionId))); return `${t?.turnId}/${t?.isStreaming}/${p?.id}/${p?.generation}/${p?.state}`; });
  const [tick, refresh] = useState(0);
  const [visible, setVisible] = useState(false);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [index, setIndex] = useState(0);
  const [message, setMessage] = useState("");
  const dismissed = useRef<string | null>(null);
  const composing = useRef(false);
  const cache = useRef(new Map<string, SourceCatalogue | SourceListing>());
  const latest = useRef({ choices, index, visible, change }); latest.current = { choices, index, visible, change };
  function accept(choice: Choice) {
    const field = input.current; if (!field) return;
    const token = mentionAt(field.value, field.selectionStart); if (!token) return;
    const value = field.value.slice(0, token.from) + choice.insertion + field.value.slice(token.to);
    latest.current.change(value);
    const caret = token.from + choice.insertion.length;
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(caret, caret); refresh(n => n + 1); });
  }
  useEffect(() => {
    cache.current.clear(); dismissed.current = null; setVisible(false); refresh(n => n + 1);
  }, [projectId, chatId, ownership]);
  useEffect(() => {
    const clear = () => { cache.current.clear(); dismissed.current = null; refresh(n => n + 1); };
    window.addEventListener("prism-sources-changed", clear);
    return () => window.removeEventListener("prism-sources-changed", clear);
  }, []);
  useEffect(() => {
    const field = input.current; if (!field) return;
    const update = (event: Event) => { if (event.type !== "keyup" || ["ArrowLeft", "ArrowRight", "Home", "End"].includes((event as KeyboardEvent).key)) refresh(n => n + 1); };
    const blur = () => { cache.current.clear(); setVisible(false); };
    const compositionStart = () => { composing.current = true; setVisible(false); refresh(n => n + 1); };
    const compositionEnd = () => { composing.current = false; refresh(n => n + 1); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const state = latest.current;
      if (event.key === "Tab" && mentionAt(field.value, field.selectionStart)) { event.preventDefault(); event.stopPropagation(); if (state.visible && state.choices.length) accept(state.choices[state.index]); else { dismissed.current = null; refresh(n => n + 1); } return; }
      if (!state.visible) return;
      if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape") { dismissed.current = field.value; setVisible(false); }
        else if (event.key === "Enter") { if (state.choices.length) accept(state.choices[state.index]); }
        else setIndex(i => state.choices.length ? (i + (event.key === "ArrowDown" ? 1 : state.choices.length - 1)) % state.choices.length : 0);
      }
    };
    field.addEventListener("keydown", key); field.addEventListener("keyup", update); field.addEventListener("click", update); field.addEventListener("focus", update); field.addEventListener("blur", blur);
    field.addEventListener("compositionstart", compositionStart); field.addEventListener("compositionend", compositionEnd);
    return () => { field.removeEventListener("keydown", key); field.removeEventListener("keyup", update); field.removeEventListener("click", update); field.removeEventListener("focus", update); field.removeEventListener("blur", blur); field.removeEventListener("compositionstart", compositionStart); field.removeEventListener("compositionend", compositionEnd); };
  }, [input, chatId]);
  useEffect(() => {
    const field = input.current;
    const token = field && field.selectionStart === field.selectionEnd ? mentionAt(draft, field.selectionStart) : null;
    if (!projectId || !token || composing.current || dismissed.current === draft || document.activeElement !== field) { setVisible(false); return; }
    let alive = true;
    setVisible(true); setChoices([]); setIndex(0); setMessage("Loading sources…");
    const timer = setTimeout(() => { void (async () => {
      try {
        let catalogue = cache.current.get("catalogue") as SourceCatalogue | undefined;
        if (!catalogue) { catalogue = await sourceRequest<SourceCatalogue>(projectId, chatId, "source_catalogue"); if (!alive) return; cache.current.set("catalogue", catalogue); }
        let next: Choice[];
        if (token.path === undefined) {
          next = catalogue.entries.filter(s => s.id.startsWith(token.alias.toLowerCase())).flatMap(s => [
            { label: `Use entire source · ${s.id} — ${s.name}`, insertion: referenceText(s.id, "", false) },
            { label: `Browse files · ${s.id} — ${s.name}`, insertion: `@${s.id}:/` },
          ]);
          if (alive) setMessage(next.length > 100 ? "More matches available; refine your prefix" : next.length ? "" : "No registered sources match");
        } else {
          if (!catalogue.entries.some(s => s.id === token.alias)) throw new Error(`Unknown or removed data source: ${token.alias}`);
          const path = token.path || "/";
          const slash = path.lastIndexOf("/");
          if (slash < 0) throw new Error("Source paths start with /");
          const directory = path.slice(0, slash + 1); const prefix = path.slice(slash + 1);
          const selection: Choice[] = prefix ? [] : [{
            label: directory === "/" ? "Use entire source" : "Use this directory",
            insertion: referenceText(token.alias, token.path, false),
          }];
          // Selecting the source must not depend on listing its contents (which
          // may require a slow or currently unavailable SSH connection).
          if (alive) setChoices(selection);
          const key = JSON.stringify([token.alias, directory, prefix]);
          let listing = cache.current.get(key) as SourceListing | undefined;
          if (!listing) { listing = await sourceRequest<SourceListing>(projectId, chatId, "source_browse", { sourceId: token.alias, path: directory, prefix, revision: catalogue.revision, generation: catalogue.generation }); if (!alive) return; if (cache.current.size >= 128) cache.current.clear(); cache.current.set(key, listing); }
          next = [...selection, ...listing.entries.map(e => ({ label: e.name + (e.directory ? "/" : ""), insertion: referenceText(token.alias, directory + e.name + (e.directory ? "/" : ""), e.directory) }))];
          if (alive) setMessage(listing.truncated ? "More matches available; refine your prefix" : next.length ? "" : "No matching entries");
        }
        if (alive) setChoices(next.slice(0, 100));
      } catch (error) { if (alive) { setMessage(String(error)); cache.current.clear(); } }
    })(); }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [draft, tick, projectId, chatId, ownership, input]);
  useEffect(() => { const field = input.current; if (!field) return; field.setAttribute("aria-autocomplete", "list"); field.setAttribute("aria-expanded", String(visible)); if (visible) { field.setAttribute("aria-controls", "source-completions"); } else { field.removeAttribute("aria-controls"); } if (visible && choices.length) field.setAttribute("aria-activedescendant", `source-choice-${index}`); else field.removeAttribute("aria-activedescendant"); }, [visible, choices.length, index, input]);
  useEffect(() => { if (visible) document.getElementById(`source-choice-${index}`)?.scrollIntoView?.({ block: "nearest" }); }, [index, visible]);
  if (!visible) return null;
  return <div className="mx-2 max-h-56 overflow-auto rounded border bg-popover p-1 text-sm shadow-md" onMouseDown={e => e.preventDefault()}>
    <div id="source-completions" role="listbox" aria-label="Data source completion">{choices.map((choice, i) => <div key={choice.insertion} id={`source-choice-${i}`} role="option" aria-selected={i === index} className={`cursor-pointer rounded px-2 py-1 ${i === index ? "bg-accent" : ""}`} onMouseDown={e => { e.preventDefault(); accept(choice); }}>{choice.label}</div>)}</div>
    {message && <p role="status" className="p-2 text-xs text-muted-foreground">{message}</p>}
    <button className="px-2 text-xs underline" onMouseDown={e => { e.preventDefault(); cache.current.clear(); refresh(n => n + 1); }}>Refresh / retry</button>
  </div>;
}
