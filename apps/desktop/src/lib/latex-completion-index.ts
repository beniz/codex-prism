import { bibliographyEntries, type BibEntry } from "./bib-completion";
import {
  type TexSourceFile,
  normalizePath,
  resolveTexInclude,
  resolveTexRoot,
  texFileIndex,
  texIncludes,
} from "./latex-project";

export type IndexQuery = { active: string } & (
  | { kind: "commands" | "labels" }
  | { kind: "citations"; term: string }
);
export interface IndexUpdate {
  query: IndexQuery;
  bibPaths?: string[];
  changed: { path: string; text: string }[];
  removed: string[];
}
export interface IndexResult {
  commands: [string, number | null][]; // null means observed use; a number means a definition.
  packages: string[];
  labels?: { key: string; paths: string[] }[];
  bibliographies?: string[];
  citations?: { key: string; metadata: string; paths: string[] }[];
}

function parseTex(text: string) {
  // Match escapes and comments before looking for verbatim environments.
  const source = text.replace(
    /\\\\|\\%|%[^\n]*|\\begin\{(verbatim\*?|lstlisting|minted)\}[\s\S]*?(?:\\end\{\1\}|$)|\\verb\*?([^\w\s])[^\n]*?\2/g,
    (value) => (value === "\\\\" || value === "\\%" ? value : " "),
  );
  const commands = new Map<string, number | null>();
  for (const [name] of source.matchAll(/\\\\|\\[A-Za-z@]+/g))
    if (name !== "\\\\") commands.set(name, null);
  for (const m of source.matchAll(
    /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|(?:New|Renew|Provide|Declare)DocumentCommand|[egx]?def|let)\*?\s*\{?\s*(\\[A-Za-z@]+)\s*\}?/g,
  )) {
    let args = 0;
    const signature = source.slice(
      m.index! + m[0].length,
      m.index! + m[0].length + 128,
    );
    if (m[1].endsWith("DocumentCommand")) {
      const simple = /^\s*\{([mos+\s]*)\}/.exec(signature);
      if (simple) args = simple[1].split("m").length - 1;
    } else if (/command|RobustCommand/.test(m[1])) {
      const simple = /^\s*\[(\d)\]\s*(\[)?/.exec(signature);
      if (simple) args = Math.max(0, Number(simple[1]) - Number(!!simple[2]));
    }
    commands.set(m[2], args);
  }
  const packages = new Set<string>();
  for (const m of source.matchAll(
    /\\(?:usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g,
  ))
    for (const name of m[1].split(",")) packages.add(name.trim());
  const resources = [
    ...source.matchAll(
      /\\(?:addbibresource|bibliography)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g,
    ),
  ].flatMap((m) => m[1].split(",").map((s) => s.trim()));
  // The shared root resolver only needs directives, even in a long source file.
  const includes = texIncludes(source);
  const directives = [
    ...text.split("\n", 20).filter((line) => /^%\s*!TEX\s+root/i.test(line)),
    source.match(/\\documentclass[\s{[]/)?.[0] ?? "",
    ...includes.map((m) => m[0]),
  ].join("\n");
  const labels = new Set<string>();
  for (const m of source.matchAll(/\\\\|\\label\s*\{\s*([^{}\s\\%#]+)\s*\}/g))
    if (m[1]) labels.add(m[1]);
  return {
    labels,
    commands,
    packages,
    resources,
    directives,
    includes: includes.map((m) => m[1] ?? m[2]),
  };
}

export class LatexCompletionIndex {
  private sources = new Map<string, ReturnType<typeof parseTex>>();
  private bib = new Map<string, BibEntry[]>();
  private merged?: {
    paths: string[];
    entries: (BibEntry & { lowerKey: string; paths: string[] })[];
  };
  private references(paths: string[]) {
    if (
      this.merged &&
      this.merged.paths.length === paths.length &&
      paths.every((p, i) => p === this.merged!.paths[i])
    )
      return this.merged.entries;
    const keys = new Map<
      string,
      BibEntry & { lowerKey: string; paths: string[] }
    >();
    for (const path of paths)
      for (const entry of this.bib.get(path) ?? []) {
        const prior = keys.get(entry.key);
        if (prior) {
          if (!prior.paths.includes(path)) prior.paths.push(path);
          prior.search += " " + entry.search;
        } else
          keys.set(entry.key, {
            ...entry,
            lowerKey: entry.key.toLowerCase(),
            paths: [path],
          });
      }
    const entries = [...keys.values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    this.merged = { paths, entries };
    return entries;
  }
  private documentSources(active: string) {
    const files = [...this.sources]
      .filter(([path]) => /\.tex$/i.test(path))
      .map(([path, data]) => ({
        id: path,
        name: path.split("/").pop()!,
        relativePath: path,
        type: "tex",
        content: data.directives,
      }));
    const index = texFileIndex(files);
    const resolveRoot = resolveTexRoot(active, files);
    const root = files.find((f) => f.id === resolveRoot);
    if (!root) return { root: active, paths: [active] };
    const pending: TexSourceFile[] = [root];
    const seen = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!;
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      const source = this.sources.get(file.id)!;
      for (const include of source.includes) {
        const child = resolveTexInclude(include, root, index);
        if (child) pending.push(child);
      }
    }
    return { root: root.relativePath, paths: [...seen] };
  }
  private resources(active: string, available: string[]) {
    const { root, paths } = this.documentSources(active);
    const result = new Set<string>();
    const byPath = new Map(
      available.map((path) => [normalizePath(path), path]),
    );
    for (const path of paths) {
      const source = this.sources.get(path);
      if (!source) continue;
      for (const name of source.resources) {
        if (!name || /[{}#$\\:]/.test(name) || name.startsWith("/")) continue;
        const literal = /\.bib$/i.test(name) ? name : name + ".bib";
        for (const base of [root, path]) {
          const found = byPath.get(
            normalizePath(base.replace(/[^/\\]*$/, "") + literal),
          );
          if (found) {
            result.add(found);
            break;
          }
        }
      }
    }
    return result.size ? [...result] : available;
  }
  update({ query, changed, removed, bibPaths = [] }: IndexUpdate): IndexResult {
    for (const path of removed) {
      this.sources.delete(path);
      if (this.bib.delete(path)) this.merged = undefined;
    }
    for (const { path, text } of changed) {
      if (/\.bib$/i.test(path)) {
        this.bib.set(path, bibliographyEntries(text));
        this.merged = undefined;
      } else this.sources.set(path, parseTex(text));
    }
    if (query.kind === "labels") {
      const { paths } = this.documentSources(query.active);
      const labels = new Map<string, string[]>();
      for (const path of paths) {
        for (const key of this.sources.get(path)?.labels ?? []) {
          const existing = labels.get(key);
          if (existing) existing.push(path);
          else labels.set(key, [path]);
        }
      }
      return {
        commands: [],
        packages: [],
        labels: Array.from(labels, ([key, paths]) => ({ key, paths })),
      };
    }
    if (query.kind === "citations") {
      const paths = this.resources(query.active, bibPaths);
      const entries = this.references(paths);
      const buckets = Array.from({ length: 4 }, () => [] as typeof entries);
      const term = query.term.toLowerCase().trim();
      for (const entry of entries) {
        const key = entry.lowerKey;
        const rank =
          key === term
            ? 0
            : key.startsWith(term)
              ? 1
              : key.includes(term)
                ? 2
                : entry.search.includes(term)
                  ? 3
                  : 4;
        if (rank < 4 && buckets[rank].length < 100) buckets[rank].push(entry);
        if (!term && buckets[1].length === 100) break;
      }
      const citations = buckets
        .flat()
        .slice(0, 100)
        .map(({ key, metadata, paths }) => ({ key, metadata, paths }));
      return { commands: [], packages: [], bibliographies: paths, citations };
    }
    const commands = new Map<string, number | null>();
    const packages = new Set<string>();
    for (const source of this.sources.values()) {
      for (const [name, args] of source.commands) {
        const prior = commands.get(name);
        if (prior == null) commands.set(name, args);
        else if (args !== null && args !== prior) commands.set(name, 0);
      }
    }
    for (const path of this.documentSources(query.active).paths) {
      for (const name of this.sources.get(path)?.packages ?? [])
        packages.add(name);
    }
    return { commands: [...commands], packages: [...packages] };
  }
}
