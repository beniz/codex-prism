import type { ReactNode } from "react";
import { highlightTree } from "@lezer/highlight";
import { bibtex } from "@/components/workspace/editor/lang-bibtex";
import { scientificHighlighter, scientificLatexLanguage } from "./syntax-theme";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import dos from "highlight.js/lib/languages/dos";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import diff from "highlight.js/lib/languages/diff";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";

// Explicit languages only: no guessing or loading every grammar for each streamed reply.
const lowlight = createLowlight({
  bash,
  powershell,
  dos,
  python,
  javascript,
  typescript,
  json,
  yaml,
  ini,
  diff,
  xml,
  css,
});
lowlight.registerAlias({
  bash: ["shell", "zsh"],
  javascript: ["jsx"],
  typescript: ["tsx"],
});
type HighlightNode = ReturnType<typeof lowlight.highlight>["children"][number];
function renderNode(node: HighlightNode, key: number): ReactNode {
  if (node.type === "text") return node.value;
  // Only text and highlighter spans are rendered. Code is never interpreted as HTML.
  if (node.type !== "element" || node.tagName !== "span") return null;
  const classes = node.properties.className;
  return (
    <span
      key={key}
      className={Array.isArray(classes) ? classes.join(" ") : undefined}
    >
      {node.children.map(renderNode)}
    </span>
  );
}

export function highlightChatCode(language: string, code: string): ReactNode {
  const name = language.toLowerCase();
  const parser = ["tex", "latex", "ltx"].includes(name)
    ? scientificLatexLanguage.parser
    : ["bib", "bibtex"].includes(name)
      ? bibtex().language.parser
      : undefined;
  if (parser) {
    const nodes: ReactNode[] = [];
    let end = 0;
    highlightTree(
      parser.parse(code),
      scientificHighlighter,
      (from, to, className) => {
        if (from > end) nodes.push(code.slice(end, from));
        nodes.push(
          <span key={from} className={className}>
            {code.slice(from, to)}
          </span>,
        );
        end = to;
      },
    );
    nodes.push(code.slice(end));
    return nodes;
  }
  return lowlight.registered(name)
    ? lowlight.highlight(name, code).children.map(renderNode)
    : code;
}
