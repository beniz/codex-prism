import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RemoteWork } from "@/components/remote-work";
import { collaboration } from "@/lib/collaboration";

vi.mock("@/lib/collaboration", () => ({ collaboration: vi.fn() }));
vi.mock("@/components/workspace/preview/pdf-viewer", () => ({
  PdfViewer: ({ rootFileId }: { rootFileId: string }) => (
    <div>Preview {rootFileId}</div>
  ),
}));

it("keeps Writing mounted and restores the pinned PR without fetching again", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const entry = {
    number: 7,
    name: "Conference paper",
    sha: "1234567890",
    base: "conference",
  };
  vi.mocked(collaboration).mockImplementation(async (_project, op) => {
    switch (op) {
      case "remote_work_branches":
        return [];
      case "remote_work_pulls":
        return [entry];
      case "remote_work_open":
        return {
          id: "review",
          entry,
          sha: entry.sha,
          base: entry.base,
          baseSha: "abcdef",
          sources: { "main.tex": "Draft" },
          diff: "+Draft",
        };
      case "remote_work_compile":
        return { pdf: "JVBERg==", locations: [] };
      case "remote_work_close":
        return null;
      default:
        throw new Error(op);
    }
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  async function click(label: string) {
    const button = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === label || b.getAttribute("aria-label") === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }
  try {
    await act(async () =>
      root.render(
        <RemoteWork projectId="p">
          <textarea defaultValue="Unsaved" />
        </RemoteWork>,
      ),
    );
    const editor = host.querySelector("textarea");
    expect(collaboration).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("prism-browse-remote-work", { detail: "p" }),
      );
    });
    await click("Pull requests");
    const row = host.querySelector("strong")!.closest("button")!;
    await act(async () => row.click());
    expect(host.textContent).toContain("+Draft");
    await click("Compile PDF");
    expect(host.textContent).toContain("Preview main.tex");
    await click("Writing");
    expect(host.querySelector("textarea")).toBe(editor);
    expect(host.querySelector("section")).toBeNull();
    const count = vi.mocked(collaboration).mock.calls.length;
    await click("PR #7 · Conference paper");
    expect(host.textContent).toContain("Preview main.tex");
    expect(collaboration).toHaveBeenCalledTimes(count);
    await click("Close remote review");
    expect(collaboration).toHaveBeenLastCalledWith("p", "remote_work_close", {
      id: "review",
    });
  } finally {
    await act(async () => root.unmount());
  }
});
