import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/backend";
import { listen } from "@/lib/backend";
import { open } from "@/lib/backend/desktop-host";
import { toast } from "sonner";
import {
  FlaskConicalIcon,
  DownloadIcon,
  CheckCircle2Icon,
  AlertCircleIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
  Trash2Icon,
  Loader2Icon,
  ChevronLeftIcon,
  FolderPlusIcon,
  XIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  type SkillCategoryData,
  type SkillEntryData,
  ICON_MAP,
} from "./skill-category-card";
import { InstallProgress } from "./install-progress";

interface InstallResult {
  success: boolean;
  skills_installed: number;
  target_dir: string;
  message: string;
}

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

interface SkillInfo {
  id: string;
  name: string;
  domain: string;
  description: string;
  folder: string;
}

interface ScientificSkillsOnboardingProps {
  onClose: () => void;
}

export function ScientificSkillsOnboarding({
  onClose,
}: ScientificSkillsOnboardingProps) {
  const [categories, setCategories] = useState<SkillCategoryData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<InstallResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SkillsStatus | null>(null);
  const [installedSkills, setInstalledSkills] = useState<SkillInfo[]>([]);
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [confirmUninstallAllOpen, setConfirmUninstallAllOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillEntryData | null>(null);
  const [deletingSkillFolder, setDeletingSkillFolder] = useState<string | null>(
    null,
  );
  const mountedRef = useRef(true);
  const installBackendLogSeenRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("skills-install-log", (event) => {
      installBackendLogSeenRef.current = true;
      setInstallLogs((previous) => {
        const last = previous[previous.length - 1];
        if (last === event.payload) return previous;
        return [...previous, event.payload];
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Skills are global Codex assets under ~/.agents/skills.
  const checkStatus = useCallback(async () => {
    try {
      const [gs, skills] = await Promise.all([
        invoke<SkillsStatus>("check_skills_installed", {
          projectPath: null,
        }),
        invoke<SkillInfo[]>("list_installed_skills", {
          projectPath: null,
        }),
      ]);
      setStatus(gs);
      setInstalledSkills(skills);
    } catch {
      setStatus(null);
      setInstalledSkills([]);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    invoke<SkillCategoryData[]>("get_skill_categories")
      .then((cats) => {
        setCategories(cats);
        if (cats.length > 0) setSelectedId(cats[0].id);
      })
      .catch(console.error);
  }, []);

  const knownSkillFolders = new Set(
    categories.flatMap((category) =>
      category.skills.map((skill) => skill.folder),
    ),
  );
  const importedSkills = installedSkills.filter(
    (skill) => !knownSkillFolders.has(skill.folder),
  );
  const installedSkillFolders = new Set(
    installedSkills.map((skill) => skill.folder),
  );
  const displayCategories: SkillCategoryData[] =
    importedSkills.length > 0
      ? [
          ...categories,
          {
            id: "imported",
            name: "Imported Skills",
            icon: "settings",
            skill_count: importedSkills.length,
            skills: importedSkills.map((skill) => ({
              name: skill.name,
              folder: skill.folder,
            })),
          },
        ]
      : categories;

  const totalSkills = displayCategories.reduce(
    (sum, c) => sum + c.skill_count,
    0,
  );
  const selected =
    displayCategories.find((c) => c.id === selectedId) ??
    displayCategories[0] ??
    null;
  const isInstalled = status?.installed ?? false;

  const handleInstall = useCallback(async () => {
    installBackendLogSeenRef.current = false;
    let noBackendLogTimer: number | undefined;
    setInstallLogs(["Preparing installer..."]);
    setIsInstalling(true);
    setIsComplete(false);
    setInstallResult(null);
    setError(null);

    try {
      noBackendLogTimer = window.setTimeout(() => {
        if (installBackendLogSeenRef.current || !mountedRef.current) return;
        setInstallLogs((previous) => {
          const hasBackendLog = previous.some(
            (line) => !line.startsWith("Preparing installer"),
          );
          if (hasBackendLog) return previous;
          return [...previous, "Waiting for the installer command to start..."];
        });
      }, 2500);

      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (!mountedRef.current) return;

      const result = await invoke<InstallResult>(
        "install_scientific_skills_global",
        {},
      );
      if (noBackendLogTimer !== undefined) {
        window.clearTimeout(noBackendLogTimer);
      }
      if (!mountedRef.current) return;
      setInstallResult(result);
      setIsComplete(true);
      await checkStatus();
    } catch (e) {
      if (noBackendLogTimer !== undefined) {
        window.clearTimeout(noBackendLogTimer);
      }
      if (!mountedRef.current) return;
      const message = String(e);
      setInstallLogs((previous) => [...previous, message]);
      setError(message);
      setIsInstalling(false);
    }
  }, [checkStatus]);

  const handleUninstall = useCallback(async () => {
    setIsUninstalling(true);
    try {
      await invoke("uninstall_scientific_skills", {
        projectPath: null,
      });
      await checkStatus();
      toast.success("All skills uninstalled");
    } catch (e) {
      console.error("Failed to uninstall:", e);
      toast.error("Failed to uninstall skills", {
        description: String(e),
      });
    } finally {
      setIsUninstalling(false);
    }
  }, [checkStatus]);

  const handleImportSkill = useCallback(async () => {
    setIsImporting(true);
    try {
      const selectedFolder = await open({
        directory: true,
        multiple: false,
        title: "Import Agent Skill Folder",
      });

      if (typeof selectedFolder !== "string") return;

      const skills = await invoke<SkillInfo[]>("import_skill_from_folder", {
        sourcePath: selectedFolder,
      });

      await checkStatus();
      setSelectedId("imported");
      toast.success("Skill imported", {
        description:
          skills.length === 1
            ? skills[0]?.name
            : `${skills.length} skills imported`,
      });
    } catch (e) {
      toast.error("Failed to import skill", {
        description: String(e),
      });
    } finally {
      setIsImporting(false);
    }
  }, [checkStatus]);

  const handleConfirmDeleteSkill = useCallback(async () => {
    if (!deleteTarget) return;
    setDeletingSkillFolder(deleteTarget.folder);
    try {
      await invoke("delete_installed_skill", {
        skillFolder: deleteTarget.folder,
      });
      toast.success("Skill deleted", {
        description: deleteTarget.name,
      });
      setDeleteTarget(null);
      await checkStatus();
    } catch (e) {
      toast.error("Failed to delete skill", {
        description: String(e),
      });
    } finally {
      setDeletingSkillFolder(null);
    }
  }, [checkStatus, deleteTarget]);

  // ─── Installing / Complete state ───
  if (isInstalling || isComplete || error) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="gap-3 px-6 pt-6 pb-4 sm:max-w-md"
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute top-4 right-4 z-10 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }}
          >
            <XIcon className="size-4" />
          </button>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              {isComplete ? (
                <CheckCircle2Icon className="size-5 text-foreground" />
              ) : error ? (
                <AlertCircleIcon className="size-5 text-destructive" />
              ) : (
                <FlaskConicalIcon className="size-5 text-muted-foreground" />
              )}
              {isComplete
                ? "Installation Complete"
                : error
                  ? "Installation Failed"
                  : "Installing Skills"}
            </DialogTitle>
            {isComplete && (
              <DialogDescription>
                {installResult?.skills_installed ?? 0} scientific skills are now
                available.
              </DialogDescription>
            )}
          </DialogHeader>

          <InstallProgress
            isInstalling={isInstalling}
            isComplete={isComplete}
            error={error}
            logs={installLogs}
          />

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="text-muted-foreground text-xs leading-relaxed">
                {error}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            {error && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleInstall}
                className="gap-1.5"
              >
                <RefreshCwIcon className="size-3.5" />
                Retry
              </Button>
            )}
            {(isComplete || error) && (
              <Button size="sm" onClick={onClose}>
                {isComplete ? "Done" : "Close"}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── Browse state — two-column layout ───
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(36rem,calc(100vh-6rem))] w-[min(56rem,calc(100vw-4rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          {/* Header */}
          <DialogHeader className="shrink-0 border-border border-b px-6 py-3">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-sm">Skills</DialogTitle>
                <DialogDescription className="mt-0.5 text-xs">
                  {totalSkills} skills across {displayCategories.length} groups
                  - install curated scientific skills or import a local agent
                  skill. Curated set powered by{" "}
                  <a
                    href="https://github.com/K-Dense-AI/scientific-agent-skills"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 underline decoration-border underline-offset-2 hover:text-foreground"
                  >
                    K-Dense
                    <ExternalLinkIcon className="size-2.5" />
                  </a>
                </DialogDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isInstalled ? (
                  <>
                    <Badge variant="secondary" className="gap-1 text-xs">
                      <CheckCircle2Icon className="size-3" />
                      {status?.skill_count} installed
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleInstall}
                      className="gap-1.5"
                    >
                      <RefreshCwIcon className="size-3.5" />
                      Update
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmUninstallAllOpen(true)}
                      disabled={isUninstalling}
                      className="gap-1.5 text-destructive hover:text-destructive"
                    >
                      {isUninstalling ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2Icon className="size-3.5" />
                      )}
                      Uninstall
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={handleInstall} className="gap-1.5">
                    <DownloadIcon className="size-3.5" />
                    Install All
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleImportSkill}
                  disabled={isImporting || isInstalling || isUninstalling}
                  className="gap-1.5 border-border/70 bg-muted/30 text-foreground shadow-none hover:bg-muted/60 hover:text-foreground"
                >
                  {isImporting ? (
                    <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <FolderPlusIcon className="size-3.5 text-muted-foreground" />
                  )}
                  Import Skill
                </Button>
              </div>
            </div>
          </DialogHeader>

          {/* Body — sidebar + detail */}
          <div className="flex flex-1 overflow-hidden">
            {/* Category sidebar */}
            <nav className="w-64 max-w-64 shrink-0 overflow-hidden border-border border-r">
              <ScrollArea className="h-full w-full overflow-hidden [&_[data-slot=scroll-area-scrollbar]]:hidden">
                <div className="box-border flex w-full min-w-0 flex-col gap-0.5 overflow-x-hidden p-2">
                  {displayCategories.map((cat) => {
                    const Icon = ICON_MAP[cat.icon] || FlaskConicalIcon;
                    const isActive = selectedId === cat.id;
                    return (
                      <button
                        key={cat.id}
                        onClick={() => setSelectedId(cat.id)}
                        className={cn(
                          "box-border grid w-full min-w-0 max-w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2.5 overflow-hidden rounded-lg px-3 py-2 text-left text-sm transition-colors",
                          isActive
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        )}
                        title={cat.name}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="block min-w-0 truncate">
                          {cat.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </nav>

            {/* Detail panel */}
            <div className="flex flex-1 flex-col overflow-hidden">
              {selected ? (
                <ScrollArea className="flex-1">
                  <div className="p-6">
                    <CategoryDetail
                      category={selected}
                      isInstalled={isInstalled}
                      installedSkillFolders={installedSkillFolders}
                      deletingSkillFolder={deletingSkillFolder}
                      onDeleteSkill={setDeleteTarget}
                    />
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                  Select a category
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-between border-border border-t bg-muted/20 px-6 py-2.5">
            <p className="font-mono text-[11px] text-muted-foreground/60">
              {status?.location ?? "~/.agents/skills/"}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-muted-foreground"
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletingSkillFolder) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Skill</DialogTitle>
            <DialogDescription>
              Delete {deleteTarget?.name ?? "this skill"} from ~/.agents/skills.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 font-mono text-muted-foreground text-xs">
            {deleteTarget?.folder}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={deletingSkillFolder !== null}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deletingSkillFolder !== null}
              onClick={handleConfirmDeleteSkill}
              className="gap-1.5"
            >
              {deletingSkillFolder ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmUninstallAllOpen}
        onOpenChange={(open) => {
          if (!open && !isUninstalling) setConfirmUninstallAllOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Uninstall All Skills</DialogTitle>
            <DialogDescription>
              This will delete every skill under ~/.agents/skills, including
              imported local skills. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
            {status?.skill_count ?? 0} installed skills will be removed.
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isUninstalling}
              onClick={() => setConfirmUninstallAllOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isUninstalling}
              onClick={async () => {
                await handleUninstall();
                setConfirmUninstallAllOpen(false);
              }}
              className="gap-1.5"
            >
              {isUninstalling ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Uninstall All
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Category Detail Panel ───

function CategoryDetail({
  category,
  isInstalled,
  installedSkillFolders,
  deletingSkillFolder,
  onDeleteSkill,
}: {
  category: SkillCategoryData;
  isInstalled: boolean;
  installedSkillFolders: Set<string>;
  deletingSkillFolder: string | null;
  onDeleteSkill: (skill: SkillEntryData) => void;
}) {
  const Icon = ICON_MAP[category.icon] || FlaskConicalIcon;
  const [selectedSkill, setSelectedSkill] = useState<SkillEntryData | null>(
    null,
  );
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Reset when category changes
  useEffect(() => {
    setSelectedSkill(null);
    setSkillContent(null);
    setFetchError(null);
  }, [category.id]);

  const handleSkillClick = useCallback(
    async (skill: SkillEntryData) => {
      if (selectedSkill?.folder === skill.folder) {
        setSelectedSkill(null);
        setSkillContent(null);
        setFetchError(null);
        return;
      }
      setSelectedSkill(skill);
      setSkillContent(null);
      setFetchError(null);
      setLoadingContent(true);
      try {
        const content = await invoke<string>("get_skill_content", {
          skillFolder: skill.folder,
          projectPath: null,
        });
        setSkillContent(content);
      } catch (e) {
        setFetchError(String(e));
      } finally {
        setLoadingContent(false);
      }
    },
    [selectedSkill],
  );

  // Viewing a specific skill
  if (selectedSkill) {
    return (
      <div>
        <button
          onClick={() => {
            setSelectedSkill(null);
            setSkillContent(null);
            setFetchError(null);
          }}
          className="mb-3 flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <ChevronLeftIcon className="size-3.5" />
          {category.name}
        </button>

        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            <Icon className="size-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm">{selectedSkill.name}</h3>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/60">
              {selectedSkill.folder}
            </p>
          </div>
          {installedSkillFolders.has(selectedSkill.folder) && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={deletingSkillFolder === selectedSkill.folder}
              onClick={() => onDeleteSkill(selectedSkill)}
              title="Delete skill"
            >
              {deletingSkillFolder === selectedSkill.folder ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <Trash2Icon className="size-4" />
              )}
            </Button>
          )}
        </div>

        <Separator className="my-4" />

        {loadingContent ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading skill content…
          </div>
        ) : fetchError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-muted-foreground text-xs leading-relaxed">
              {fetchError}
            </p>
          </div>
        ) : skillContent ? (
          <div className="whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/30 p-4 font-mono text-foreground/80 text-xs leading-relaxed">
            {skillContent}
          </div>
        ) : null}
      </div>
    );
  }

  // Skill list view
  return (
    <div>
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="size-5 text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm">{category.name}</h3>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {category.skill_count} skills
            </Badge>
            {isInstalled && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <CheckCircle2Icon className="size-3" />
                Installed
              </Badge>
            )}
          </div>
        </div>
      </div>

      <Separator className="my-4" />

      <div>
        <h4 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Skills
        </h4>
        <div className="grid grid-cols-2 gap-1.5">
          {category.skills.map((skill) => {
            const canDelete = installedSkillFolders.has(skill.folder);
            const isDeleting = deletingSkillFolder === skill.folder;
            return (
              <div
                key={skill.folder}
                className="group flex min-w-0 items-center rounded-lg border border-border/60 bg-card/30 transition-colors hover:border-border hover:bg-accent/30"
              >
                <button
                  type="button"
                  onClick={() => handleSkillClick(skill)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
                  <span className="min-w-0 truncate">{skill.name}</span>
                </button>
                {canDelete && (
                  <button
                    type="button"
                    aria-label={`Delete ${skill.name}`}
                    title="Delete skill"
                    disabled={isDeleting}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteSkill(skill);
                    }}
                    className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 group-hover:opacity-100"
                  >
                    {isDeleting ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
