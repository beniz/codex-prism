import { invoke } from "@/lib/backend";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("latex");

/** Resolve which file to compile and the root ID for caching.
 *  resolveTexRoot now handles \documentclass detection and main.tex fallback,
 *  so the only remaining fallback here is for projects with no .tex files.
 *  Returns `null` when the project has no compilable .tex file. */
export function resolveCompileTarget(
  activeFileId: string,
  files: ProjectFile[],
): { rootId: string; targetPath: string } | null {
  const rootId = resolveTexRoot(activeFileId, files);
  const rootEntry = files.find((f) => f.id === rootId);
  if (rootEntry?.type === "tex") {
    return { rootId, targetPath: rootEntry.relativePath };
  }
  // No .tex file exists — cannot compile
  const anyTex = files.find((f) => f.type === "tex");
  if (anyTex) {
    return { rootId: anyTex.id, targetPath: anyTex.relativePath };
  }
  return null;
}

/** Extract a human-readable error message from an unknown catch value. */
export function formatCompileError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Compilation failed";
}

export async function loadExistingPdf(
  projectDir: string,
  mainFile: string,
): Promise<Uint8Array | null> {
  const bytes = await invoke<number[] | null>("load_existing_pdf", {
    projectDir,
    mainFile,
  });
  return bytes === null ? null : new Uint8Array(bytes);
}

export async function compileLatex(
  projectDir: string,
  mainFile: string = "main.tex",
): Promise<Uint8Array> {
  log.info(`Compiling ${mainFile} (backend: texlive)`);
  const start = performance.now();
  // compile_latex returns raw PDF bytes via Tauri IPC Response
  const buffer = await invoke<ArrayBuffer>("compile_latex", {
    projectDir,
    mainFile,
  });

  const result = new Uint8Array(buffer);
  log.info(
    `Compiled ${mainFile} in ${(performance.now() - start).toFixed(0)}ms (${(result.byteLength / 1024).toFixed(0)} KB)`,
  );
  return result;
}

export interface TexliveStatus {
  available: boolean;
  engines: string[];
  version: string | null;
}

export async function detectTexlive(): Promise<TexliveStatus> {
  return invoke<TexliveStatus>("detect_texlive");
}

export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

export async function synctexEdit(
  projectDir: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexResult | null> {
  try {
    const result = await invoke<SynctexResult>("synctex_edit", {
      projectDir,
      page,
      x,
      y,
    });
    if (result)
      log.debug(`SyncTeX: page ${page} → ${result.file}:${result.line}`);
    return result;
  } catch (err) {
    log.debug("SyncTeX lookup failed", { page, error: String(err) });
    return null;
  }
}

export type TexEngine = "pdflatex" | "xelatex" | "lualatex";

/** Keep aligned with native detection: first directive in the first 20 lines. */
export function detectTexEngine(content: string): TexEngine {
  for (const line of content.split("\n").slice(0, 20)) {
    const match = line.match(/^\s*%\s*!TEX\s*program\s*=\s*(.*?)\s*$/);
    const engine = match?.[1].toLowerCase();
    if (engine === "pdflatex" || engine === "latex") return "pdflatex";
    if (engine === "xelatex" || engine === "lualatex") return engine;
    if (match) return "pdflatex";
  }
  return "pdflatex";
}
