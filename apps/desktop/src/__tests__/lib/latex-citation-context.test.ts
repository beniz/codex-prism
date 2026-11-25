import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { referenceKeyContext } from "@/lib/latex-citation-context";

const context = (source: string) => {
  const pos = source.indexOf("|");
  return referenceKeyContext(
    new CompletionContext(
      EditorState.create({ doc: source.replace("|", "") }),
      pos,
      false,
    ),
  );
};
it.each([
  String.raw`\textcite*[see {also}][p. 4]{one, Sm|ith, three}`,
  String.raw`\parencites[see]{one}[note]{Sm|ith}`,
  String.raw`\citep{Sm|ith}`,
])("replaces only the current reference in %s", (source) => {
  const hit = context(source)!;
  expect(hit.term).toBe("Sm");
  expect(source.replace("|", "").slice(hit.from, hit.to)).toBe("Smith");
});
it.each([
  String.raw`\cite[Sm|ith]{a}`,
  String.raw`\textbf{Sm|ith}`,
  String.raw`\\cite{Sm|ith}`,
  String.raw`\cite{x}{Sm|ith}`,
])("rejects non-key positions %s", (source) =>
  expect(context(source)).toBeNull());

it.each([
  String.raw`\ref{|}`,
  String.raw`\eqref*{bal|ance}`,
])("opens label suggestions in %s", (source) =>
  expect(context(source)?.kind).toBe("labels"));
it.each([
  String.raw`\label{|}`,
  String.raw`\\eqref{|}`,
  String.raw`\ref{a}{|}`,
])("excludes non-reference contexts in %s", (source) =>
  expect(context(source)).toBeNull());
