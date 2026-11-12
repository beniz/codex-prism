/** In-memory source information shared by compilation, linting and the outline. */
export interface TexSourceFile {
  id: string;
  name: string;
  relativePath: string;
  type: string;
  content?: string;
}

export function stripTexComments(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== "%") continue;
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) backslashes++;
        if (backslashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push(part);
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function directory(path: string): string {
  return path.replace(/\\/g, "/").replace(/[^/]*$/, "");
}

// Literal input/include paths only: macro expansion remains the compiler's job.
// Skip escaped backslashes, so examples such as \\input do not become includes.
export function texIncludes(source: string) {
  return [
    ...source.matchAll(
      /\\\\|\\(?:input|include)(?![A-Za-z@])\s*(?:\{([^{}\n]+)\}|([^\s{}%]+))/g,
    ),
  ].filter((match) => match[1] || match[2]);
}

export function texFileIndex(files: readonly TexSourceFile[]) {
  return new Map(
    files
      .filter((file) => file.type === "tex")
      .map((file) => [normalizePath(file.relativePath), file]),
  );
}

export function resolveTexInclude(
  path: string,
  root: TexSourceFile,
  index: Map<string, TexSourceFile>,
): TexSourceFile | undefined {
  const literal = path.trim();
  // Macro-expanded and absolute paths cannot be resolved from project sources.
  if (/[{}#$\\]/.test(literal) || /^(?:\/|[A-Za-z]:)/.test(literal))
    return undefined;
  const normalized = normalizePath(directory(root.relativePath) + literal);
  return index.get(normalized) ?? index.get(`${normalized}.tex`);
}

export function resolveTexRoot(
  fileId: string,
  files: readonly TexSourceFile[],
): string {
  const file = files.find((f) => f.id === fileId);
  if (!file || file.type !== "tex") return fileId;
  const index = texFileIndex(files);
  for (const line of (file.content ?? "").split("\n").slice(0, 20)) {
    const match = line.match(/^%\s*!TEX\s+root\s*=\s*(.+)/i);
    if (!match) continue;
    const path = match[1].trim();
    const target =
      index.get(normalizePath(directory(file.relativePath) + path)) ??
      index.get(normalizePath(path));
    if (target) return target.id;
  }
  const activeSource = stripTexComments(file.content ?? "");
  if (/\\documentclass[\s{[]/.test(activeSource)) return fileId;
  const sources = new Map(
    files
      .filter((f) => f.type === "tex")
      .map((f) => [
        f.id,
        f.id === fileId ? activeSource : stripTexComments(f.content ?? ""),
      ]),
  );
  const roots = files.filter((f) =>
    /\\documentclass[\s{[]/.test(sources.get(f.id) ?? ""),
  );
  const preferred = roots.filter(
    (root) => root.name === "main.tex" || root.name === "document.tex",
  );
  const candidates = [
    ...preferred,
    ...roots.filter((root) => !preferred.includes(root)),
  ];
  // Prefer a document that actually includes this fragment over unrelated
  // standalone figures or another document in the same project.
  for (const root of candidates) {
    const pending = [root];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      for (const match of texIncludes(sources.get(current.id) ?? "")) {
        const child = resolveTexInclude(match[1] ?? match[2], root, index);
        if (child?.id === fileId) return root.id;
        if (child && !visited.has(child.id)) pending.push(child);
      }
    }
  }
  return candidates[0]?.id ?? fileId;
}
