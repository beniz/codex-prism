import { resolveTexInclude, stripTexComments, texFileIndex, texIncludes, type TexSourceFile } from "./latex-project";

export interface TocItem {
  level: number;
  title: string;
  line: number;
  number: string | null;
}

// Source-based numbering for the open file; custom TeX counter macros and
// headings in other files are not evaluated here.
export function parseTableOfContents(content: string): TocItem[] {
  const levels = ["part", "chapter", "section", "subsection", "subsubsection"];
  const counters = [0, 0, 0, 0, 0];
  const lines = stripTexComments(content).split("\n");
  const hasChapters = lines.some((line) =>
    /\\chapter\*?\s*(?:\[[^\]]*\]\s*)?\{/.test(line),
  );
  const toc: TocItem[] = [];
  lines.forEach((line, index) => {
    const headings =
      /\\(part|chapter|section|subsection|subsubsection)(\*)?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;
    for (const match of line.matchAll(headings)) {
      const [, type, starred, title] = match;
      const level = levels.indexOf(type);
      let number: string | null = null;
      if (!starred) {
        counters[level]++;
        // Parts have their own counter and do not reset chapter/section counters.
        if (level > 0) counters.fill(0, level + 1);
        number =
          level === 0
            ? roman(counters[0])
            : counters.slice(hasChapters ? 1 : 2, level + 1).join(".");
      }
      toc.push({ level, title: title.trim(), line: index + 1, number });
    }
  });
  const frames = frameOutline(lines.join("\n"));
  for (const frame of frames) {
    const preceding = toc.filter((item) => item.line <= frame.line);
    const section = preceding[preceding.length - 1];
    if (section) frame.level = Math.max(2, section.level + 1);
  }
  return [...toc, ...frames].sort((a, b) => a.line - b.line);
}

function roman(value: number): string {
  let result = "";
  for (const [amount, symbol] of [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ] as const) {
    while (value >= amount) {
      result += symbol;
      value -= amount;
    }
  }
  return result;
}

// Read balanced TeX arguments without evaluating macros. Offsets stay aligned
// with the comment-stripped source so navigation retains the original line.
function argument(source: string, start: number, open: string, close: string) {
  let at = start;
  while (/\s/.test(source[at] ?? "") && at < source.length) at++;
  if (source[at] !== open) return null;
  const begin = ++at;
  let depth = 1;
  while (at < source.length) {
    if (source[at] === "\\") { at += 2; continue; }
    if (source[at] === open) depth++;
    if (source[at] === close) depth--;
    if (depth === 0) {
      return { text: source.slice(begin, at), end: at + 1 };
    }
    at++;
  }
  return null;
}

function frameOutline(source: string): TocItem[] {
  const result: TocItem[] = [];
  const document = /\\begin\s*\{document\}/.exec(source);
  const frames = /\\begin\s*\{frame\}|\\frame(?![A-Za-z])/g;
  frames.lastIndex = document ? document.index + document[0].length : 0;
  let match: RegExpExecArray | null;
  while ((match = frames.exec(source))) {
    let at = frames.lastIndex;
    // Beamer allows overlay specifications and frame options before the title.
    for (;;) {
      const option = argument(source, at, "<", ">") ?? argument(source, at, "[", "]");
      if (!option) break;
      at = option.end;
    }
    const first = argument(source, at, "{", "}");
    const environment = match[0].startsWith("\\begin");
    if (!environment && !/\\documentclass[^\n]*\{beamer\}|\\frametitle\b|\\titlepage\b/.test(source)) continue;
    const end = environment ? /\\end\s*\{frame\}/g : null;
    if (end) end.lastIndex = at;
    const ending = end?.exec(source);
    if (environment && !ending) break;
    if (!environment && !first) continue;
    const bodyStart = environment ? at : source.indexOf("{", at) + 1;
    const bodyEnd = environment ? ending!.index : first!.end - 1;
    const body = source.slice(bodyStart, bodyEnd);
    const explicit = /\\frametitle\*?\s*(?:\[[^\]]*\]\s*)?/.exec(body);
    const explicitTitle = explicit ? argument(body, explicit.index + explicit[0].length, "{", "}") : null;
    const raw = explicitTitle?.text ?? (environment ? first?.text : undefined);
    const title = raw?.replace(/\\(?:textbf|textit|emph|textrm|textsf|texttt)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\s+/g, " ").trim();
    const offset = explicitTitle ? bodyStart + explicit!.index : match.index;
    result.push({
      level: 2,
      title: title || (/\\titlepage\b/.test(body) ? "Title slide" : `Slide ${result.length + 1}`),
      line: source.slice(0, offset).split("\n").length,
      number: String(result.length + 1),
    });
    frames.lastIndex = environment ? ending!.index + ending![0].length : first!.end;
  }
  return result;
}

export interface ProjectTocItem extends TocItem {
  fileId: string;
}

/** Expand loaded literal includes in document order, preserving source locations.
 * No disk scans or TeX evaluation run on the editor's typing path.
 */
export function parseProjectTableOfContents(
  files: readonly TexSourceFile[],
  rootId: string,
): ProjectTocItem[] {
  const root = files.find((file) => file.id === rootId);
  if (!root || root.type !== "tex") return [];
  const index = texFileIndex(files);
  const lines: string[] = [];
  const locations: { fileId: string; line: number }[] = [];
  const ancestors = new Set<string>();
  // Bound malformed/cyclic or exponentially repeated includes while editing.
  let remaining = 1000;
  function expand(file: TexSourceFile) {
    if (ancestors.has(file.id) || remaining-- <= 0 || ancestors.size >= 100) return;
    ancestors.add(file.id);
    const source = stripTexComments(file.content ?? "");
    let sourceLine = 1;
    const append = (text: string) => {
      const pieces = text.split("\n");
      pieces.forEach((piece, offset) => {
        lines.push(piece);
        locations.push({ fileId: file.id, line: sourceLine + offset });
      });
      sourceLine += pieces.length - 1;
    };
    let at = 0;
    for (const match of texIncludes(source)) {
      append(source.slice(at, match.index));
      const child = resolveTexInclude(match[1] ?? match[2], root!, index);
      if (child) expand(child);
      sourceLine += match[0].split("\n").length - 1;
      at = match.index! + match[0].length;
    }
    append(source.slice(at));
    ancestors.delete(file.id);
  }
  expand(root);
  return parseTableOfContents(lines.join("\n")).map((item) => ({
    ...item,
    ...locations[item.line - 1],
  }));
}
