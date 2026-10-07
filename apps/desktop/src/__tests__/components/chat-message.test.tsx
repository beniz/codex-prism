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
    expect(html).toContain("Search: LaTeX figures; TikZ diagrams");
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
