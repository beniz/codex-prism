import { invoke as nativeInvoke } from "@tauri-apps/api/core";
const projectServices = new Set([
  "compile_latex",
  "optimize_pdf",
  "load_existing_pdf",
  "synctex_edit",
  "synctex_view",
  "history_init",
  "history_status",
  "history_set_prompt",
  "history_retry",
  "history_snapshot",
  "history_list",
  "history_diff",
  "history_file_at",
  "history_restore",
  "history_add_label",
  "history_remove_label",
  "setup_project_venv",
  "project_venv_status",
]);
export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (projectServices.has(command)) {
    const data = { ...args };
    const root = String(
      data.projectRoot ?? data.projectDir ?? data.projectPath ?? "",
    );
    const project = await backend.projects.register(root);
    delete data.projectRoot;
    delete data.projectDir;
    delete data.projectPath;
    const result = await nativeInvoke<any>("project_service", {
      projectId: project.id,
      operation: command,
      args: data,
    });
    return (
      command === "compile_latex" ? new Uint8Array(result).buffer : result
    ) as T;
  }
  return nativeInvoke<T>(command, args);
}
import { listen } from "@tauri-apps/api/event";
import type { TemplateCategory } from "@/lib/template-registry";
export interface PrivateTemplateSummary {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  mainFile: string;
  revision: string;
}
export interface TemplateLibrary {
  root: string;
  templates: PrivateTemplateSummary[];
  issues: { folder: string; message: string }[];
}
export interface Project {
  id: string;
  root: string;
  name: string;
}
export interface FileRef {
  projectId: string;
  path: string;
}
export interface ReviewChange {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  kind: "added" | "modified" | "deleted";
  binary: boolean;
}
export interface Review {
  revision?: string;
  active: boolean;
  changes: ReviewChange[];
}
export interface Proposal {
  origin?: "reviewer" | "resolution" | null;
  blocksEditing?: boolean;
  id: string;
  projectId: string;
  threadId: string | null;
  chatId?: string | null;
  turnId?: string | null;
  error?: string | null;
  generation: number;
  state:
    | "running"
    | "ready"
    | "conflicts"
    | "repairing"
    | "interrupted"
    | "original"
    | "applying"
    | "invalid";
  conflicts: string[];
  parent: string | null;
  changes: ReviewChange[];
}
export interface Session {
  id: string;
  projectId: string;
  title: string;
}
export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
}
export interface ConnectionStatus {
  binary: string;
  version: string;
  account: {
    account: { email?: string; type: string; planType?: string } | null;
    requiresOpenaiAuth: boolean;
  };
  models: { data: CodexModel[] };
}
export interface AgentEvent {
  method: string;
  id?: number | string;
  params: any;
}
export interface PrismBackend {
  templates: {
    list(): Promise<TemplateLibrary>;
    preview(id: string, revision: string, retry?: boolean): Promise<number[]>;
    createProject(
      id: string,
      revision: string,
      destination: string,
    ): Promise<{ project: Project; mainFile: string }>;
  };
  projects: {
    getInstructions(projectId: string): Promise<string>;
    setInstructions(projectId: string, text: string): Promise<string>;
    rename(projectId: string, name: string): Promise<Project>;
    register(root: string): Promise<Project>;
    relocate(projectId: string, root: string): Promise<Project>;
  };
  files: {
    list(projectId: string): Promise<{
      files: { path: string; size: number; changeToken?: string }[];
      folders: string[];
    }>;
    mutate(
      ref: FileRef,
      action: "mkdir" | "delete" | "rename",
      destination?: string,
    ): Promise<void>;
    read(ref: FileRef): Promise<{ bytes: number[]; revision: string }>;
    write(
      ref: FileRef,
      bytes: number[],
      expectedRevision: string | null,
    ): Promise<string>;
  };
  agent: {
    status(): Promise<ConnectionStatus>;
    setPath(path: string): Promise<void>;
    account(action: "login" | "device" | "logout"): Promise<any>;
    sessions(projectId: string): Promise<Session[]>;
    thread(
      projectId: string,
      threadId: string,
      action: "read" | "archive" | "rename",
      title?: string,
    ): Promise<any>;
    send(
      projectId: string,
      threadId: string | null,
      prompt: string,
      model?: string,
      effort?: string,
      images?: string[],
      mainDocument?: string,
      historyPrompt?: string,
      chatId?: string,
      mode?: "plan" | "default",
    ): Promise<any>;
    control(
      projectId: string,
      threadId: string,
      turnId: string,
      prompt?: string,
    ): Promise<any>;
    respond(id: string | number, result: unknown): Promise<void>;
    subscribe(cb: (e: AgentEvent) => void): Promise<() => void>;
  };
  review: {
    get(projectId: string): Promise<Review>;
    refresh(projectId: string): Promise<Review>;
    resolve(projectId: string, path: string, undo: boolean): Promise<void>;
    resolveBatch(
      projectId: string,
      paths: string[],
      undo: boolean,
      expectedRevision?: string,
    ): Promise<{ accepted: boolean; historyWarning: string | null }>;
    subscribe(cb: (id: string) => void): Promise<() => void>;
  };
}
export const backend: PrismBackend = {
  templates: {
    list: () => invoke("template_list"),
    preview: (id, revision, retry = false) =>
      invoke("template_preview", { id, revision, retry }),
    createProject: (id, revision, destination) =>
      invoke("template_create_project", { id, revision, destination }),
  },
  projects: {
    getInstructions: (projectId) => invoke("project_service", { projectId, operation: "instructions_get", args: {} }),
    setInstructions: (projectId, text) => invoke("project_service", { projectId, operation: "instructions_set", args: { text } }),
    rename: (projectId, name) => invoke("project_rename", { projectId, name }),
    register: (root) => invoke("project_register", { root }),
    relocate: (projectId, root) =>
      invoke("project_relocate", { projectId, root }),
  },
  files: {
    list: (projectId) => invoke("project_list", { projectId }),
    mutate: (r, action, destination) =>
      invoke("project_mutate", { ...r, action, destination }),
    read: (r) =>
      invoke("project_read", r as unknown as Record<string, unknown>),
    write: (r, bytes, expectedRevision) =>
      invoke("project_write", { ...r, bytes, expectedRevision }),
  },
  agent: {
    status: () => invoke("codex_status"),
    setPath: (path) => invoke("codex_set_path", { path }),
    account: (action) => invoke("codex_account", { action }),
    sessions: (projectId) => invoke("codex_sessions", { projectId }),
    thread: (projectId, threadId, action, title) =>
      invoke("codex_thread", { projectId, threadId, action, title }),
    send: (
      projectId,
      threadId,
      prompt,
      model,
      effort,
      images,
      mainDocument,
      historyPrompt,
      chatId,
      mode,
    ) =>
      invoke("codex_send", {
        projectId,
        threadId,
        prompt,
        model: model || null,
        effort: effort || null,
        images: images ?? [],
        mainDocument: mainDocument ?? null,
        historyPrompt: historyPrompt ?? null,
        chatId: chatId ?? null,
        mode: mode ?? "default",
      }),
    control: (projectId, threadId, turnId, prompt) =>
      invoke("codex_control", {
        projectId,
        threadId,
        turnId,
        prompt: prompt ?? null,
      }),
    respond: (id, result) => invoke("codex_respond", { id, result }),
    subscribe: (cb) => listen<AgentEvent>("codex-event", (e) => cb(e.payload)),
  },
  review: {
    get: (projectId) => invoke("project_review", { projectId }),
    refresh: (projectId) =>
      nativeInvoke("project_service", {
        projectId,
        operation: "review_refresh",
        args: {},
      }),
    resolveBatch: (projectId, paths, undo, expectedRevision) =>
      invoke("project_resolve_review_batch", {
        projectId,
        paths,
        undo,
        expectedRevision: expectedRevision ?? null,
      }),
    resolve: (projectId, path, undo) =>
      invoke("project_resolve_review", { projectId, path, undo }),
    subscribe: (cb) =>
      listen<{ projectId: string }>("project-review", (e) =>
        cb(e.payload.projectId),
      ),
  },
};
// Compatibility transport for existing native services while their typed facades migrate.
export { listen };
export { convertFileSrc } from "@tauri-apps/api/core";
export type { UnlistenFn } from "@tauri-apps/api/event";

export interface ProposalPdfBuild {
  bytes: number[];
  artifactId: string;
  locations: import("@/lib/visual-review").SourceBox[];
}
export const proposals = {
  loadBuild: (p: Proposal, mainFile: string) =>
    nativeInvoke<ProposalPdfBuild | null>("project_service", {
      projectId: p.projectId,
      operation: "proposal_load_build",
      args: { proposalId: p.id, generation: p.generation, mainFile, side: "result" },
    }),
  list: (projectId: string) =>
    nativeInvoke<Proposal[]>("project_service", {
      projectId,
      operation: "proposal_list",
      args: {},
    }),
  operate: <
    T = {
      conflicts?: string[];
      historyWarning?: string;
      prompt?: string;
      reusedBuilds?: string[];
      reviewAgain?: boolean;
      sourceChanged?: boolean;
    },
  >(
    p: Proposal,
    action: "apply" | "discard" | "repair" | "read" | "compile" | "recover",
    extra: Record<string, unknown> = {},
  ) =>
    nativeInvoke<T>("project_service", {
      projectId: p.projectId,
      operation: `proposal_${action}`,
      args: { proposalId: p.id, generation: p.generation, ...extra },
    }),
};
