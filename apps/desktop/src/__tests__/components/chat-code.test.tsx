import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Message } from "@/components/agent-chat/chat-message";
vi.mock("@/lib/backend/desktop-host", () => ({ openExternal: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
async function render(text: string) {
  await act(async () =>
    root.render(
      <Message
        item={{ id: "reply", type: "agentMessage", text, phase: "commentary" }}
      />,
    ),
  );
}
async function colour() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
    await vi.dynamicImportSettled();
  });
}

it("shows streamed code immediately, highlights a pause, and keeps completed blocks mounted", async () => {
  await render('```python\nprint("hello"); n = 42\n```\nFirst paragraph.');
  expect(host.querySelector("code")?.textContent).toBe(
    'print("hello"); n = 42\n',
  );
  await colour();
  const keyword = host.querySelector(".hljs-built_in");
  expect(keyword?.textContent).toBe("print");
  expect(host.querySelector(".hljs-number")?.textContent).toBe("42");
  await render(
    '```python\nprint("hello"); n = 42\n```\nFirst paragraph. More streamed text.',
  );
  expect(host.querySelector(".hljs-built_in")).toBe(keyword);
  expect(vi.getTimerCount()).toBe(0);
});

it("never displays stale highlighted text while a fence is still being streamed", async () => {
  await render('```python\nprint("old")');
  await colour();
  expect(host.querySelector(".hljs-string")?.textContent).toBe('"old"');
  await render('```python\nprint("new")');
  expect(host.querySelector("code")?.textContent).toBe('print("new")\n');
  expect(host.querySelector(".hljs-string")).toBeNull();
  await colour();
  expect(host.querySelector(".hljs-string")?.textContent).toBe('"new"');
});

it("keeps inline, unlabelled, unsupported, and oversized code readable as plain text", async () => {
  const large = "x".repeat(20_001);
  await render(
    "Inline `print(42)`\n\n```\nprint(42)\n```\n\n```unknown-language\n<unsafe>\n```\n\n```python\n" +
      large +
      "\n```",
  );
  await colour();
  expect(host.querySelectorAll("code span")).toHaveLength(0);
  expect(host.textContent).toContain("<unsafe>");
  expect(host.textContent).toContain(large);
  expect(host.querySelector("unsafe")).toBeNull();
});

it("keeps math rendering and prose separate from code highlighting", async () => {
  await render(
    "A formula $x^2$ and a citation.\n\n```latex\n\\cite{smith}\n```",
  );
  await colour();
  expect(host.querySelector(".katex")).not.toBeNull();
  expect(host.querySelector("code .syntax-string")?.textContent).toBe("\\cite");
  expect(host.querySelector("p .syntax-string")).toBeNull();
});

it("highlights a command only when expanded and preserves its exact text", async () => {
  const command = 'printf "hello\nworld"';
  await act(async () =>
    root.render(
      <Message
        item={{
          id: "cmd",
          type: "commandExecution",
          text: "",
          activity: { command },
          status: "completed",
        }}
      />,
    ),
  );
  expect(host.querySelector("pre")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  const details = host.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(host.querySelector("code")?.textContent).toBe(command);
  await colour();
  expect(host.querySelector(".hljs-string")).not.toBeNull();
  await act(async () => {
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(host.querySelector("pre")).toBeNull();
});
