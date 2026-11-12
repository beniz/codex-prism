import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { latexLinter } from "codemirror-lang-latex";
import {
  resolveTexRoot,
  stripTexComments,
  type TexSourceFile,
} from "./latex-project";

const documentLinter = latexLinter();
const fragmentLinter = latexLinter({ checkMissingDocumentEnv: false });

export function lintProjectLatex(
  view: EditorView,
  fileId: string,
  files: readonly TexSourceFile[],
) {
  // The parse context can finish before the completed tree is published to the
  // editor state. The upstream linter reads that published tree, not the context.
  if (
    !syntaxTreeAvailable(view.state, view.state.doc.length) ||
    syntaxTree(view.state).length < view.state.doc.length
  )
    return [];
  const isRoot = resolveTexRoot(fileId, files) === fileId;
  // A literal document wrapper is authoritative even when grammar recovery
  // fails to represent it as a DocumentEnvironment node (e.g. complex macros).
  const source = stripTexComments(view.state.doc.toString());
  const hasDocument = [
    ...source.matchAll(/\\\\|\\begin\s*\{\s*document\s*\}/g),
  ].some((match) => match[0] !== "\\\\");
  return (isRoot && !hasDocument ? documentLinter : fragmentLinter)(view);
}
