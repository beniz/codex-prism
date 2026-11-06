import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

export function ProjectInstructions({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
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
    void backend.projects.getInstructions(projectId).then(value => {
      if (job === generation.current) { setSaved(value); setText(value); }
    }).catch(e => { if (job === generation.current) setError(String(e)); })
      .finally(() => { if (job === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [projectId, open]);
  async function save() {
    const job = generation.current;
    setBusy(true);
    setError(null);
    try {
      const value = await backend.projects.setInstructions(projectId, text);
      if (job === generation.current) { setSaved(value); setOpen(false); }
    } catch (e) { if (job === generation.current) setError(String(e)); }
    finally { if (job === generation.current) setBusy(false); }
  }
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)} title="Project instructions">Project instructions{saved.trim() && <span aria-label="Instructions configured" className="size-1.5 rounded-full bg-amber-500" />}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Project instructions</DialogTitle><DialogDescription>Applies to all chats in this project from their next turn. Reference files must already be available in the project. Stored locally in Prism.</DialogDescription></DialogHeader>
        <textarea aria-label="Project instructions" className="min-h-48 w-full rounded-md border bg-background p-3 text-sm" disabled={loading || busy} value={text} onChange={e => setText(e.target.value)} placeholder="Base this presentation on references/paper-draft.pdf. Target a 20-minute research talk and distinguish validated results from proposed work." />
        <p className="text-xs text-muted-foreground">Save an empty value to clear instructions.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={loading || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
