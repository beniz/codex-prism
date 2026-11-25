import type { CompletionContext } from "@codemirror/autocomplete";

// Locate a literal key list, skipping complete optional notes and, for
// biblatex multicites, earlier key groups. Never consume a following key.
export const biblatexCitations =
  "cite Cite cites Cites textcite Textcite textcites Textcites parencite Parencite parencites Parencites autocite Autocite autocites Autocites footcite footcites footcitetext fullcite footfullcite smartcite smartcites supercite supercites citeauthor Citeauthor citeyear citetitle citedate citeurl";
export const natbibCitations =
  "citet citep citealt citealp citeauthor citeyear citeyearpar citenum Citet Citep Citealt Citealp Citeauthor citetalias citepalias";
const citeNames = new Set(
  (
    biblatexCitations +
    " " +
    natbibCitations +
    " nocite citefield citelist citename defcitealias bibentry"
  ).split(" "),
);
export function referenceKeyContext(context: CompletionContext) {
  const offset = Math.max(0, context.pos - 8192);
  const before = context.state.sliceDoc(offset, context.pos);
  const open = before.lastIndexOf("{");
  if (open < 0) return null;
  const list = before.slice(open + 1);
  if (/[{}\\%]/.test(list)) return null;
  let i = open;
  let earlierKey = false;
  for (;;) {
    while (i && /\s/.test(before[i - 1])) i--;
    const end = before[i - 1];
    if (end !== "]" && end !== "}") break;
    if (end === "}") earlierKey = true;
    const start = end === "]" ? "[" : "{";
    let depth = 1;
    for (i--; i && depth; ) {
      const c = before[--i];
      if (before[i - 1] === "\\") continue;
      if (c === end) depth++;
      if (c === start) depth--;
    }
    if (depth) return null;
  }
  const name = before.slice(0, i).match(/\\([A-Za-z]+)\*?$/);
  if (!name) return null;
  const label = name[1] === "ref" || name[1] === "eqref";
  if (
    label
      ? before.slice(i, open).trim() !== ""
      : !citeNames.has(name[1]) || (earlierKey && !name[1].endsWith("s"))
  )
    return null;
  const slashes = before.slice(0, name.index).match(/\\+$/)?.[0].length ?? 0;
  if (slashes % 2) return null;
  const term = (
    label ? list : list.slice(list.lastIndexOf(",") + 1)
  ).trimStart();
  const after = context.state.doc.lineAt(context.pos);
  const rest = after.text.slice(context.pos - after.from);
  return {
    kind: label ? ("labels" as const) : ("citations" as const),
    term,
    from: context.pos - term.length,
    to:
      context.pos +
      (label ? /^[^{}\s%\\]*/ : /^[^,{}\s%\\]*/).exec(rest)![0].length,
  };
}
