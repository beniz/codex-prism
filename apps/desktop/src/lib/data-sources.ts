import { invoke } from "@/lib/backend";
export interface DataSource { id: string; name: string; path: string }
export interface ProjectSettings { revision: number; instructions: string; sources: DataSource[] }
export interface SourceStatus { id: string; reachable: boolean; error: string | null }
export const getProjectSettings = (projectId: string) => invoke<ProjectSettings>("project_service", { projectId, operation: "settings_get", args: {} });
export const saveProjectSettings = (projectId: string, args: ProjectSettings) => invoke<ProjectSettings>("project_service", { projectId, operation: "settings_set", args });
export const getSourceStatus = (projectId: string) => invoke<SourceStatus[]>("project_service", { projectId, operation: "sources_status", args: {} });
export function openSourceSettings(projectId: string) { window.dispatchEvent(new CustomEvent("prism-source-settings", { detail: projectId })); }
