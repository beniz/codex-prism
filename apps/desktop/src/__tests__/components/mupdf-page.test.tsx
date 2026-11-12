import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MupdfPage } from "@/components/workspace/preview/mupdf-page";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
const queries: EventTarget[] = [];
const client = vi.hoisted(() => ({
  drawPage: vi.fn(),
  getPageText: vi.fn(async () => ({ blocks: [] })),
  getPageLinks: vi.fn(async () => []),
  peekPage: vi.fn(),
  promotePage: vi.fn(),
}));
vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: () => client }));
beforeEach(() => {
  vi.clearAllMocks();
  client.peekPage.mockReset();
  queries.length = 0;
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => {
      const query = new EventTarget();
      queries.push(query);
      return query;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("coalesces zoom renders, rejects obsolete results and releases offscreen canvases", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const bitmap = { close: vi.fn() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  const drawImage = vi.fn();
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ drawImage } as any);
  const replies: Array<(image: ImageData) => void> = [];
  client.drawPage.mockImplementation(
    () => new Promise((resolve) => replies.push(resolve)),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  let props = {
    docId: 1,
    pageIndex: 0,
    scale: 1,
    pageWidth: 595,
    pageHeight: 842,
    isVisible: true,
  };
  const render = async (update = {}) => {
    props = { ...props, ...update };
    await act(async () => root.render(<MupdfPage {...props} />));
  };
  try {
    await render();
    for (const scale of [2, 3, 4]) {
      await render({ scale });
      await act(async () => vi.advanceTimersByTime(300));
    }
    await act(async () => {
      vi.stubGlobal("devicePixelRatio", 2);
      queries[queries.length - 1].dispatchEvent(new Event("change"));
      window.dispatchEvent(new Event(APP_VISIBILITY_RESTORED));
    });
    const latest = replies.length - 1;
    expect(latest).toBeGreaterThan(0);
    for (const call of client.drawPage.mock.calls.slice(0, -1))
      expect(call[3].signal.aborted).toBe(true);
    await act(async () => {
      for (const reply of replies.slice(0, -1))
        reply({ width: 100, height: 200 } as ImageData);
    });
    expect(drawImage).not.toHaveBeenCalled();
    expect(client.drawPage).toHaveBeenLastCalledWith(
      1,
      0,
      4 * 72 * 2,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () =>
      replies[latest]({ width: 100, height: 200 } as ImageData),
    );
    expect(host.querySelector("canvas")!.width).toBe(100);
    expect(drawImage).toHaveBeenCalledTimes(1);
    await render({ isVisible: false });
    expect(host.querySelector("canvas")!.width).toBe(0);
    expect(host.querySelector("canvas")!.height).toBe(0);
    await render({ isVisible: true });
    expect(client.drawPage).toHaveBeenCalledTimes(latest + 2);
    await render({ isVisible: false });
    await act(async () =>
      replies[latest + 1]({ width: 100, height: 200 } as ImageData),
    );
    expect(host.querySelector("canvas")!.width).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    context.mockRestore();
  }
});

it.each([
  "density",
  "resize",
  "focus",
  "restore",
])("refreshes resolution on %s without changing PDF zoom", async (trigger) => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ close: vi.fn() })),
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as any);
  client.drawPage.mockResolvedValue({ width: 100, height: 200 });
  const root = createRoot(document.createElement("div"));
  const props = {
    docId: 1,
    pageIndex: 0,
    scale: 1,
    pageWidth: 595,
    pageHeight: 842,
    isVisible: true,
  };
  try {
    await act(async () => root.render(<MupdfPage {...props} />));
    expect(client.drawPage).toHaveBeenLastCalledWith(
      1,
      0,
      72,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => {
      vi.stubGlobal("devicePixelRatio", 2);
      if (trigger === "density")
        queries[queries.length - 1].dispatchEvent(new Event("change"));
      else
        window.dispatchEvent(
          new Event(trigger === "restore" ? APP_VISIBILITY_RESTORED : trigger),
        );
    });
    expect(client.drawPage).toHaveBeenCalledTimes(2);
    expect(client.drawPage).toHaveBeenLastCalledWith(
      1,
      0,
      144,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.getPageText).toHaveBeenCalledTimes(1);
    expect(client.getPageLinks).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.stubGlobal("devicePixelRatio", 1.5);
      queries[queries.length - 1].dispatchEvent(new Event("change"));
    });
    expect(client.drawPage).toHaveBeenLastCalledWith(
      1,
      0,
      108,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const count = client.drawPage.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(client.drawPage).toHaveBeenCalledTimes(count);
    await act(async () =>
      window.dispatchEvent(new Event(APP_VISIBILITY_RESTORED)),
    );
    expect(client.drawPage).toHaveBeenCalledTimes(count + 1);
    await act(async () =>
      root.render(<MupdfPage {...props} isVisible={false} />),
    );
    await act(async () =>
      window.dispatchEvent(new Event(APP_VISIBILITY_RESTORED)),
    );
    expect(client.drawPage).toHaveBeenCalledTimes(count + 1);
  } finally {
    await act(async () => root.unmount());
  }
});

it("closes a bitmap completed after unmount without painting it", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let finish!: (bitmap: ImageBitmap) => void;
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as any);
  client.drawPage.mockResolvedValue({ width: 100, height: 200 });
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <MupdfPage
        docId={1}
        pageIndex={0}
        scale={1}
        pageWidth={100}
        pageHeight={200}
        isVisible
      />,
    ),
  );
  await act(async () => root.unmount());
  await act(async () => finish(bitmap));
  expect(bitmap.close).toHaveBeenCalledTimes(1);
  expect(drawImage).not.toHaveBeenCalled();
});

it("restores cached pixels, promotes visible work and retains the canvas on rendering failure", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const image = { width: 100, height: 200 } as ImageData;
  client.peekPage.mockImplementation((doc, _page, dpi) =>
    doc === 1 && dpi === 72 ? image : undefined,
  );
  client.drawPage.mockRejectedValue(new Error("PDF worker unavailable"));
  const putImageData = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    putImageData,
  } as any);
  const host = document.createElement("div");
  const root = createRoot(host);
  const props = {
    docId: 1,
    pageIndex: 0,
    scale: 1,
    pageWidth: 100,
    pageHeight: 200,
    isVisible: true,
    ownerId: "chat-a",
  };
  try {
    await act(async () =>
      root.render(<MupdfPage {...props} priority="background" />),
    );
    expect(putImageData).toHaveBeenCalledWith(image, 0, 0);
    expect(client.drawPage).not.toHaveBeenCalled();
    await act(async () =>
      root.render(<MupdfPage {...props} priority="foreground" />),
    );
    expect(client.promotePage).toHaveBeenLastCalledWith(
      1,
      0,
      "chat-a",
      "foreground",
    );
    await act(async () =>
      root.render(<MupdfPage {...props} isVisible={false} />),
    );
    expect(host.querySelector("canvas")!.width).toBe(0);
    await act(async () => root.render(<MupdfPage {...props} />));
    expect(host.querySelector("canvas")!.width).toBe(100);
    expect(client.drawPage).not.toHaveBeenCalled();
    await act(async () => {
      vi.stubGlobal("devicePixelRatio", 2);
      window.dispatchEvent(new Event("resize"));
    });
    expect(client.drawPage).toHaveBeenLastCalledWith(
      1,
      0,
      144,
      expect.anything(),
    );
    expect(host.querySelector("canvas")!.width).toBe(100);
    expect(host.querySelector('[role="status"]')!.textContent).toContain(
      "PDF worker unavailable",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("never submits a new document at the preceding document's debounced zoom", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as any);
  client.drawPage.mockResolvedValue({ width: 100, height: 200 });
  const root = createRoot(document.createElement("div"));
  const props = {
    pageIndex: 0,
    pageWidth: 100,
    pageHeight: 200,
    isVisible: true,
  };
  try {
    await act(async () =>
      root.render(<MupdfPage {...props} docId={1} scale={1} />),
    );
    await act(async () =>
      root.render(<MupdfPage {...props} docId={2} scale={2} />),
    );
    expect(client.drawPage.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [1, 0, 72],
      [2, 0, 144],
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
