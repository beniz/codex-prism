import { invoke } from "@/lib/backend";
export interface DataSource { id: string; name: string; path: string; kind?: "file" | "directory" | "remoteDirectory"; connectionId?: string }
export interface ProjectSettings { revision: number; fileSourcesMigrated?: boolean; instructions: string; sources: DataSource[]; connections?: SshConnection[]; pendingImports?: { path: string; destination: string }[] }
export interface SourceStatus { id: string; reachable: boolean; error: string | null }
export const getProjectSettings = (projectId: string) => invoke<ProjectSettings>("project_service", { projectId, operation: "settings_get", args: {} });
export const saveProjectSettings = (projectId: string, args: ProjectSettings) => invoke<ProjectSettings>("project_service", { projectId, operation: "settings_set", args });
export const getSourceStatus = (projectId: string) => invoke<SourceStatus[]>("project_service", { projectId, operation: "sources_status", args: {} });
export function openSourceSettings(projectId: string) { window.dispatchEvent(new CustomEvent("prism-source-settings", { detail: projectId })); }

export interface SshConnection { id: string; name: string; host: string; executable: string; socket: string; port: number | null; tokenFile: string }
export const testRemoteSource = (projectId: string, connection: SshConnection, path: string) => invoke<{ reachable: boolean }>("project_service", { projectId, operation: "source_test", args: { connection, path } });

export async function saveSourcesWithFiles(projectId: string, root: string, settings: ProjectSettings, files: string[]) {
  const { scanProjectFolder } = await import("./tauri/fs");
  const { isImageUpload, projectImageFolder } = await import("./project-images");
  const scan = files.some(isImageUpload) ? await scanProjectFolder(root) : null;
  const folder = scan ? projectImageFolder(scan.folders, scan.files.map(f => f.relativePath)) : "prism-uploads";
  const pendingImports = [...new Set(files)].map(path => ({ path, destination: `${isImageUpload(path) ? folder : "attachments"}/${path.split(/[/\\]/).pop()}` }));
  return saveProjectSettings(projectId, { ...settings, pendingImports });
}

export const probeLocalDirectory = (path: string) => invoke<{ reachable: boolean }>("project_service", { projectId: "", operation: "source_probe", args: { path } });
