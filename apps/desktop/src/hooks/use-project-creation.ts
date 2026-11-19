import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  getCurrentWebview,
  open,
} from "@/lib/backend/desktop-host";
import { type ProjectSettings } from "@/lib/data-sources";
import {
  createProject,
  ProjectCreationNameError,
  type CreationAttempt,
} from "@/lib/project-creation";
import type { TemplateCatalogItem } from "@/lib/template-catalog";

const emptySources = (): ProjectSettings => ({
  revision: 0,
  instructions: "",
  sources: [],
  connections: [],
});

export function useProjectCreation(
  template: TemplateCatalogItem | undefined,
  acceptsDrop = true,
) {
  const [purpose, setPurpose] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [sourceSettings, setSourceSettings] = useState(emptySources);
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectNameError, setProjectNameError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const attempt = useRef<CreationAttempt>({});
  const busy = useRef(false);
  const handleChooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose the parent folder for the new project",
    });
    if (selected) setProjectFolder(selected);
    return selected;
  }, []);

  useEffect(() => {
    if (!acceptsDrop || isCreating) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { type } = event.payload;
        if (type === "enter") setIsDragOver(true);
        else if (type === "leave") setIsDragOver(false);
        else if (type === "drop") {
          setIsDragOver(false);
          const { paths } = event.payload;
          setAttachments((previous) => [...new Set([...previous, ...paths])]);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [acceptsDrop, isCreating]);

  const resetCreation = useCallback(() => {
    attempt.current = {};
    setProjectFolder(null);
    setPurpose("");
    setAttachments([]);
    setSourceSettings(emptySources());
    setProjectName("");
    setProjectNameError("");
    setIsDragOver(false);
  }, []);

  const handleCreate = async (): Promise<boolean> => {
    if (!template || busy.current) return false;
    busy.current = true;
    setIsCreating(true);
    try {
      const parentDirectory = projectFolder ?? await handleChooseFolder();
      if (!parentDirectory) return false;
      await createProject(
        {
          template,
          parentDirectory,
          name: projectName,
          purpose,
          settings: sourceSettings,
          files: attachments,
        },
        attempt.current,
        (saved) => {
          setSourceSettings(saved);
          setAttachments([]);
        },
      );
      setProjectFolder(null);
      return true;
    } catch (error) {
      if (error instanceof ProjectCreationNameError)
        setProjectNameError(error.message);
      else {
        console.error("Failed to create project:", error);
        toast.error("Failed to create project", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    } finally {
      busy.current = false;
      setIsCreating(false);
    }
  };

  return {
    purpose,
    setPurpose,
    attachments,
    setAttachments,
    sourceSettings,
    setSourceSettings,
    projectFolder,
    projectName,
    setProjectName,
    projectNameError,
    setProjectNameError,
    isCreating,
    isDragOver,
    handleChooseFolder,
    handleCreate,
    resetCreation,
  };
}
