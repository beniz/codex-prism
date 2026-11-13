import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatHistory } from "@/components/agent-chat/chat-history";
vi.mock("@/components/agent-chat/chat-message", () => ({
  Message: ({ item }: any) => <article>{item.text}</article>,
}));
it("renders recent history, expands earlier messages, and retains its position on append", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const viewport = createRef<HTMLDivElement>();
  const messages = Array.from({ length: 150 }, (_, i) => ({
    id: String(i),
    type: "agentMessage",
    text: `Reply ${i}`,
  }));
  try {
    await act(async () =>
      root.render(<ChatHistory messages={messages} viewport={viewport} />),
    );
    expect(container.querySelectorAll("article")).toHaveLength(60);
    expect(container.querySelector("article")?.textContent).toBe("Reply 90");
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelectorAll("article")).toHaveLength(120);
    expect(container.querySelector("article")?.textContent).toBe("Reply 30");
    await act(async () =>
      root.render(
        <ChatHistory
          messages={[
            ...messages,
            { id: "new", type: "agentMessage", text: "Latest" },
          ]}
          viewport={viewport}
        />,
      ),
    );
    expect(container.querySelector("article")?.textContent).toBe("Reply 30");
    expect(container.querySelectorAll("article")).toHaveLength(121);
  } finally {
    await act(async () => root.unmount());
  }
});

it("stages long history without exposing intermediate scroll positions", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  const viewport = { current: container };
  Object.defineProperty(container, "scrollHeight", { value: 1000 });
  const state = { offset: null, count: 0, characters: 0, scroll: 0, follow: true };
  const messages = Array.from({ length: 3 }, (_, i) => ({ id: String(i), type: "agentMessage", text: `Reply ${i}` }));
  try {
    await act(async () => root.render(<ChatHistory messages={messages} viewport={viewport} progressive retainedState={state} />));
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading conversation history…");
    expect(container.textContent).not.toContain("Reply 2");
    for (let i = 0; i < 2; i++) {
      await act(async () => vi.advanceTimersByTime(8));
      const staging = container.querySelector<HTMLElement>('[aria-hidden="true"]')!;
      expect(staging.style.height).toBe("0px");
      expect(staging.style.overflow).toBe("hidden");
      expect(container.scrollTop).toBe(0);
    }
    await act(async () => vi.advanceTimersByTime(8));
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll("article")).toHaveLength(3);
    expect(container.scrollTop).toBe(1000);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
