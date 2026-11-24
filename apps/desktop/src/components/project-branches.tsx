import { useEffect, useState } from "react";
import { GitBranchIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  collaboration,
  shareCheckpoint,
  useCollaborationLock,
  type PreparedProposal,
} from "@/lib/collaboration";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";

interface Branches {
  number?: number;
  active: string;
  head: string;
  branches: string[];
  connected: boolean;
  canPublish: boolean;
  pending?: Record<string, number>;
}
interface Remote {
  name: string;
  number?: number;
  sha: string;
}

export function ProjectBranches({ projectId }: { projectId: string }) {
  const current = useAgentChatStore((s) => s.checkoutBranch);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Branches | null>(null);
  const [remote, setRemote] = useState<Remote[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const show = () => {
      setError("");
      setOpen(true);
    };
    window.addEventListener("prism-project-branches", show);
    return () => window.removeEventListener("prism-project-branches", show);
  }, []);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setInfo(null);
    setSelected("");
    setRemote([]);
    collaboration<Branches>(projectId, "branch_list")
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [open, projectId]);
  useEffect(() => {
    let alive = true;
    async function reconcile() {
      if (!current || busy) return;
      try {
        const info = await collaboration<Branches>(projectId, "branch_list");
        const doc = useDocumentStore.getState();
        if (
          !alive ||
          !info.active ||
          info.active === current ||
          doc.projectId !== projectId ||
          !doc.projectRoot
        )
          return;
        if (
          doc.files.some((f) => f.isDirty) ||
          useAgentChatStore.getState().tabs.some((t) => t.isStreaming)
        ) {
          setOpen(true);
          setError(
            `Git changed branches. Return to ${current} before continuing with these edits.`,
          );
          return;
        }
        useAgentChatStore.setState({
          pendingAttachments: [],
          pendingInitialPrompt: null,
        });
        useAgentChatStore.getState().resetForProject(null);
        doc.closeProject();
        await doc.openProject(doc.projectRoot);
        if (useDocumentStore.getState().projectId !== projectId) return;
        useAgentChatStore.getState().resetForProject(doc.projectRoot);
      } catch {
        /* A connection is optional for local projects. */
      }
    }
    window.addEventListener("focus", reconcile);
    return () => {
      alive = false;
      window.removeEventListener("focus", reconcile);
    };
  }, [projectId, current, busy]);
  async function browse(pulls: boolean) {
    setBusy(true);
    setError("");
    try {
      setRemote(
        pulls
          ? (
              await collaboration<{ entries: Remote[] }>(
                projectId,
                "remote_work_pulls",
              )
            ).entries
          : await collaboration<Remote[]>(projectId, "remote_work_branches"),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function change(action: string, branch: string, entry?: Remote) {
    if (!info) return;
    if (current && current !== info.active) {
      setError(
        `The checkout changed outside Prism. Reopen the project or return to ${current} to save your edits.`,
      );
      return;
    }
    const doc = useDocumentStore.getState();
    if (doc.projectId !== projectId || !doc.projectRoot) return;
    if (doc.files.some((f) => f.isDirty) || doc.isCompiling) {
      setError(
        "Checkpoint unsaved edits and let the current build finish first.",
      );
      return;
    }
    setBusy(true);
    setError("");
    useCollaborationLock.setState({ projectId });
    try {
      const result = await collaboration<{
        changed: boolean;
        resolution?: PreparedProposal;
      }>(projectId, "branch_change", {
        action,
        name: branch,
        head: info.head,
        active: info.active,
        sha: entry?.sha,
        number: entry?.number,
      });
      if (useDocumentStore.getState().projectId !== projectId) return;
      if (result.resolution) {
        const agent = useAgentChatStore.getState();
        const chatId = agent.createTab();
        await collaboration(projectId, "attach", {
          proposalId: result.resolution.proposalId,
          chatId,
        });
        if (useDocumentStore.getState().projectId !== projectId) return;
        agent.setActiveTab(chatId);
        await agent.refreshReview();
        if (useDocumentStore.getState().projectId !== projectId) return;
        await agent.sendPrompt(result.resolution.prompt);
      } else if (action === "publish") {
        shareCheckpoint(projectId);
      } else if (result.changed) {
        useAgentChatStore.setState({
          pendingAttachments: [],
          pendingInitialPrompt: null,
        });
        useAgentChatStore.getState().resetForProject(null);
        useDocumentStore.getState().closeProject();
        await useDocumentStore.getState().openProject(doc.projectRoot);
        if (useDocumentStore.getState().projectId !== projectId) return;
        useAgentChatStore.getState().resetForProject(doc.projectRoot);
        useDocumentStore.getState().setPendingRecompile(true);
        if (action === "merge") shareCheckpoint(projectId);
      }
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      useCollaborationLock.setState({ projectId: null });
    }
  }

  const active = info?.active.replace(/^refs\/heads\//, "") ?? "";
  return (
    <>
      <button
        className="flex max-w-full items-center gap-1 rounded px-1 text-muted-foreground text-xs leading-4 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
        title={current ?? "Project branches"}
      >
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate">
          {current?.replace(/^refs\/heads\//, "") ?? "Branches"}
        </span>
      </button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Project branches</DialogTitle>
          </DialogHeader>
          {info && (
            <fieldset disabled={busy} className="space-y-3">
              <p>
                Working on <strong>{active}</strong>
                {info.number ? ` · PR #${info.number}` : ""}
              </p>
              <label>
                Local branch{" "}
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">Choose branch</option>
                  {info.branches
                    .filter((b) => b !== active)
                    .map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                </select>
              </label>
              {selected && info.pending?.[selected] ? (
                <p>
                  {selected} has {info.pending[selected]} pending proposal(s).
                  Merge includes committed changes only.
                </p>
              ) : null}
              {selected && (
                <div className="flex gap-2">
                  <Button onClick={() => void change("switch", selected)}>
                    Switch to {selected}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void change("merge", selected)}
                  >
                    Merge {selected} into {active}
                  </Button>
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  aria-label="New branch name"
                  value={name}
                  placeholder="New branch name"
                  onChange={(e) => setName(e.target.value)}
                />
                <Button
                  disabled={!name.trim()}
                  onClick={() => void change("create", name.trim())}
                >
                  Create branch
                </Button>
              </div>
              {info.connected && (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => void browse(false)}>
                    Remote branches
                  </Button>
                  <Button variant="outline" onClick={() => void browse(true)}>
                    Pull requests
                  </Button>
                </div>
              )}
              {info.connected && (
                <button
                  className="text-sm text-muted-foreground underline hover:text-foreground"
                  onClick={() => {
                    setOpen(false);
                    window.dispatchEvent(new CustomEvent("prism-browse-remote-work", {
                      detail: projectId,
                    }));
                  }}
                >
                  Preview remote work without switching branches
                </button>
              )}
              {info.number && (
                <Button
                  onClick={() =>
                    void change("update", active, {
                      number: info.number,
                      name: active,
                      sha: "",
                    })
                  }
                >
                  Update from PR #{info.number}
                </Button>
              )}
              {info.canPublish && (
                <Button onClick={() => void change("publish", active)}>
                  Publish branch {active}
                </Button>
              )}
              <div className="max-h-60 overflow-auto">
                {remote.map((e) => (
                  <button
                    className="block w-full p-1 text-left hover:bg-muted"
                    key={e.name}
                    onClick={() =>
                      void change(
                        e.number ? "pull" : "remote",
                        e.number ? `review/pr-${e.number}` : e.name,
                        e,
                      )
                    }
                  >
                    {e.name} · {e.sha.slice(0, 8)}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">Working…</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
