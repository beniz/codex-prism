import { useEffect, useState } from "react";
import { DatabaseIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { getProjectSettings, getSourceStatus, openSourceSettings, type DataSource, type SourceStatus } from "@/lib/data-sources";
export function DataSources({ projectId }: { projectId: string }) {
  const [sources, setSources] = useState<DataSource[]>([]);
  const [statuses, setStatuses] = useState<SourceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, busy = false, pending = false;
    const refresh = async () => {
      if (busy) { pending = true; return; }
      busy = true;
      try {
        const settings = await getProjectSettings(projectId);
        if (!alive) return;
        setSources(settings.sources); setStatuses([]); setError(null);
        const status = await getSourceStatus(projectId);
        if (alive) setStatuses(status);
      } catch (e) { if (alive) setError(String(e)); }
      finally { busy = false; if (alive && pending) { pending = false; void refresh(); } }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("prism-sources-changed", refresh);
    return () => { alive = false; window.removeEventListener("focus", refresh); window.removeEventListener("prism-sources-changed", refresh); };
  }, [projectId]);
  return <section className="border-t border-sidebar-border text-xs" aria-label="Data sources">
    <div className="relative flex h-8 shrink-0 items-center justify-center gap-2 px-9">
      <DatabaseIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate font-medium text-xs">Data sources</span>
      <button className="absolute right-1 rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" aria-label="Refresh data sources" title="Refresh data sources" onClick={() => window.dispatchEvent(new Event("prism-sources-changed"))}>
        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
    <div className="space-y-0.5 px-1 pb-1.5">
    {sources.some(s => s.kind === "file") && (() => {
      const files = sources.filter(s => s.kind === "file");
      const checks = files.map(f => statuses.find(s => s.id === f.id));
      const ready = checks.filter(s => s?.reachable).length;
      const checked = checks.every(Boolean);
      const color = error ? "bg-red-500" : !checked ? "bg-muted-foreground" : ready === files.length ? "bg-green-500" : ready ? "bg-amber-500" : "bg-red-500";
      return <button className="flex w-full items-center gap-2 rounded p-1 text-left hover:bg-sidebar-accent" onClick={() => openSourceSettings(projectId)} title={error ?? (checked ? `${ready} of ${files.length} files available` : "Checking files…")}><span className={`size-1.5 shrink-0 rounded-full ${color}`} />Files · {files.length}</button>;
    })()}
    {sources.filter(source => source.kind !== "file").map(source => {
      const status = statuses.find(s => s.id === source.id);
      const explanation = error ?? (status ? status.reachable ? source.connectionId ? "Remote server and directory are reachable" : "Directory is reachable" : status.error : "Checking directory…");
      return <button key={source.id} className="flex w-full items-center gap-2 rounded p-1 text-left hover:bg-sidebar-accent" onClick={() => openSourceSettings(projectId)} title={`${source.path}\n${explanation}`} aria-label={`${source.name}: ${explanation}`}>
        <span className={`size-1.5 shrink-0 rounded-full ${error || status && !status.reachable ? "bg-red-500" : status?.reachable ? "bg-green-500" : "bg-muted-foreground"}`} />{source.connectionId && <ServerIcon className="size-3 shrink-0 text-muted-foreground" aria-label="SSH source" />}<span className="truncate">{source.name}</span>
      </button>;
    })}
    {!sources.length && <button className="p-1" onClick={() => openSourceSettings(projectId)}>Add data source</button>}
    {error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
