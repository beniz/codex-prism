import { expect, it } from "vitest";
import { detectTexEngine } from "@/lib/latex-compiler";
it("defaults to pdfLaTeX and honors engine directives in the first 20 lines", () => {
  expect(detectTexEngine("\\documentclass{article}")).toBe("pdflatex");
  expect(detectTexEngine("%!TEX program=xelatex")).toBe("xelatex");
  expect(detectTexEngine(" % !TEX program = LuaLaTeX ")).toBe("lualatex");
  expect(detectTexEngine("% !TEX program = latex")).toBe("pdflatex");
  expect(detectTexEngine("\n".repeat(20) + "% !TEX program = xelatex")).toBe(
    "pdflatex",
  );
  expect(
    detectTexEngine("% !TEX program = unknown\n% !TEX program = xelatex"),
  ).toBe("pdflatex");
});
