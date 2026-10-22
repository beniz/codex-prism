import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PdfExportButton } from "@/components/workspace/preview/pdf-export-button";
import { optimizePdf } from "@/lib/pdf-export";
import { save, openExternal } from "@/lib/backend/desktop-host";
import { writeFile } from "@tauri-apps/plugin-fs";
vi.mock("@/lib/pdf-export", () => ({
  optimizePdf: vi.fn(),
  pdfSize: (n: number) => `${n} bytes`,
}));
vi.mock("@/lib/backend/desktop-host", () => ({
  save: vi.fn(async () => "/tmp/export.pdf"),
  openExternal: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn(async () => {}) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
async function setup() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const data = new TextEncoder().encode("%PDF-original").buffer;
  await act(async () =>
    root.render(<PdfExportButton projectRoot="/paper" getPdf={() => data} />),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  const click = async (text: string) =>
    act(async () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>("[role=dialog] button"),
      )
        .find((b) => b.textContent === text)!
        .click(),
    );
  return {
    data,
    click,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
it("offers ebook export by default and writes the optimized bytes", async () => {
  const bytes = new TextEncoder().encode("%PDF-small");
  vi.mocked(optimizePdf).mockResolvedValue({ bytes, reduced: true });
  const { data, click, cleanup } = await setup();
  try {
    expect(
      document.querySelector<HTMLInputElement>('input[value="ebook"]')!.checked,
    ).toBe(true);
    await click("Export");
    expect(optimizePdf).toHaveBeenCalledWith("/paper", data);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringContaining("-ebook.pdf"),
      }),
    );
    expect(writeFile).toHaveBeenCalledWith("/tmp/export.pdf", bytes);
  } finally {
    await cleanup();
  }
});
it("shows optimizer failures and lets the user export the original", async () => {
  vi.mocked(optimizePdf).mockRejectedValue(
    new Error("Ghostscript is not installed"),
  );
  const { data, click, cleanup } = await setup();
  try {
    await click("Export");
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "Ghostscript is not installed",
    );
    expect(writeFile).not.toHaveBeenCalled();
    await click("Get Ghostscript");
    expect(openExternal).toHaveBeenCalledWith(
      "https://ghostscript.com/releases/gsdnld.html",
    );
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[value="original"]')!
        .click(),
    );
    await click("Export");
    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/export.pdf",
      new Uint8Array(data),
    );
    expect(optimizePdf).toHaveBeenCalledTimes(1);
  } finally {
    await cleanup();
  }
});
it("does not open a save dialog after cancelling pending optimization", async () => {
  let finish!: (value: Awaited<ReturnType<typeof optimizePdf>>) => void;
  vi.mocked(optimizePdf).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { click, cleanup } = await setup();
  try {
    await click("Export");
    await click("Cancel");
    await act(async () => finish({ bytes: new Uint8Array(5), reduced: true }));
    expect(save).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});
