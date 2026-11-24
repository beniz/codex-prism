import { stripTexComments } from "./latex-project";

export interface IndexQuery {
  active: string;
  kind: "commands";
}
export interface IndexUpdate {
  query: IndexQuery;
  changed: { path: string; text: string }[];
  removed: string[];
}
export interface IndexResult {
  commands: [string, boolean][];
  packages: string[];
}

function parseTex(text: string) {
  const source = stripTexComments(
    text.replace(
      /\\begin\{(verbatim\*?|lstlisting|minted)\}[\s\S]*?(?:\\end\{\1\}|$)|\\verb\*?([^\w\s])[^\n]*?\2/g,
      "",
    ),
  );
  const commands = new Map<string, boolean>();
  for (const [name] of source.matchAll(/\\\\|\\[A-Za-z@]+/g))
    if (name !== "\\\\") commands.set(name, false);
  for (const m of source.matchAll(
    /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|(?:New|Renew|Provide|Declare)DocumentCommand|[egx]?def|let)\*?\s*\{?\s*(\\[A-Za-z@]+)/g,
  ))
    commands.set(m[1], true);
  const packages = new Set<string>();
  for (const m of source.matchAll(
    /\\(?:usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g,
  ))
    for (const name of m[1].split(",")) packages.add(name.trim());
  return { commands, packages, source };
}

export class LatexCompletionIndex {
  private sources = new Map<string, ReturnType<typeof parseTex>>();
  update({ changed, removed }: IndexUpdate): IndexResult {
    for (const path of removed) this.sources.delete(path);
    for (const { path, text } of changed)
      this.sources.set(path, parseTex(text));
    const commands = new Map<string, boolean>();
    const packages = new Set<string>();
    for (const source of this.sources.values()) {
      for (const [name, defined] of source.commands)
        commands.set(name, defined || !!commands.get(name));
      for (const name of source.packages) packages.add(name);
    }
    return { commands: [...commands], packages: [...packages] };
  }
}
