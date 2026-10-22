import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LatexSetup } from "@/components/latex-setup";
import { detectTexlive } from "@/lib/latex-compiler";

vi.mock("@/lib/latex-compiler", () => ({ detectTexlive: vi.fn() }));

it.each([
  "xelatex",
  "lualatex",
])("explains how to use a %s-only installation", async (engine) => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(detectTexlive).mockResolvedValue({
    available: true,
    engines: [engine],
    version: null,
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<LatexSetup />));
    expect(host.textContent).toContain("Default pdfLaTeX is unavailable");
    expect(host.textContent).toContain(`% !TEX program = ${engine}`);
    expect(host.textContent).toContain("BibTeX or Biber");
  } finally {
    await act(async () => root.unmount());
  }
});
