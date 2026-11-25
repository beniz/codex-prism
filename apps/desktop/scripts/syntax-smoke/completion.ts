import {
  currentCompletions,
  setSelectedCompletion,
} from "@codemirror/autocomplete";
import { history, undo, indentMore } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { scientificLatex } from "../../src/lib/syntax-theme";
import { latexAutocomplete } from "../../src/lib/latex-autocomplete";
import { projectCompletionIndex } from "../../src/lib/latex-completion-project";
import { useDocumentStore } from "../../src/stores/document-store";
import { backend } from "../../src/lib/backend";

export async function checkCompletion() {
  const active = "main.tex";
  const oldRead = backend.files.read;
  const oldState = useDocumentStore.getState();
  const projectId = "completion-smoke";
  const file = (path: string, type: "tex" | "bib", content?: string) => ({
    id: path,
    relativePath: path,
    name: path,
    type,
    ref: { projectId, path },
    isDirty: false,
    content,
  });
  const prefix =
    "\\documentclass{article}\n\\input{part}\n\\addbibresource{refs.bib}\n";
  useDocumentStore.setState({
    activeFileId: active,
    files: [
      file(active, "tex", prefix),
      file("refs.bib", "bib"),
      file("part.tex", "tex", String.raw`\label{sec:intro}\label{balance}`),
      file("unrelated.bib", "bib"),
    ],
  });
  let reads = 0;
  backend.files.read = async (ref) => {
    if (ref.path !== "refs.bib") throw new Error("Read unrelated bibliography");
    reads++;
    return {
      bytes: [
        ...new TextEncoder().encode(
          "@article{Smith2026,title={A Useful Result},author={Ada Smith}}",
        ),
      ],
      revision: "1",
    };
  };
  const index = projectCompletionIndex();
  const view = new EditorView({
    doc: prefix,
    parent: document.body,
    extensions: [
      scientificLatex(),
      history(),
      keymap.of([{ key: "Tab", run: indentMore }]),
      latexAutocomplete(active, index.query),
    ],
  });
  function type(text: string) {
    view.dispatch(view.state.replaceSelection(text), {
      userEvent: "input.type",
    });
  }
  async function accept(label: string, key: string) {
    for (let i = 0; i < 100; i++) {
      const options = currentCompletions(view.state);
      const n = options.findIndex((c) => c.label === label);
      if (n >= 0 && view.dom.querySelector(".cm-tooltip-autocomplete")) {
        view.dispatch({ effects: setSelectedCompletion(n) });
        await new Promise((r) => setTimeout(r, 100));
        view.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      "Missing completion " + label + " in " + view.state.doc.toString(),
    );
  }
  try {
    view.focus();
    view.dispatch({ selection: { anchor: prefix.length } });
    type("\\footn");
    await accept("\\footnote", "Tab");
    if (
      view.state.doc.toString() !== prefix + "\\footnote{}" ||
      view.state.selection.main.head !== view.state.doc.length - 1
    )
      throw new Error("Footnote completion or cursor failed");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    type(" \\textci");
    await accept("\\textcite", "Enter");
    type("Useful");
    await accept("Smith2026", "Tab");
    if (
      !view.state.doc.toString().endsWith("\\textcite{Smith2026}") ||
      reads !== 1
    )
      throw new Error("Citation insertion or bibliography cache failed");
    if (!undo(view) || view.state.doc.toString().includes("Smith2026"))
      throw new Error("Cannot undo key insertion");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    type(" \\ref{sec");
    await accept("sec:intro", "Tab");
    type("} \\eqr");
    await accept("\\eqref", "Enter");
    await accept("balance", "Tab");
    if (
      !view.state.doc.toString().endsWith("\\ref{sec:intro} \\eqref{balance}")
    )
      throw new Error("Label completion lost the key or closing brace");
  } finally {
    view.destroy();
    index.destroy();
    backend.files.read = oldRead;
    useDocumentStore.setState(oldState);
  }
}
