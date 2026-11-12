import { describe, expect, it } from "vitest";
import { resolveTexRoot, type TexSourceFile } from "@/lib/latex-project";
import { parseProjectTableOfContents } from "@/lib/latex-outline";

function tex(relativePath: string, content: string): TexSourceFile {
  return {
    id: relativePath,
    name: relativePath.split(/[/\\]/).pop()!,
    relativePath,
    type: "tex",
    content,
  };
}

const deck = [
  tex(
    "figures/standalone.tex",
    String.raw`\documentclass{standalone}\begin{document}Figure\end{document}`,
  ),
  tex(
    "slides.tex",
    String.raw`\documentclass{beamer}
\begin{document}
\section{Introduction}
\input{sections/intro}
\section{Results}
\include{sections/results}
\begin{frame}{Closing}\end{frame}
\end{document}`,
  ),
  tex(
    "sections/intro.tex",
    String.raw`% introductory slides
\begin{frame}{First}\end{frame}
\input{sections/nested}`,
  ),
  tex("sections/nested.tex", String.raw`\frame{\frametitle{Nested}Body}`),
  tex(
    "sections/results.tex",
    String.raw`\begin{frame}{Last result}\end{frame}`,
  ),
  tex("unused.tex", String.raw`\begin{frame}{Unused}\end{frame}`),
];

describe("project TeX root", () => {
  it("finds the owning deck before an unrelated standalone figure", () => {
    expect(resolveTexRoot("sections/intro.tex", deck)).toBe("slides.tex");
    expect(resolveTexRoot("sections/nested.tex", deck)).toBe("slides.tex");
    expect(resolveTexRoot("figures/standalone.tex", deck)).toBe(
      "figures/standalone.tex",
    );
  });
  it("resolves parent-relative magic comments and Windows separators", () => {
    const files = [
      ...deck,
      tex("sections\\magic.tex", "% !TEX root = ../slides.tex\n"),
    ];
    expect(resolveTexRoot("sections\\magic.tex", files)).toBe("slides.tex");
  });
  it("ignores commented document classes and finds owners of empty included files", () => {
    const files = [
      tex("main.tex", "% \\documentclass{article}"),
      tex("deck.tex", "\\documentclass{beamer}\n\\input{empty}"),
      tex("empty.tex", ""),
    ];
    expect(resolveTexRoot("empty.tex", files)).toBe("deck.tex");
  });
});

describe("project outline", () => {
  it("includes the whole deck in source order with continuous numbering and original locations", () => {
    expect(parseProjectTableOfContents(deck, "slides.tex")).toEqual([
      {
        title: "Introduction",
        number: "1",
        level: 2,
        fileId: "slides.tex",
        line: 3,
      },
      {
        title: "First",
        number: "1",
        level: 3,
        fileId: "sections/intro.tex",
        line: 2,
      },
      {
        title: "Nested",
        number: "2",
        level: 3,
        fileId: "sections/nested.tex",
        line: 1,
      },
      {
        title: "Results",
        number: "2",
        level: 2,
        fileId: "slides.tex",
        line: 5,
      },
      {
        title: "Last result",
        number: "3",
        level: 3,
        fileId: "sections/results.tex",
        line: 1,
      },
      {
        title: "Closing",
        number: "4",
        level: 3,
        fileId: "slides.tex",
        line: 7,
      },
    ]);
  });
  it("handles repeated, cyclic, missing, commented, escaped and unbraced includes", () => {
    const files = [
      tex(
        "main.tex",
        String.raw`\documentclass{beamer}
\begin{document}
% \input{unused}
\\input{unused}
\input{missing}
\includeonly{unused}
\input{\unknown}
\input{part}\input part.tex
\end{document}`,
      ),
      tex(
        "part.tex",
        String.raw`\begin{frame}{Repeated}\end{frame}
\input{main}`,
      ),
      deck[5],
    ];
    expect(
      parseProjectTableOfContents(files, "main.tex").map((item) => [
        item.title,
        item.number,
        item.line,
      ]),
    ).toEqual([
      ["Repeated", "1", 1],
      ["Repeated", "2", 1],
    ]);
  });
  it("resolves literal paths relative to the root document, including spaces and mixed separators", () => {
    const files = [
      tex(
        "talk\\slides.tex",
        String.raw`\documentclass{beamer}
\begin{document}
\input{./parts/first slide}
\end{document}`,
      ),
      tex(
        "talk/parts/first slide.tex",
        String.raw`\section{First}\input{parts/second}`,
      ),
      tex(
        "talk/parts/second.tex",
        String.raw`\begin{frame}{Second}\end{frame}`,
      ),
    ];
    expect(
      parseProjectTableOfContents(files, files[0].id).map(
        (item) => item.fileId,
      ),
    ).toEqual(["talk/parts/first slide.tex", "talk/parts/second.tex"]);
  });
  it("uses edited in-memory contents and updates heading counters across includes", () => {
    const files = [
      tex(
        "main.tex",
        "\\documentclass{article}\n\\section{First}\n\\input{part}\n\\section{Third}",
      ),
      tex("part.tex", "\\section{Edited}"),
    ];
    expect(
      parseProjectTableOfContents(files, "main.tex").map((item) => [
        item.title,
        item.number,
      ]),
    ).toEqual([
      ["First", "1"],
      ["Edited", "2"],
      ["Third", "3"],
    ]);
  });
});

it("expands multiline include commands without losing later source line numbers", () => {
  const files = [
    tex(
      "main.tex",
      String.raw`\documentclass{article}
\input
{part}
\section{After}`,
    ),
    tex("part.tex", String.raw`\section{Included}`),
  ];
  expect(
    parseProjectTableOfContents(files, "main.tex").map((item) => [
      item.title,
      item.fileId,
      item.line,
    ]),
  ).toEqual([
    ["Included", "part.tex", 1],
    ["After", "main.tex", 4],
  ]);
});
