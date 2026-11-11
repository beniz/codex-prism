import { backend } from "./backend";
import { exists, join, mkdir, writeTextFile } from "./backend/desktop-host";
import {
  getProjectSettings,
  saveSourcesWithFiles,
  type ProjectSettings,
} from "./data-sources";
import { DEFAULT_AGENTS_MD } from "./default-agents-md";
import { getProjectNameError, normalizeProjectName } from "./project-name";
import {
  templateInitialInstructions,
  type TemplateCatalogItem,
} from "./template-catalog";
import { BIB_TEMPLATE, getTemplateSkeleton } from "./template-registry";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";

/** Kept by the form across retries; never treats an unrelated existing folder as ours. */
export interface CreationAttempt {
  path?: string;
  templateKey?: string;
  initialized?: boolean;
  importedFiles?: string[];
  sessionStarted?: boolean;
}
export class ProjectCreationNameError extends Error {}

async function writeMissing(path: string, content: string) {
  if (!(await exists(path))) await writeTextFile(path, content);
}

export async function createProject(
  request: {
    template: TemplateCatalogItem;
    parentDirectory: string;
    name: string;
    purpose: string;
    settings: ProjectSettings;
    files: string[];
  },
  attempt: CreationAttempt,
  sourcesSaved: (settings: ProjectSettings) => void,
): Promise<void> {
  const error = getProjectNameError(request.name);
  if (error) throw new ProjectCreationNameError(error);
  const { template } = request;
  const path = await join(
    request.parentDirectory,
    normalizeProjectName(request.name),
  );
  const key = JSON.stringify([
    template.id,
    template.source === "private" ? template.revision : "builtin",
  ]);
  const retry = attempt.path === path && attempt.templateKey === key;
  if ((await exists(path)) && !retry)
    throw new ProjectCreationNameError(
      "A folder with this name already exists here",
    );
  if (!retry) {
    // Private copying is atomic in the backend. For built-ins, remember ownership
    // immediately after mkdir so an interrupted write can be retried safely.
    if (template.source === "private")
      await backend.templates.createProject(
        template.id,
        template.revision,
        path,
      );
    else await mkdir(path, { recursive: true });
    Object.assign(attempt, {
      path,
      templateKey: key,
      initialized: template.source === "private",
      importedFiles: [],
      sessionStarted: false,
    });
  }
  if (!attempt.initialized && template.source === "builtin") {
    await writeMissing(
      await join(path, template.mainFileName),
      getTemplateSkeleton(template),
    );
    if (template.hasBibliography)
      await writeMissing(await join(path, "references.bib"), BIB_TEMPLATE);
    attempt.initialized = true;
  }
  await writeMissing(await join(path, "AGENTS.md"), DEFAULT_AGENTS_MD);

  const registered = await backend.projects.register(path);
  const current = await getProjectSettings(registered.id);
  const sources = [
    ...new Map(
      [...current.sources, ...request.settings.sources].map((s) => [s.id, s]),
    ).values(),
  ];
  const files = request.files.filter(
    (f) => !attempt.importedFiles?.includes(f),
  );
  const saved = await saveSourcesWithFiles(
    registered.id,
    path,
    {
      ...current,
      instructions: request.settings.instructions,
      sources,
      connections: request.settings.connections ?? [],
    },
    files,
  );
  attempt.importedFiles = [
    ...new Set([...(attempt.importedFiles ?? []), ...files]),
  ];
  sourcesSaved(saved);

  if (request.purpose.trim()) {
    const guidance = templateInitialInstructions(template);
    const prompt = [
      `## New ${template.name} Project`,
      "",
      `**Template:** \`${template.documentClass}\`  `,
      `**File:** \`${template.mainFileName}\``,
      "",
      guidance.context,
      "",
      "### What I want to create",
      "",
      request.purpose.trim(),
      "",
      "### Instructions",
      "",
      guidance.instructions,
    ].join("\n");
    const chat = useAgentChatStore.getState();
    if (!attempt.sessionStarted) {
      chat.newSession();
      attempt.sessionStarted = true;
    }
    chat.setPendingInitialPrompt(prompt);
  }
  useProjectStore.getState().setLastProjectFolder(request.parentDirectory);
  useProjectStore.getState().addRecentProject(path);
  await useDocumentStore.getState().openProject(path, template.mainFileName);
}
