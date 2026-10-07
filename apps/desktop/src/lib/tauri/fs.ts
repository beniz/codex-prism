import { exists, readFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@/lib/backend";
import { backend, type Project, type FileRef } from "@/lib/backend";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("fs");

export type ProjectFileType =
  | "tex"
  | "image"
  | "pdf"
  | "bib"
  | "style"
  | "other";

export interface FsProjectFile {
  relativePath: string;
  ref: FileRef;
  type: ProjectFileType;
  fileSize: number;
}

/** Files larger than this (1 MB) are not auto-loaded into memory during project open. */
export const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".bmp",
  ".webp",
]);

const STYLE_EXTENSIONS = new Set([
  ".sty",
  ".cls",
  ".bst",
  ".def",
  ".cfg",
  ".fd",
  ".dtx",
  ".ins",
]);

const IGNORED_EXTENSIONS = new Set([
  // Ignore LaTeX build artifacts, but keep user-imported reference files visible.
  ".aux",
  ".log",
  ".out",
  ".toc",
  ".lof",
  ".lot",
  ".fls",
  ".fdb_latexmk",
  ".synctex.gz",
  ".synctex",
  ".blg",
  ".bbl",
  ".nav",
  ".snm",
  ".vrb",
  ".run.xml",
  ".bcf",
  // Compiled build artifacts (never user reference material)
  ".pyc",
  ".pyo",
  ".pyd",
  ".o",
  ".obj",
  ".so",
  ".dylib",
  ".dll",
]);

export function getProjectFileType(name: string): ProjectFileType | null {
  const lower = name.toLowerCase();
  // Skip ignored file extensions (build artifacts, binary/non-text files)
  for (const ext of IGNORED_EXTENSIONS) {
    if (lower.endsWith(ext)) return null;
  }
  if (lower.endsWith(".tex") || lower.endsWith(".ltx")) return "tex";
  if (lower.endsWith(".bib")) return "bib";
  if (lower.endsWith(".pdf")) return "pdf";
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return "image";
  }
  for (const ext of STYLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return "style";
  }
  // Show all other files (txt, md, sty downloaded packages, etc.)
  return "other";
}

export interface ScanResult {
  files: FsProjectFile[];
  folders: string[]; // relative paths of all directories
}

const projects = new Map<string, Project>();
const revisions = new Map<string, string | null>();
export async function registerProjectRoot(root: string) {
  const project = await backend.projects.register(root);
  for (const [key, value] of projects)
    if (value.id === project.id) projects.delete(key);
  projects.set(root.replace(/[\\/]+$/, ""), project);
  return project;
}
function refFor(path: string | FileRef): FileRef {
  if (typeof path !== "string") return path;
  const entries = [...projects.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [root, project] of entries) {
    if (
      path === root ||
      path.startsWith(root + "/") ||
      path.startsWith(root + "\\")
    )
      return {
        projectId: project.id,
        path: path
          .slice(root.length)
          .replace(/^[\\/]+/, "")
          .replace(/\\/g, "/"),
      };
  }
  throw new Error("File is not in a registered project");
}
export async function scanProjectFolder(rootPath: string): Promise<ScanResult> {
  const project = await registerProjectRoot(rootPath);
  const result = await backend.files.list(project.id);
  return {
    folders: result.folders,
    files: result.files.flatMap((f) => {
      const type = getProjectFileType(f.path);
      return type
        ? [
            {
              relativePath: f.path,
              ref: { projectId: project.id, path: f.path },
              type,
              fileSize: f.size,
            },
          ]
        : [];
    }),
  };
}
function revisionKey(ref: FileRef) {
  return `${ref.projectId}:${ref.path}`;
}
export async function readProjectBytes(
  path: string | FileRef,
): Promise<Uint8Array> {
  const ref = refFor(path);
  const file = await backend.files.read(ref);
  revisions.set(revisionKey(ref), file.revision);
  return new Uint8Array(file.bytes);
}
export async function writeProjectBytes(
  path: string | FileRef,
  bytes: Uint8Array,
): Promise<void> {
  const ref = refFor(path),
    key = revisionKey(ref);
  if (!revisions.has(key)) throw new Error("Read the file before updating it");
  const revision = await backend.files.write(
    ref,
    [...bytes],
    revisions.get(key)!,
  );
  revisions.set(key, revision);
}
export async function readTexFileContent(
  path: string | FileRef,
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readProjectBytes(path),
  );
}
export async function writeTexFileContent(
  path: string | FileRef,
  content: string,
): Promise<void> {
  await writeProjectBytes(path, new TextEncoder().encode(content));
}
export async function readImageAsDataUrl(
  absolutePath: string | FileRef,
): Promise<string> {
  const data = await readProjectBytes(absolutePath);
  const ext =
    refFor(absolutePath).path.split(".").pop()?.toLowerCase() || "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    webp: "image/webp",
  };
  const mime = mimeMap[ext] || "image/png";

  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

export function getAssetUrl(ref: FileRef): string {
  const project = [...projects.values()].find((p) => p.id === ref.projectId);
  if (!project) throw new Error("Unknown project");
  return convertFileSrc(`${project.root}/${ref.path}`);
}

export async function createFileOnDisk(
  rootPath: string,
  name: string,
  content: string,
): Promise<FileRef> {
  const fullPath = await join(rootPath, name);
  const ref = refFor(fullPath);
  const revision = await backend.files.write(
    ref,
    [...new TextEncoder().encode(content)],
    null,
  );
  revisions.set(revisionKey(ref), revision);
  return ref;
}

/**
 * Generate a unique filename by appending (1), (2), etc. if the target already exists.
 * Returns the deduplicated relative path (e.g., "attachments/paper (1).pdf").
 */
export async function getUniqueTargetName(
  rootPath: string,
  targetName: string,
): Promise<string> {
  const fullPath = await join(rootPath, targetName);
  if (!(await exists(fullPath))) return targetName;

  // Split into base and extension: "attachments/paper.pdf" → ["attachments/paper", ".pdf"]
  const dotIndex = targetName.lastIndexOf(".");
  const slashIndex = targetName.lastIndexOf("/");
  const hasExt = dotIndex > slashIndex + 1;
  const baseName = hasExt ? targetName.slice(0, dotIndex) : targetName;
  const ext = hasExt ? targetName.slice(dotIndex) : "";

  for (let i = 1; i < 100; i++) {
    const candidate = `${baseName} (${i})${ext}`;
    const candidatePath = await join(rootPath, candidate);
    if (!(await exists(candidatePath))) return candidate;
  }
  // Fallback — should never reach here
  return `${baseName} (${Date.now()})${ext}`;
}

export async function copyFileToProject(
  rootPath: string,
  sourcePath: string,
  targetName: string,
): Promise<string> {
  await registerProjectRoot(rootPath);
  // Auto-deduplicate filename
  const uniqueName = await getUniqueTargetName(rootPath, targetName);
  const fullPath = await join(rootPath, uniqueName);
  const bytes = await readFile(sourcePath);
  await backend.files.write(refFor(fullPath), [...bytes], null);
  return uniqueName;
}

export async function deleteFileFromDisk(
  absolutePath: string | FileRef,
): Promise<void> {
  log.debug(`Deleting file: ${absolutePath}`);
  await backend.files.mutate(refFor(absolutePath), "delete");
}

export async function deleteFolderFromDisk(
  absolutePath: string | FileRef,
): Promise<void> {
  log.debug(`Deleting folder: ${absolutePath}`);
  await backend.files.mutate(refFor(absolutePath), "delete");
}

export async function renameFileOnDisk(
  oldPath: string | FileRef,
  newPath: string | FileRef,
): Promise<void> {
  log.debug(`Renaming: ${oldPath} → ${newPath}`);
  await backend.files.mutate(refFor(oldPath), "rename", refFor(newPath).path);
  const oldKey = revisionKey(refFor(oldPath)),
    newKey = revisionKey(refFor(newPath));
  if (revisions.has(oldKey)) revisions.set(newKey, revisions.get(oldKey)!);
  revisions.delete(oldKey);
}

export async function createDirectory(absolutePath: string): Promise<void> {
  await backend.files.mutate(refFor(absolutePath), "mkdir");
}

export { exists, join };
