import { expect, it } from "vitest";
import { LatexCompletionIndex } from "@/lib/latex-completion-index";

it("indexes project definitions, packages and uses, and forgets removed files", () => {
  const index = new LatexCompletionIndex();
  const query = { active: "paper.tex", kind: "commands" } as const;
  const first = index.update({
    query,
    removed: [],
    changed: [
      {
        path: "paper.tex",
        text: String.raw`\usepackage{amsmath, graphicx}
\external % \ignored
\verb|\ignored|
\begin{verbatim}\ignored\end{verbatim}`,
      },
      {
        path: "custom.cls",
        text: String.raw`\NewDocumentCommand{\slide}{m}{#1}
\DeclareMathOperator*{\argmax}{argmax}\newcommand\custom{X}`,
      },
    ],
  });
  expect(first.packages).toEqual(["amsmath", "graphicx"]);
  for (const name of ["slide", "argmax", "custom"])
    expect(new Map(first.commands).get("\\" + name)).toBe(true);
  expect(new Map(first.commands).get("\\external")).toBe(false);
  expect(new Map(first.commands).has("\\ignored")).toBe(false);
  const next = index.update({ query, changed: [], removed: ["custom.cls"] });
  expect(new Map(next.commands).has("\\slide")).toBe(false);
});
