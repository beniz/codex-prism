import { expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { latexLinter } from "codemirror-lang-latex";
import { scientificLatex } from "@/lib/syntax-theme";
import { lintProjectLatex } from "@/lib/latex-lint";

function check(content: string, fileId: string, root?: string) {
  const files = [
    { id: fileId, name: fileId, relativePath: fileId, type: "tex", content },
  ];
  if (root)
    files.push({
      id: "slides.tex",
      name: "slides.tex",
      relativePath: "slides.tex",
      type: "tex",
      content: root,
    });
  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [scientificLatex()],
    }),
  });
  try {
    expect(ensureSyntaxTree(view.state, content.length, 1000)).not.toBeNull();
    view.dispatch({}); // Publish the completed parser tree to editor state.
    return {
      before: latexLinter()(view),
      after: lintProjectLatex(view, fileId, files),
    };
  } finally {
    view.destroy();
  }
}
const root = String.raw`\documentclass{beamer}\begin{document}\input{part}\end{document}`;
const body = "Slide content. ".repeat(15);

it("reproduces the false document warning on a Beamer fragment and suppresses only that check", () => {
  const { before, after } = check(
    `\\begin{frame}{Example}\n${body}\n\\end{frame}`,
    "part.tex",
    root,
  );
  expect(
    before.some((d) => d.message.startsWith("Missing document environment")),
  ).toBe(true);
  expect(after).toEqual([]);
});
it("retains missing-document warnings for a malformed root", () => {
  const { after } = check(`\\documentclass{beamer}\n${body}`, "slides.tex");
  expect(
    after.some((d) => d.message.startsWith("Missing document environment")),
  ).toBe(true);
});
it("accepts a valid complete Beamer document", () => {
  const { after } = check(
    `\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Example}\n${body}\n\\end{frame}\n\\end{document}`,
    "slides.tex",
  );
  expect(after).toEqual([]);
});
it("keeps unmatched-environment diagnostics in included files", () => {
  const { after } = check(
    `\\begin{frame}\n${body}\n\\begin{itemize}\\item Example\n\\end{frame}`,
    "part.tex",
    root,
  );
  expect(after.some((d) => d.message === "Missing \\end{itemize}")).toBe(true);
  expect(
    after.some((d) => d.message.startsWith("Missing document environment")),
  ).toBe(false);
});

it("waits for the completed tree to be published, even when the parse context reports ready", () => {
  // The initial offscreen parse stops before this document environment.
  const content =
    "% preamble comment\n".repeat(2000) +
    String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{Example}Body\end{frame}
\end{document}`;
  const state = EditorState.create({
    doc: content,
    extensions: [scientificLatex()],
  });
  expect(ensureSyntaxTree(state, content.length, 1000)).not.toBeNull();
  const view = { state } as EditorView;
  expect(
    latexLinter()(view).some((d) =>
      d.message.startsWith("Missing document environment"),
    ),
  ).toBe(true);
  expect(
    lintProjectLatex(view, "slides.tex", [
      {
        id: "slides.tex",
        name: "slides.tex",
        relativePath: "slides.tex",
        type: "tex",
        content,
      },
    ]),
  ).toEqual([]);
});

it("does not mistake commented or escaped document wrappers for a real environment", () => {
  const { after } = check(
    String.raw`\documentclass{beamer}
% \begin{document}
\\begin{document}
` + body,
    "slides.tex",
  );
  expect(
    after.some((d) => d.message.startsWith("Missing document environment")),
  ).toBe(true);
});
