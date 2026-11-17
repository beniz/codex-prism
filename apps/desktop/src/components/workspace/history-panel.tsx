import { useEffect, useState } from "react";
import {
  CopyIcon,
  HistoryIcon,
  LoaderIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useHistoryStore, type SnapshotInfo } from "@/stores/history-store";
import { getCurrentPdfRootId, useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import {
  compileLatex,
  resolveCompileTarget,
  formatCompileError,
} from "@/lib/latex-compiler";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function HistoryPanel({ maxHeight }: { maxHeight?: string }) {
  const root = useDocumentStore((s) => s.projectRoot);
  const locked = useAgentChatStore((s) => s.locked);
  const history = useHistoryStore();
  const [dialog, setDialog] = useState<
    "checkpoint" | "restore" | "label" | null
  >(null);
  const [target, setTarget] = useState<SnapshotInfo | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDialog(null);
    setTarget(null);
    setError(null);
    if (!root) return;
    void useHistoryStore.getState().init(root);
    const refresh = () => void useHistoryStore.getState().loadSnapshots(root);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [root]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (useDocumentStore.getState().projectRoot === root) setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const saveBuffers = async () => {
    const doc = useDocumentStore.getState();
    if (doc.projectRoot !== root) throw new Error("Document changed");
    await doc.saveAllFiles();
    if (useDocumentStore.getState().files.some((f) => f.isDirty))
      throw new Error("Save failed. Resolve unsaved files first.");
  };
  const confirm = () =>
    run(async () => {
      if (!root) return;
      const operation = dialog;
      if (operation === "label" && target)
        await history.addLabel(root, target.id, description.trim());
      else {
        await saveBuffers();
        if (operation === "checkpoint") {
          const result = await history.createSnapshot(
            root,
            `docs(history): ${description.trim() || "save checkpoint"}`,
          );
          if (!result) toast.info("No new changes to checkpoint");
        } else if (operation === "restore" && target) {
          const doc = useDocumentStore.getState();
          const pdfRoot = getCurrentPdfRootId() ?? doc.activeFileId;
          await history.restoreSnapshot(root, target.id);
          if (useDocumentStore.getState().projectRoot !== root) return;
          history.stopReview();
          await doc.refreshFiles();
          const updated = useDocumentStore.getState();
          const compile = resolveCompileTarget(pdfRoot, updated.files);
          if (compile) {
            updated.setIsCompiling(true);
            try {
              const pdf = await compileLatex(root, compile.targetPath);
              if (useDocumentStore.getState().projectRoot === root)
                updated.setPdfData(pdf, compile.rootId);
            } catch (e) {
              if (useDocumentStore.getState().projectRoot === root)
                updated.setCompileError(formatCompileError(e), compile.rootId);
            } finally {
              if (useDocumentStore.getState().projectRoot === root)
                updated.setIsCompiling(false);
            }
          } else updated.setPdfData(null);
        }
      }
      setDialog(null);
    });
  if (!root)
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Open a document to view history.
      </p>
    );
  const blocked =
    locked || busy || history.isRestoring || !!history.status?.blockedReason;
  return (
    <div className={cn("flex flex-col", maxHeight || "h-full")}>
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <HistoryIcon className="size-4" />
          History
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || busy}
          onClick={() => {
            setDescription("");
            setDialog("checkpoint");
          }}
        >
          <PlusIcon className="size-3" />
          Save checkpoint
        </Button>
      </div>
      <div className="space-y-2 border-b px-3 py-2 text-xs">
        <label
          className="flex items-center gap-2"
          title="Applies to future turns. Commit subjects already use a shortened request. Full prompts added to the body become part of Git history and accompany remote pushes."
        >
          <input
            type="checkbox"
            checked={history.status?.includePrompt ?? false}
            disabled={busy || !history.status}
            onChange={(e) =>
              void run(() => history.setIncludePrompt(root, e.target.checked))
            }
          />
          Include full prompts in commit body
        </label>
        {history.status?.repositoryPath && (
          <button
            className="flex max-w-full items-center gap-1 text-muted-foreground hover:underline"
            title={history.status.repositoryPath}
            onClick={() =>
              void run(() =>
                navigator.clipboard.writeText(history.status!.repositoryPath),
              )
            }
          >
            <CopyIcon className="size-3" />
            Copy repository path
          </button>
        )}
        {history.status?.archivePath && (
          <p className="break-all text-muted-foreground">
            Previous private history preserved at {history.status.archivePath}
          </p>
        )}
        {(error ||
          history.error ||
          history.status?.warning ||
          history.status?.blockedReason) && (
          <div
            role="status"
            className="space-y-1 text-amber-700 dark:text-amber-400"
          >
            <p>
              {error ||
                history.error ||
                history.status?.warning ||
                history.status?.blockedReason}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || locked}
              onClick={() => void run(() => history.retry(root))}
            >
              Retry history
            </Button>
          </div>
        )}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            void history.loadMoreSnapshots(root);
        }}
      >
        {!history.snapshots.length && !history.isLoading && (
          <p className="p-4 text-xs text-muted-foreground">No commits yet</p>
        )}
        {history.snapshots.map((snap) => {
          const selected = history.selectedSnapshotId === snap.id;
          return (
            <div
              key={snap.id}
              className={cn(
                "border-b px-3 py-2 text-xs",
                selected && "bg-accent/50",
              )}
            >
              <button
                className="w-full text-left"
                aria-expanded={selected}
                onClick={() =>
                  history.selectSnapshot(selected ? null : snap.id)
                }
              >
                <p className="break-words font-medium">
                  {snap.message.split("\n")[0]}
                </p>
                <p className="mt-1 text-muted-foreground">
                  <span className="font-mono">{snap.id.slice(0, 8)}</span> ·{" "}
                  {new Date(snap.timestamp * 1000).toLocaleString()} ·{" "}
                  {snap.changed_files.length} files
                  {snap.author_name && (
                    <span title={snap.author_email}> · {snap.author_name}</span>
                  )}
                  {(snap.parent_ids?.length ?? 0) > 1 && " · Combined changes"}
                </p>
                {!!snap.labels.length && (
                  <p className="mt-1 text-amber-700 dark:text-amber-400">
                    {snap.labels.join(" · ")}
                  </p>
                )}
              </button>
              {selected && (
                <div className="mt-2 space-y-2">
                  <p className="break-words text-muted-foreground">
                    {snap.changed_files.join(", ") ||
                      "Initial repository state"}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void run(() => navigator.clipboard.writeText(snap.id))
                      }
                    >
                      <CopyIcon className="size-3" />
                      Copy SHA
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setTarget(snap);
                        setDescription("");
                        setDialog("label");
                      }}
                    >
                      Add label
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={blocked}
                      title={
                        locked
                          ? "Resolve pending agent changes first"
                          : (history.status?.blockedReason ?? undefined)
                      }
                      onClick={() => {
                        setTarget(snap);
                        setDialog("restore");
                      }}
                    >
                      <RotateCcwIcon className="size-3" />
                      Restore
                    </Button>
                  </div>
                  {snap.labels.map((label) => (
                    <button
                      key={label}
                      className="mr-2 text-muted-foreground hover:underline"
                      disabled={busy}
                      onClick={() =>
                        void run(() => history.removeLabel(root, label))
                      }
                    >
                      Remove label “{label}”
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {history.isLoading && (
          <div className="flex justify-center p-3">
            <LoaderIcon
              aria-label="Loading history"
              className="size-4 animate-spin"
            />
          </div>
        )}
      </div>
      {dialog !== null && (
        <Dialog
          open={true}
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {dialog === "restore"
                  ? "Restore this version?"
                  : dialog === "label"
                    ? "Add label"
                    : "Save checkpoint"}
              </DialogTitle>
            </DialogHeader>
            {dialog === "restore" ? (
              <p className="text-sm">
                Restore document files to {target?.id.slice(0, 8)}. Current
                edits will be saved in a recovery checkpoint first. Later
                commits remain in history.
              </p>
            ) : (
              <Input
                autoFocus
                value={description}
                placeholder={
                  dialog === "label"
                    ? "e.g. Submitted draft"
                    : "Description (optional)"
                }
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !busy &&
                    (dialog !== "label" || description.trim())
                  )
                    void confirm();
                }}
              />
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={
                  busy ||
                  (dialog === "label" && !description.trim()) ||
                  (dialog === "restore" && blocked)
                }
                onClick={() => void confirm()}
              >
                {busy ? "Working…" : dialog === "restore" ? "Restore" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
