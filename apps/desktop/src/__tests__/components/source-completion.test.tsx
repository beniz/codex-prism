import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceCompletion } from "@/components/agent-chat/source-completion";
import { sourceRequest } from "@/lib/source-completion";
vi.mock("@/stores/agent-chat-store", () => ({ useAgentChatStore: () => "idle" }));
vi.mock("@/lib/source-completion", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/source-completion")>(), sourceRequest: vi.fn(),
}));
let host: HTMLDivElement;
let root: Root;
function Harness({ chatId = "one", initial = "@" }: { chatId?: string; initial?: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [draft, change] = useState(initial);
  return <><SourceCompletion projectId="project" chatId={chatId} draft={draft} input={input} change={change} /><textarea ref={input} value={draft} onChange={e => change(e.target.value)} /></>;
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(170); }); }
async function mount(initial = "@") {
  await act(async () => root.render(<Harness initial={initial} />));
  const field = host.querySelector("textarea")!;
  await act(async () => { field.focus(); field.setSelectionRange(field.value.length, field.value.length); });
  return field;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
it("supports selection, dismissal, retry and composition without consuming modified keys", async () => {
  vi.mocked(sourceRequest).mockResolvedValue({ entries: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }], revision: 1, generation: null });
  const field = await mount(); await tick();
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  const key = async (key: string, extra = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    await act(async () => { field.dispatchEvent(event); }); return event;
  };
  expect((await key("Enter", { shiftKey: true })).defaultPrevented).toBe(false);
  expect((await key("Tab", { shiftKey: true })).defaultPrevented).toBe(false);
  expect((await key("Enter", { isComposing: true })).defaultPrevented).toBe(false);
  await key("ArrowDown");
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain("beta");
  await key("Escape"); expect(host.querySelector('[role="listbox"]')).toBeNull();
  await key("Tab"); await tick(); expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  await act(async () => { field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => { field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
  await tick(); expect(host.querySelector('[role="listbox"]')).not.toBeNull();
});
it("ignores a late directory response from the previously selected chat", async () => {
  let finishOld!: (value: unknown) => void;
  vi.mocked(sourceRequest).mockImplementation(async (_project, chat, operation) => {
    if (operation === "source_catalogue") return { entries: [], revision: 1, generation: null } as any;
    if (chat === "one") return new Promise(resolve => { finishOld = resolve; });
    return { entries: [{ name: "current.pdf", directory: false }], revision: 1, generation: null, truncated: false } as any;
  });
  await mount("@data:/"); await tick();
  await act(async () => root.render(<Harness chatId="two" initial="@data:/" />)); await tick();
  expect(host.textContent).toContain("current.pdf");
  await act(async () => finishOld({ entries: [{ name: "wrong.pdf", directory: false }], revision: 1, generation: null, truncated: false }));
  expect(host.textContent).toContain("current.pdf"); expect(host.textContent).not.toContain("wrong.pdf");
});
