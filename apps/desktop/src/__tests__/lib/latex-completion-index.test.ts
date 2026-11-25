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
  expect(new Map(first.commands).get("\\slide")).toBe(1);
  for (const name of ["argmax", "custom"])
    expect(new Map(first.commands).get(`\\${name}`)).toBe(0);
  expect(new Map(first.commands).get("\\external")).toBeNull();
  expect(new Map(first.commands).has("\\ignored")).toBe(false);
  const next = index.update({ query, changed: [], removed: ["custom.cls"] });
  expect(new Map(next.commands).has("\\slide")).toBe(false);
});

it("resolves the included document’s multiple bibliography resources and ranks keys before metadata", () => {
  const index = new LatexCompletionIndex();
  const query = {
    active: "book/intro.tex",
    kind: "citations",
    term: "smith",
  } as const;
  const bibPaths = ["book/a.bib", "book/b.bib", "other.bib"];
  const result = index.update({
    query,
    bibPaths,
    removed: [],
    changed: [
      {
        path: "other.tex",
        text: "\\documentclass{article}\\bibliography{other}",
      },
      { path: "book/main.tex", text: "\\documentclass{book}\\input{intro}" },
      {
        path: "book/intro.tex",
        text: "\\addbibresource[location=local]{a.bib}\n\\bibliography{b,missing}",
      },
      {
        path: bibPaths[0],
        text: '@book{smithKey, title={An {Inner} Title}, year=2025}\n@article(other, author="Smith", title={B})',
      },
      { path: bibPaths[1], text: "@article{smithKey,year=2026}" },
      { path: bibPaths[2], text: "@book{smithWrong,title={Unrelated}}" },
    ],
  });
  expect(result.citations?.map((c) => c.key)).toEqual(["smithKey", "other"]);
  expect(result.citations?.[0]).toEqual({
    key: "smithKey",
    metadata: "2025 · An Inner Title",
    paths: bibPaths.slice(0, 2),
  });
  expect(
    index.update({
      query: { ...query, term: "inner" },
      bibPaths,
      removed: [],
      changed: [],
    }).citations?.[0]?.key,
  ).toBe("smithKey");
  const next = index.update({
    query,
    bibPaths: [bibPaths[0], bibPaths[2]],
    removed: [bibPaths[1]],
    changed: [
      { path: "book/intro.tex", text: "\\bibliography{missing}" },
      { path: bibPaths[0], text: '@book{newSmith,title="Updated"}' },
    ],
  });
  expect(next.citations?.map((c) => c.key)).toEqual(["smithWrong", "newSmith"]);
});

it("skips nonentries and recovers at a valid entry after malformed text", () => {
  const index = new LatexCompletionIndex();
  const refs = index.update({
    query: { kind: "citations", active: "main.tex", term: "" },
    bibPaths: ["refs.bib"],
    removed: [],
    changed: [
      {
        path: "refs.bib",
        text: '@comment{ @book{fake,year=1900} }\n@string{jn="Journal"}\n@article{broken,title={unclosed\n@book{valid,year=2000,title="New {Results}"}',
      },
    ],
  });
  expect(refs.citations?.map((c) => c.key)).toEqual(["valid"]);
});

it("completes literal labels across the active document and refreshes edited definitions", () => {
  const index = new LatexCompletionIndex();
  const query = { active: "part.tex", kind: "labels" } as const;
  const result = index.update({
    query,
    removed: [],
    changed: [
      {
        path: "main.tex",
        text: String.raw`\documentclass{article}\input{part}\label{sec:intro}`,
      },
      {
        path: "part.tex",
        text: String.raw`\label{energy}\label{sec:intro}
% \label{comment}
\verb|\label{literal}| \\label{escaped} \label{#1}
\begin{verbatim}\label{example}\end{verbatim}`,
      },
      {
        path: "other.tex",
        text: String.raw`\documentclass{book}\label{other}`,
      },
    ],
  });
  expect(result.labels).toEqual([
    { key: "sec:intro", paths: ["main.tex", "part.tex"] },
    { key: "energy", paths: ["part.tex"] },
  ]);
  expect(
    index
      .update({
        query,
        changed: [{ path: "part.tex", text: "\\label{new}" }],
        removed: [],
      })
      .labels?.map((l) => l.key),
  ).toEqual(["sec:intro", "new"]);
});
