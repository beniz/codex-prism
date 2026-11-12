import { useSettingsStore } from "@/stores/settings-store";
import { invoke } from "@/lib/backend";
import {
  resolveTexRoot,
  useDocumentStore,
  type ProjectFile,
} from "@/stores/document-store";
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
    incremental: useSettingsStore.getState().incrementalCompilation,
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
  mainFile: string,
  pdf: ArrayBuffer,
  page: number,
  x: number,
  y: number,
): Promise<SynctexResult | null> {
  try {
    const hash = async (bytes: ArrayBuffer) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    const result = await invoke<
      (SynctexResult & { sourceRevision: string }) | null
    >("synctex_edit", {
      projectDir,
      mainFile,
      pdfRevision: await hash(pdf),
      page,
      x,
      y,
    });
    if (!result) return null;
    // The editor can contain unsaved changes or a newer accepted proposal.
    // Never apply an old source line to different text.
    const state = useDocumentStore.getState();
    const file = state.files.find((file) => file.relativePath === result.file);
    if (state.projectRoot !== projectDir || file?.content === undefined)
      return null;
    const content = file.content;
    if (
      (await hash(new TextEncoder().encode(content).buffer)) !==
      result.sourceRevision
    )
      return null;
    const current = useDocumentStore.getState();
    if (
      current.projectRoot !== projectDir ||
      current.files.find((f) => f.id === file.id)?.content !== content
    )
      return null;
    log.debug(`SyncTeX: page ${page} → ${result.file}:${result.line}`);
    return result;
  } catch (err) {
    log.debug("SyncTeX lookup failed", { page, error: String(err) });
    return null;
  }
}
