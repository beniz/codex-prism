import { act } from "react";
import { createRoot } from "react-dom/client";
import { openExternal } from "@/lib/backend/desktop-host";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Message } from "@/components/agent-chat/chat-message";
import { summarizeActivity } from "@/lib/chat-activity";
vi.mock("@/lib/backend/desktop-host", () => ({ openExternal: vi.fn() }));
describe("chat presentation", () => {
  it("renders commentary gray and final answers with normal foreground", () => {
    const base = { id: "a", type: "agentMessage", text: "Message" };
    expect(
      renderToStaticMarkup(<Message item={{ ...base, phase: "commentary" }} />),
    ).toContain("text-muted-foreground");
    expect(
      renderToStaticMarkup(
        <Message item={{ ...base, phase: "final_answer" }} />,
      ),
    ).toContain("text-foreground");
    expect(
      renderToStaticMarkup(<Message item={{ ...base, type: "reasoning" }} />),
    ).toBe("");
  });
  it("shows search queries and result URLs without activity bubbles", () => {
    const item = {
      id: "w",
      type: "webSearch",
      text: "",
      activity: {
        action: { type: "search", queries: ["LaTeX figures", "TikZ diagrams"] },
        results: [
          { title: "Guide", url: "https://example.org/guide" },
          { url: "javascript:alert(1)" },
        ],
      },
    };
    const html = renderToStaticMarkup(<Message item={item} />);
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector('[data-activity-kind="research"]')?.textContent).toBe("Search");
    expect(host.textContent).toContain("LaTeX figures; TikZ diagrams");
    expect(html).toContain('href="https://example.org/guide"');
    expect(html).not.toContain("<details");
    expect(html).not.toContain("javascript:");
  });
  it("shows visited URLs and preserves commands instead of dumping command output", () => {
    expect(
      summarizeActivity({
        id: "w",
        type: "webSearch",
        text: "",
        activity: {
          action: { type: "openPage", url: "https://example.org/page" },
        },
      }),
    ).toEqual({ summary: "Visited page", urls: ["https://example.org/page"] });
    expect(
      summarizeActivity({
        id: "c",
        type: "commandExecution",
        text: "large output",
        activity: {
          command: "cat main.tex",
          aggregatedOutput: "large output",
          exitCode: 0,
        },
      }).summary,
    ).toBe("Command: cat main.tex");
  });
  it("extracts URLs from MCP fetch arguments and structured results", () => {
    const result = summarizeActivity({
      id: "m",
      type: "mcpToolCall",
      text: "",
      activity: {
        tool: "webfetch",
        arguments: { url: "https://example.org/page" },
        result: {
          structuredContent: {
            links: [{ url: "https://example.org/reference" }],
          },
        },
      },
    });
    expect(result.urls).toEqual([
      "https://example.org/page",
      "https://example.org/reference",
    ]);
  });
});

it.each(["activity", "commentary", "final_answer"] as const)(
  "copies a %s link from its right-click menu without opening it",
  async (kind) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const url = "https://example.org/page?query=latex#figures";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(openExternal).mockClear();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(
        <Message item={kind === "activity" ? {
          id: "link",
          type: "webSearch",
          text: "",
          activity: { action: { type: "openPage", url } },
        } : {
          id: "link",
          type: "agentMessage",
          phase: kind,
          text: `[Read the guide](${url})`,
        }} />,
      ));
      await act(async () => {
        host.querySelector("a")!.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
        );
      });
      const copy = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === "Copy link address");
      expect(copy).toBeDefined();
      await act(async () => copy!.click());
      expect(writeText).toHaveBeenCalledWith(url);
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  },
);

it("shows a blue image label and a neutral path, with a separate successful outcome", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Message item={{ id: "image", type: "imageView", text: "", status: "completed", activity: { path: "/figures/curve.pdf" } }} />);
  expect(host.querySelector('[data-activity-kind="image"]')?.textContent).toBe("Viewed image");
  expect(host.querySelector('[data-activity-kind="image"]')?.textContent).not.toContain("curve.pdf");
  expect(host.textContent).toContain("/figures/curve.pdf");
  expect(host.querySelector('[data-activity-status="success"]')?.textContent).toBe("Completed");
});

it("marks failed completed commands red without exposing command output", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Message item={{ id: "cmd", type: "commandExecution", text: "hidden command output", status: "completed", activity: { command: "pdflatex main.tex", exitCode: 2 } }} />);
  expect(host.querySelector('[data-activity-kind="command"]')?.textContent).toBe("Command");
  expect(host.querySelector('[data-activity-status="error"]')?.textContent).toBe("Failed · exit 2");
  expect(host.querySelector('[data-activity-status="success"]')).toBeNull();
  expect(host.textContent).not.toContain("hidden command output");
  expect(host.querySelector("pre")).toBeNull();
});

it("labels visible commentary as progress while keeping reasoning hidden", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Message item={{ id: "note", type: "agentMessage", phase: "commentary", text: "I will compare the figures." }} />);
  expect(host.querySelector('[data-activity-kind="progress"]')?.textContent).toBe("Progress");
  expect(host.querySelector('[data-activity-kind="progress"]')?.textContent).not.toContain("compare");
  expect(renderToStaticMarkup(<Message item={{ id: "reason", type: "reasoning", text: "Not displayed" }} />)).toBe("");
});
