import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatPanes } from "@/components/agent-chat/chat-panes";
import type { TabState } from "@/stores/agent-chat-store";
vi.mock("@/components/agent-chat/chat-message", () => ({
  Message: ({ item }: any) => <article>{item.text}</article>,
}));
it("retains warm DOM and freezes inactive transcripts until selected", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tab = (id: string): TabState => ({
    id, title: id, projectPath: "/test", sessionId: id, turnId: null,
    isStreaming: false, error: null, draft: "",
    messages: [{ id, type: "agentMessage", text: id }],
  });
  let tabs = [tab("a"), tab("b")];
  const show = async (activeId: string) => act(async () => {
    root.render(<ChatPanes tabs={tabs} activeId={activeId} />);
  });
  const settle = async () => act(async () => { await new Promise(r => setTimeout(r, 60)); });
  try {
    await show("a"); await settle();
    const original = host.querySelector("article");
    expect(original?.textContent).toBe("a");
    const pane = host.querySelector<HTMLDivElement>('[aria-hidden="false"]')!;
    Object.defineProperty(pane, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 100 });
    pane.scrollTop = 40;
    await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
    await show("b"); await settle();
    tabs = [{ ...tabs[0], messages: [{ id: "a", type: "agentMessage", text: "updated" }] }, tabs[1]];
    await show("b"); await settle();
    expect(original?.textContent).toBe("a");
    await show("a");
    expect(pane.scrollTop).toBe(1000);
    expect(pane.style.scrollBehavior).toBe("auto");
    expect(host.querySelector("article")).toBe(original);
    await settle(); await settle(); await settle();
    expect(host.querySelector("article")?.textContent).toBe("updated");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps an unchanged large conversation mounted when switching back", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const base = { projectPath: "/test", sessionId: null, turnId: null, isStreaming: false, error: null, draft: "" };
  const tabs: TabState[] = [
    { ...base, id: "large", title: "Large", messages: [{ id: "large", type: "agentMessage", text: "x".repeat(300_000) }] },
    { ...base, id: "other", title: "Other", messages: [] },
  ];
  const show = async (id: string) => act(async () => { root.render(<ChatPanes tabs={tabs} activeId={id} />); });
  try {
    await show("large");
    await act(async () => { await new Promise(r => setTimeout(r, 40)); });
    const original = host.querySelector("article");
    expect(original).not.toBeNull();
    await show("other");
    await show("large");
    expect(host.querySelector("article")).toBe(original);
    expect(host.textContent).not.toContain("Loading conversation");
  } finally { await act(async () => root.unmount()); }
});
it("loads a late restored history from its latest page rather than replaying it", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  let tab: TabState = { id: "one", title: "One", projectPath: "/test", sessionId: null, turnId: null, isStreaming: false, error: null, draft: "", messages: [] };
  try {
    await act(async () => root.render(<ChatPanes tabs={[tab]} activeId="one" />));
    tab = { ...tab, messages: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), type: "agentMessage", text: `Reply ${i}` })) };
    await act(async () => root.render(<ChatPanes tabs={[tab]} activeId="one" />));
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(host.textContent).toContain("Reply 999");
    expect(host.querySelector('article')?.textContent).not.toBe("Reply 0");
    expect(host.querySelector('[inert]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});
