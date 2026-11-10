import { useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { testRemoteSource, type ProjectSettings, type SshConnection } from "@/lib/data-sources";

export function SshDataSources({ projectId, settings, setSettings, disabled, onAddDirectory, fileAction }: {
  projectId: string; settings: ProjectSettings; setSettings: Dispatch<SetStateAction<ProjectSettings>>; disabled: boolean; onAddDirectory?: () => void; fileAction?: ReactNode;
}) {
  const [tests, setTests] = useState<Record<string, { fingerprint: string; message: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const update = (id: string, patch: Partial<SshConnection>) => setSettings(old => ({ ...old, connections: old.connections?.map(c => c.id === id ? { ...c, ...patch } : c) }));
  async function test(connection: SshConnection, path: string) {
    const fingerprint = JSON.stringify([connection, path]);
    setTesting(connection.id);
    try {
      await testRemoteSource(projectId, connection, path);
      setTests(old => ({ ...old, [connection.id]: { fingerprint, message: "Connected · directory is reachable" } }));
    } catch (error) {
      setTests(old => ({ ...old, [connection.id]: { fingerprint, message: String(error) } }));
    } finally { setTesting(null); }
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
    {fileAction}
    {onAddDirectory && <Button variant="outline" disabled={disabled} onClick={onAddDirectory}>Add directory</Button>}
    <Button variant="outline" disabled={disabled} onClick={() => setSettings(old => ({ ...old, connections: [...old.connections ?? [], { id: crypto.randomUUID(), name: "Remote research", host: "", executable: "", socket: "", port: null, tokenFile: "" }] }))}>Add SSH connection</Button>
    </div>
    {(settings.connections ?? []).map(connection => {
      const sources = settings.sources.filter(s => s.connectionId === connection.id);
      const path = sources[0]?.path ?? "";
      const result = tests[connection.id];
      return <fieldset key={connection.id} disabled={disabled} className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">SSH connection</legend>
        <label className="block text-xs">Connection name<input aria-label="SSH connection name" className="mt-1 w-full rounded border bg-background p-1 text-sm" value={connection.name} onChange={e => update(connection.id, { name: e.target.value })} /></label>
        <label className="block text-xs">SSH host or alias<input aria-label="SSH host" className="mt-1 w-full rounded border bg-background p-1 text-sm" placeholder="user@research-host" value={connection.host} onChange={e => update(connection.id, { host: e.target.value })} /></label>
        <details><summary className="cursor-pointer text-xs">Connection options</summary>
          <div className="mt-2 space-y-2">
            <label className="block text-xs">Transport<select aria-label="SSH transport" className="ml-2 rounded border bg-background p-1" value={connection.port == null ? "socket" : "websocket"} onChange={e => update(connection.id, { port: e.target.value === "socket" ? null : 4500, tokenFile: "" })}><option value="socket">Existing control socket</option><option value="websocket">Existing WebSocket listener</option></select></label>
            {connection.port == null ? <>
              <label className="block text-xs">Remote Codex executable<input aria-label="Remote Codex executable" className="mt-1 w-full rounded border bg-background p-1 text-sm" placeholder="codex (from remote PATH)" value={connection.executable} onChange={e => update(connection.id, { executable: e.target.value })} /></label>
              <label className="block text-xs">Remote control socket<input aria-label="Remote control socket" className="mt-1 w-full rounded border bg-background p-1 text-sm" placeholder="Default Codex control socket" value={connection.socket} onChange={e => update(connection.id, { socket: e.target.value })} /></label>
            </> : <>
              <label className="block text-xs">Remote loopback port<input aria-label="Remote loopback port" type="number" min={1} max={65535} className="ml-2 rounded border bg-background p-1 text-sm" value={connection.port} onChange={e => update(connection.id, { port: Number(e.target.value) })} /></label>
              <label className="block text-xs">Remote token file (optional)<input aria-label="Remote token file" className="mt-1 w-full rounded border bg-background p-1 text-sm" placeholder="/absolute/path/to/token" value={connection.tokenFile} onChange={e => update(connection.id, { tokenFile: e.target.value })} /></label>
            </>}
          </div>
        </details>
        {sources.map(source => <div key={source.id} className="space-y-1 border-t pt-2">
          <label className="block text-xs">Remote source name<input aria-label="Remote source name" className="mt-1 w-full rounded border bg-background p-1 text-sm" value={source.name} onChange={e => setSettings(old => ({ ...old, sources: old.sources.map(s => s.id === source.id ? { ...s, name: e.target.value } : s) }))} /></label>
          <label className="block text-xs">Remote directory<input aria-label="Remote directory" className="mt-1 w-full rounded border bg-background p-1 text-sm" placeholder="/absolute/path/to/data" value={source.path} onChange={e => setSettings(old => ({ ...old, sources: old.sources.map(s => s.id === source.id ? { ...s, path: e.target.value } : s) }))} /></label>
          <Button variant="ghost" onClick={() => setSettings(old => ({ ...old, sources: old.sources.filter(s => s.id !== source.id) }))}>Remove directory</Button>
        </div>)}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setSettings(old => ({ ...old, sources: [...old.sources, { id: crypto.randomUUID(), name: "Remote data", path: "", connectionId: connection.id }] }))}>Add remote directory</Button>
          <Button variant="outline" disabled={disabled || !!testing || !path || !connection.host} onClick={() => void test(connection, path)}>{testing === connection.id ? "Testing…" : "Test connection"}</Button>
          <Button variant="ghost" onClick={() => setSettings(old => ({ ...old, connections: old.connections?.filter(c => c.id !== connection.id), sources: old.sources.filter(s => s.connectionId !== connection.id) }))}>Remove connection</Button>
        </div>
        {result?.fingerprint === JSON.stringify([connection, path]) && <p role="status" className="break-words text-xs">{result.message}</p>}
      </fieldset>;
    })}
    <p className="text-xs text-muted-foreground">Linux and macOS remote hosts. Uses your SSH configuration and keys; Prism never starts or installs a remote server. If needed, connect the host in ChatGPT Settings → Connections first. Source protection is instruction-based: remote agents are told not to modify sources. Research runs in remote scratch directories.</p>
  </div>;
}
