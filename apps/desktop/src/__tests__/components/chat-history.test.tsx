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
