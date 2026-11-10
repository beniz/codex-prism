import { type Dispatch, type SetStateAction, useState } from "react";
import { type ProjectSettings } from "@/lib/data-sources";
import { open } from "@/lib/backend/desktop-host";
import { Button } from "@/components/ui/button";
import { SshDataSources } from "./agent-chat/ssh-data-sources";
export function DataSourceEditor({ projectId = "", settings, setSettings, files, setFiles, disabled = false, filesLocked = false }: {
  projectId?: string; settings: ProjectSettings; setSettings: Dispatch<SetStateAction<ProjectSettings>>;
  files: string[]; setFiles: Dispatch<SetStateAction<string[]>>; disabled?: boolean; filesLocked?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  async function add(directory: boolean) {
    try {
      const selected = await open({ directory, multiple: true, title: directory ? "Add data source directories" : "Add data source files" });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (directory) setSettings(old => ({ ...old, sources: [...old.sources, ...paths.map(path => ({ id: crypto.randomUUID(), name: path.split(/[/\\]/).filter(Boolean).pop() || path, path, kind: "directory" as const }))] }));
      else setFiles(old => [...new Set([...old, ...paths])]);
      setError(null);
    } catch (e) { setError(String(e)); }
  }
  return <div className="space-y-2">
    <SshDataSources projectId={projectId} settings={settings} setSettings={setSettings} disabled={disabled} onAddDirectory={() => void add(true)} fileAction={<Button variant="outline" disabled={disabled || filesLocked} onClick={() => void add(false)}>Add files</Button>} />
    {settings.sources.filter(s => !s.connectionId).map(source => <div key={source.id} className="rounded border p-2">
      <div className="flex gap-2"><input aria-label="Source name" className="min-w-0 flex-1 rounded border bg-background p-1" disabled={disabled} value={source.name} onChange={e => setSettings(old => ({ ...old, sources: old.sources.map(s => s.id === source.id ? { ...s, name: e.target.value } : s) }))} /><Button variant="ghost" disabled={disabled} onClick={() => setSettings(old => ({ ...old, sources: old.sources.filter(s => s.id !== source.id) }))}>Remove</Button></div>
      <p className="break-all text-xs text-muted-foreground">{source.kind === "file" ? "File" : "Directory"} · {source.path}</p>
    </div>)}
    {files.map(path => <div key={path} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 break-all">{path} · to be copied</span><Button disabled={disabled} variant="ghost" onClick={() => setFiles(old => old.filter(p => p !== path))}>Remove</Button></div>)}
    <p className="text-xs text-muted-foreground">Files are copied into the project when saved. Directories stay external. Removing a file source keeps its file in the project.{filesLocked && " Adding files is available after running work and pending proposals are resolved."}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
