import { DataSourceEditor } from "../data-source-editor";
import { useDocumentStore } from "@/stores/document-store";
import { getProjectSettings, saveProjectSettings, saveSourcesWithFiles, type ProjectSettings } from "@/lib/data-sources";
import { useEffect, useRef, useState } from "react";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

export function ProjectInstructions({ projectId, projectName, renameProject }: { projectId: string; projectName?: string; renameProject?: (name: string) => Promise<void> }) {
  const sourcesHeading = useRef<HTMLHeadingElement>(null);
  const focusSources = useRef(false);
  const [settings, setSettings] = useState<ProjectSettings>({ revision: 0, instructions: "", sources: [] });
  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent).detail === projectId) { focusSources.current = true; setOpen(true); } };
    window.addEventListener("prism-source-settings", show);
    return () => window.removeEventListener("prism-source-settings", show);
  }, [projectId]);
  const [files, setFiles] = useState<string[]>([]);
  const locked = useAgentChatStore(s => s.locked);
  const [name, setName] = useState(projectName ?? "");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  async function rename() {
    if (!renameProject || locked) return;
    setRenaming(true); setRenameError(null);
    try { await renameProject(name.trim()); }
    catch (e) { setRenameError(String(e)); }
    finally { setRenaming(false); }
  }
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && focusSources.current) { sourcesHeading.current?.focus(); focusSources.current = false; } }, [open]);
  const [saved, setSaved] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const job = ++generation.current;
    setLoading(true);
    setError(null);
    void getProjectSettings(projectId).then(value => {
      if (job === generation.current) { setFiles([]); setSettings(value); setSaved(value.instructions); setText(value.instructions); }
    }).catch(e => { if (job === generation.current) setError(String(e)); })
      .finally(() => { if (job === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [projectId, open]);
  async function save() {
    const job = generation.current;
    setBusy(true);
    setError(null);
    try {
      const value = files.length ? await saveSourcesWithFiles(projectId, useDocumentStore.getState().projectRoot!, { ...settings, instructions: text }, files) : await saveProjectSettings(projectId, { ...settings, instructions: text });
      window.dispatchEvent(new Event("prism-sources-changed"));
      if (job === generation.current) { setSaved(value.instructions); setOpen(false); }
    } catch (e) { if (job === generation.current) setError(String(e)); }
    finally { if (job === generation.current) setBusy(false); }
  }
  return <>
    <button type="button" className="w-full min-w-0 rounded-md px-2 py-1 font-semibold text-sm hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setName(projectName ?? ""); setRenameError(null); setOpen(true); }} title="Project settings" aria-label="Project settings"><span className="block truncate">{projectName ?? "Project instructions"}</span>{saved.trim() && <span className="sr-only">Instructions configured</span>}</button>
    <Dialog open={open} onOpenChange={value => { if (!busy && !renaming) setOpen(value); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Project settings</DialogTitle><DialogDescription>Shared instructions apply to all chats in this project from their next turn. Data sources provide reference material; required document assets are copied into the project. Stored locally in Prism.</DialogDescription></DialogHeader>
        {renameProject && <div className="space-y-2">
          <label htmlFor="project-settings-name" className="text-sm font-medium">Project title</label>
          <div className="flex gap-2"><input id="project-settings-name" className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm" value={name} disabled={locked || renaming || busy} onChange={e => setName(e.target.value)} /><Button variant="outline" disabled={locked || renaming || busy || !name.trim() || name.trim() === projectName} onClick={() => void rename()}>{renaming ? "Renaming…" : "Rename"}</Button></div>
          <p className="text-xs text-muted-foreground">Renaming also changes the project folder name.{locked && " Available after running work and pending proposals are resolved."}</p>
          {renameError && <p role="alert" className="text-sm text-destructive">{renameError}</p>}
        </div>}
        <section className="space-y-2" aria-label="Data sources">
          <h3 ref={sourcesHeading} tabIndex={-1} className="font-medium text-sm">Data sources</h3>
          <DataSourceEditor projectId={projectId} settings={settings} setSettings={setSettings} files={files} setFiles={setFiles} disabled={loading || busy} filesLocked={locked} />
        </section>
        <label htmlFor="project-shared-prompt" className="text-sm font-medium">Shared project prompt</label>
        <textarea id="project-shared-prompt" aria-label="Project instructions" className="min-h-48 w-full rounded-md border bg-background p-3 text-sm" disabled={loading || busy || renaming} value={text} onChange={e => setText(e.target.value)} placeholder="Base this presentation on references/paper-draft.pdf. Target a 20-minute research talk and distinguish validated results from proposed work." />
        <p className="text-xs text-muted-foreground">Save an empty value to clear instructions.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy || renaming} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={loading || busy || renaming} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
