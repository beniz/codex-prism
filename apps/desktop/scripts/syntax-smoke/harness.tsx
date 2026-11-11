import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import {
  scientificEditorTheme,
  scientificLatexLanguage,
} from "../../src/lib/syntax-theme";
import { Message } from "../../src/components/agent-chat/chat-message";
import { ActivityLabel } from "../../src/components/agent-chat/activity-label";
import type { ChatItem } from "../../src/stores/agent-chat-store";
import "../../src/styles/globals.css";

const source = String.raw`% Keep the narrative clear and concise.
\documentclass{beamer}
\usepackage{graphicx}
\begin{document}
\section{Results}
\begin{frame}{Sensitivity analysis}
We compare \cite{smith2026} with our results.
\includegraphics{figures/sensitivity.pdf}
\[ f(x) = \alpha x^2 + 42 \]
\end{frame}
\end{document}`;
const activities: ChatItem[] = [
  {
    id: "progress",
    type: "agentMessage",
    phase: "commentary",
    text: "I’ll compare the source data with the plotted results.",
  },
  {
    id: "command",
    type: "commandExecution",
    text: "",
    status: "completed",
    activity: {
      command: 'python plot.py --input "measurements.csv"',
      exitCode: 0,
    },
  },
  {
    id: "image",
    type: "imageView",
    text: "",
    status: "completed",
    activity: { path: "figures/sensitivity.pdf" },
  },
  {
    id: "read",
    type: "fileRead",
    text: "",
    status: "completed",
    activity: { path: "data/measurements.csv" },
  },
  {
    id: "research",
    type: "webSearch",
    text: "",
    status: "inProgress",
    activity: {
      action: { queries: ["sensitivity analysis confidence intervals"] },
    },
  },
  {
    id: "failed",
    type: "commandExecution",
    text: "",
    status: "completed",
    activity: { command: "pdflatex main.tex", exitCode: 1 },
  },
];
const editors: { view: EditorView; theme: Compartment; dark: boolean }[] = [];
function Example({ dark }: { dark: boolean }) {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const theme = new Compartment();
    const view = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: source,
        selection: { anchor: 10 },
        extensions: [
          lineNumbers(),
          scientificLatexLanguage,
          theme.of(scientificEditorTheme(dark)),
          EditorView.theme({
            "&": { fontSize: "14px" },
            ".cm-content": { padding: "12px 0" },
          }),
        ],
      }),
    });
    const entry = { view, theme, dark };
    editors.push(entry);
    return () => {
      editors.splice(editors.indexOf(entry), 1);
      view.destroy();
    };
  }, [dark]);
  return (
    <section
      data-theme={dark ? "dark" : "light"}
      className={dark ? "dark" : ""}
    >
      <div className="min-h-screen bg-background p-6 text-foreground">
        <h1 className="mb-5 text-xl font-semibold">
          {dark ? "Dark" : "Light"} · scientific syntax
        </h1>
        <h2 className="mb-2 font-semibold">LaTeX editor</h2>
        <div ref={parent} className="mb-6 overflow-hidden rounded-lg border" />
        <h2 className="mb-2 font-semibold">Agent activities</h2>
        <div className="mb-6 space-y-3">
          {activities.map((item) => (
            <Message key={item.id} item={item} />
          ))}
          <div className="space-y-1 rounded border p-3 text-xs">
            <ActivityLabel kind="approval" label="Permission requested" />
            <p>Run the figure-generation script?</p>
          </div>
        </div>
        <h2 className="mb-2 font-semibold">Chat reply</h2>
        <Message
          item={{
            id: "example",
            type: "agentMessage",
            phase: "commentary",
            text:
              "The sources remain ordinary text. Inline `main.tex` is kept quiet.\n\n```latex\n" +
              source +
              '\n```\n\n```python\n# Evaluate the sensitivity curve\nimport numpy as np\nalpha = 0.75\nx = np.linspace(0, 10, 100)\nprint("Sensitivity:", alpha * x**2)\n```\n\n```diff\n-\\title{Draft results}\n+\\title{Sensitivity analysis}\n```',
          }}
        />
      </div>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <main className="grid grid-cols-2">
    <Example dark={false} />
    <Example dark />
  </main>,
);
(window as any).runSmoke = async () => {
  for (
    let i = 0;
    i < 100 && document.querySelectorAll(".hljs-built_in").length < 2;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (editors.length !== 2) throw new Error("Editors did not mount");
  for (const editor of editors) {
    const section = editor.view.dom.closest("section")!;
    const comment = section.querySelector(".cm-editor .syntax-comment")!;
    const before = getComputedStyle(comment).color;
    const selection = editor.view.state.selection.main.anchor;
    section.classList.toggle("dark", !editor.dark);
    editor.view.dispatch({
      effects: editor.theme.reconfigure(scientificEditorTheme(!editor.dark)),
    });
    if (getComputedStyle(comment).color === before)
      throw new Error("Theme switch did not recolour tokens");
    if (
      editor.view.state.doc.toString() !== source ||
      editor.view.state.selection.main.anchor !== selection
    )
      throw new Error("Theme switch changed editor contents or selection");
    section.classList.toggle("dark", editor.dark);
    editor.view.dispatch({
      effects: editor.theme.reconfigure(scientificEditorTheme(editor.dark)),
    });
    const kinds = [
      "command",
      "image",
      "read",
      "research",
      "progress",
      "approval",
    ];
    for (const kind of kinds) {
      const label = section.querySelector(`[data-activity-kind="${kind}"]`);
      if (!label?.querySelector("svg") || !label.textContent)
        throw new Error(`Missing ${kind} icon/label`);
    }
    const imageLabel = section.querySelector('[data-activity-kind="image"]')!;
    const imageRow = imageLabel.parentElement!;
    if (getComputedStyle(imageLabel).color === getComputedStyle(imageRow).color)
      throw new Error("Image label lacks an accent");
    const failed = section.querySelector(
      'details [data-activity-status="error"]',
    );
    if (failed?.textContent !== "Failed · exit 1")
      throw new Error("Command failure lost its error status");
    const chat = section.querySelector(".chat-code .syntax-comment")!;
    if (getComputedStyle(chat).color !== getComputedStyle(comment).color)
      throw new Error("Editor and chat colours disagree");
    if (section.querySelector(".chat-code")?.textContent !== `${source}\n`)
      throw new Error("Chat code changed source text");
    if (
      !section.querySelector(".hljs-addition") ||
      !section.querySelector(".hljs-number")
    )
      throw new Error("Missing code highlighting");
  }
  const commands = Array.from(
    document.querySelectorAll<HTMLDetailsElement>("details"),
  ).filter((_, index) => index % 2 === 0);
  for (const command of commands) command.open = true;
  for (
    let i = 0;
    i < 100 &&
    commands.some((command) => !command.querySelector(".hljs-string"));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (
    commands.some(
      (command) =>
        command.querySelector("code")?.textContent !==
        'python plot.py --input "measurements.csv"',
    )
  )
    throw new Error("Expanded command changed text");
  if (commands.some((command) => !command.querySelector(".hljs-string")))
    throw new Error("Expanded command is not highlighted");
  return {
    ok: true,
    steps:
      "light/dark editor and chat → matching colours → activity icons/statuses → expanded shell commands",
  };
};
