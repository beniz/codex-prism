import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PdfViewer } from "@/components/workspace/preview/pdf-viewer";
import {
  getCachedDocument,
  getOrOpenDocument,
} from "@/lib/mupdf/pdf-doc-cache";
vi.mock("@/lib/mupdf/pdf-doc-cache", () => ({
  getCachedDocument: vi.fn(),
  getOrOpenDocument: vi.fn(),
}));
vi.mock("@/components/workspace/preview/mupdf-page", () => ({
  MupdfPage: ({ pageIndex, overlay }: { pageIndex: number; overlay?: React.ReactNode }) => (
    <div className="mupdf-page" data-page-number={pageIndex + 1}>{overlay}</div>
  ),
}));
const { searchPage } = vi.hoisted(() => ({ searchPage: vi.fn() }));
vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: () => ({ searchPage }) }));
const bytes = new Uint8Array([37, 80, 68, 70, 45]).buffer;
const loaded = {
  docId: 1,
  pageSizes: Array.from({ length: 3 }, () => ({ width: 100, height: 200 })),
  cacheHit: true, release: () => {},
};
let root: Root, host: HTMLDivElement;
let props: Parameters<typeof PdfViewer>[0];
const shown = vi.fn();
const render = async (update = {}) => {
  props = { ...props, ...update };
  await act(async () => root.render(<PdfViewer {...props} />));
  await act(async () => vi.runOnlyPendingTimers());
};
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  shown.mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(getCachedDocument).mockReturnValue(loaded);
  host = document.createElement("div");
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = this.dataset.pageNumber
        ? Number(this.dataset.pageNumber) * 200 -
          (host.firstElementChild?.scrollTop ?? 0)
        : 0;
      return {
        top,
        bottom: top + 200,
        left: 0,
        right: 100,
        width: 100,
        height: 200,
      } as DOMRect;
    },
  );
  props = { data: bytes, artifactId: "a", scale: 1, onChangePageShown: shown };
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("applies a delayed change destination once even after scrolling, and rejects other artifacts", async () => {
  await render();
  host.firstElementChild!.scrollTop = 123;
  const target = { key: "change-a", artifactId: "a", page: 3 };
  await render({ changePageTarget: target });
  expect(host.firstElementChild!.scrollTop).toBe(584);
  expect(shown).toHaveBeenCalledTimes(1);
  host.firstElementChild!.scrollTop = 50;
  await render({ changePageTarget: { ...target } });
  expect(host.firstElementChild!.scrollTop).toBe(50);
  await render({ changePageTarget: { key: "b", artifactId: "b", page: 2 } });
  expect(shown).toHaveBeenCalledTimes(1);
});
it("waits for the matching PDF to load and for the viewer to become active", async () => {
  vi.mocked(getCachedDocument).mockReturnValue(null);
  let finish!: (value: typeof loaded) => void;
  vi.mocked(getOrOpenDocument).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render({
    isActive: false,
    changePageTarget: { key: "early", artifactId: "a", page: 2 },
  });
  expect(shown).not.toHaveBeenCalled();
  await act(async () => finish(loaded));
  await act(async () => vi.runOnlyPendingTimers());
  expect(shown).not.toHaveBeenCalled();
  await render({ isActive: true });
  expect(host.firstElementChild!.scrollTop).toBe(384);
  expect(shown).toHaveBeenCalledWith("early");
});

it("does not navigate old metadata when a new artifact reuses the same byte buffer", async () => {
  await render();
  vi.mocked(getCachedDocument).mockReturnValue(null);
  let finish!: (value: typeof loaded) => void;
  vi.mocked(getOrOpenDocument).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render({
    artifactId: "b",
    changePageTarget: { key: "new-b", artifactId: "b", page: 2 },
  });
  expect(shown).not.toHaveBeenCalled();
  await act(async () => finish({ ...loaded, docId: 2 }));
  await act(async () => vi.runOnlyPendingTimers());
  expect(shown).toHaveBeenCalledWith("new-b");
});

it("handles Ctrl+S within the PDF and navigates matches on unrendered pages", async () => {
  const box = { x: 10, y: 20, w: 30, h: 10 };
  searchPage.mockImplementation(async (_doc, page) => page ? [[box]] : []);
  const scroll = vi.fn();
  const oldScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  document.body.appendChild(host);
  const globalShortcut = vi.fn();
  window.addEventListener("keydown", globalShortcut);
  const key = async (target: Element, value: string, options: KeyboardEventInit = {}) =>
    act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value, ...options })); });
  try {
    await render();
    const viewer = host.firstElementChild!;
    await key(viewer, "s", { ctrlKey: true });
    expect(globalShortcut).not.toHaveBeenCalled();
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "paper");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(host.textContent).toContain("1 of 2");
    expect(host.querySelector('[data-page-number="2"] span')).toBeTruthy();
    await key(input, "Enter");
    expect(host.querySelector('[data-page-number="3"] span')).toBeTruthy();
    await key(input, "Enter", { shiftKey: true });
    expect(host.textContent).toContain("1 of 2");
    await key(input, "Escape");
    expect(host.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(viewer);
    expect(scroll).toHaveBeenCalled();
    await key(document.body, "s", { ctrlKey: true });
    expect(globalShortcut).toHaveBeenCalled();
  } finally {
    host.remove();
    window.removeEventListener("keydown", globalShortcut);
    HTMLElement.prototype.scrollIntoView = oldScroll;
  }
});
