import { DataSourceEditor } from "@/components/data-source-editor";
import { useState, useEffect, useRef } from "react";
import {
  ArrowLeftIcon,
  FolderOpenIcon,
  SparklesIcon,
  ChevronDownIcon,
  MapPinIcon,
  Loader2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { getTemplateById } from "@/lib/template-registry";
import { useProjectCreation } from "@/hooks/use-project-creation";
import { TemplateGallery } from "@/components/template-gallery";

import { getProjectNameError, normalizeProjectName } from "@/lib/project-name";

// ─── Helpers ───

// ─── Wizard Component ───

export type CreationMode = "template" | "scratch";

interface ProjectWizardProps {
  mode: CreationMode;
  onBack: () => void;
}

export function ProjectWizard({ mode, onBack }: ProjectWizardProps) {
  // ── Template mode: just show the gallery ──
  // The TemplatePreview modal inside the gallery handles details + creation.
  if (mode === "template") {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-[calc(48px+var(--titlebar-height))] shrink-0 items-center gap-3 border-border/60 border-b px-4 pt-[var(--titlebar-height)]">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-lg"
            onClick={onBack}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="font-semibold text-sm">Choose a Template</span>
        </div>
        <div className="flex-1 overflow-hidden">
          <TemplateGallery />
        </div>
      </div>
    );
  }

  // ── Scratch mode: inline details form ──
  return <ScratchForm onBack={onBack} />;
}

// ─── Scratch mode form (no template preview) ───

function ScratchForm({ onBack }: { onBack: () => void }) {
  const template = { ...getTemplateById("blank")!, source: "builtin" as const };
  const { purpose, setPurpose, attachments, setAttachments, sourceSettings, setSourceSettings,
    projectFolder, projectName, setProjectName, projectNameError, setProjectNameError,
    isCreating, isDragOver, handleChooseFolder, handleCreate } = useProjectCreation(template);
  const [locationOpen, setLocationOpen] = useState(false);
  const projectNameRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => projectNameRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const canCreate = Boolean(
    template && projectFolder && !getProjectNameError(projectName),
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex h-[calc(48px+var(--titlebar-height))] shrink-0 items-center gap-3 border-border/60 border-b px-4 pt-[var(--titlebar-height)]">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-lg"
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <span className="font-semibold text-sm">New Document</span>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[520px] space-y-4 px-6 py-10">
          {/* Project name */}
          <div className="space-y-2.5">
            <div>
              <span className="font-semibold text-sm">Project name</span>
              <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                This becomes the folder name on disk.
              </p>
            </div>
            <Input
              ref={projectNameRef}
              placeholder="e.g., flashvid-paper"
              value={projectName}
              onChange={(e) => {
                setProjectName(e.target.value);
                setProjectNameError("");
              }}
              onBlur={() =>
                setProjectNameError(getProjectNameError(projectName) ?? "")
              }
              className="rounded-xl border-border/60 bg-card/30 text-sm focus-visible:bg-card/50"
            />
            {projectNameError && (
              <p className="text-destructive text-xs">{projectNameError}</p>
            )}
          </div>

          {/* Purpose */}
          <div className="space-y-2.5">
            <div>
              <span className="font-semibold text-sm">
                What are you writing?
              </span>
              <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                Describe your document and Codex will generate tailored
                content.
              </p>
            </div>
            <Textarea
              ref={textareaRef}
              placeholder="e.g., A research paper on transformer architectures for protein structure prediction, targeting NeurIPS 2025..."
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={4}
              className="resize-none rounded-xl border-border/60 bg-card/30 text-sm leading-relaxed placeholder:text-muted-foreground/50 focus-visible:bg-card/50"
            />
          </div>

          {/* Collapsible sections */}
          <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/60 bg-card/30">
            <section className="space-y-2 p-4" aria-label="Data sources">
              <h3 className="text-sm font-medium">Data sources</h3>
              <DataSourceEditor settings={sourceSettings} setSettings={setSourceSettings} files={attachments} setFiles={setAttachments} disabled={isCreating} />
              {isDragOver && <p className="text-xs">Drop files to add data sources</p>}
            </section>

            {/* Project location */}
            <div>
              <button
                onClick={() => setLocationOpen(!locationOpen)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                  <MapPinIcon className="size-3.5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-sm">Project location</span>
                </div>
                {!locationOpen && projectFolder && projectName.trim() && (
                  <span className="min-w-0 max-w-[180px] truncate rounded-md bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground/60">
                    .../{projectFolder.split(/[/\\]/).pop()}/
                    {normalizeProjectName(projectName)}
                  </span>
                )}
                <ChevronDownIcon
                  className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${locationOpen ? "rotate-180" : ""}`}
                />
              </button>
              {locationOpen && (
                <div className="space-y-2.5 px-4 pb-4">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground/60">
                      {projectFolder
                        ? `${projectFolder}/${normalizeProjectName(projectName) || "..."}`
                        : "Choose a location"}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-1.5 rounded-lg border-border/60"
                      onClick={handleChooseFolder}
                    >
                      <FolderOpenIcon className="size-3.5" />
                      {projectFolder ? "Change" : "Choose"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Create button */}
          <div className="pt-1">
            <Button
              className="w-full gap-2 rounded-xl font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.99]"
              size="lg"
              disabled={!canCreate || isCreating}
              onClick={handleCreate}
            >
              {isCreating ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" />
                  Creating project...
                </>
              ) : purpose.trim() ? (
                <>
                  <SparklesIcon className="size-4" />
                  Create & Generate with AI
                </>
              ) : (
                "Create Project"
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
