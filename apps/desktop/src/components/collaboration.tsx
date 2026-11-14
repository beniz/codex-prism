import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import {
  UsersIcon,
  LinkIcon,
  RefreshCwIcon,
  HistoryIcon,
  XIcon,
  ClipboardCheckIcon,
  GitMergeIcon,
  FileTextIcon,
  FolderIcon,
  ChevronRightIcon,
  GitBranchIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useReviewList } from "@/hooks/use-review-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { open, openExternal } from "@/lib/backend/desktop-host";
import {
  collaboration,
  syncProject,
  type CollaborationStatus,
  type PreparedProposal,
} from "@/lib/collaboration";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useHistoryStore } from "@/stores/history-store";
import {
  useReviewFindingsStore,
  type ReviewFindings,
} from "@/stores/review-findings-store";
import { listen } from "@/lib/backend";
import { HistoryPanel } from "@/components/workspace/history-panel";

interface Profile {
  name?: string;
  email?: string;
  login?: string;
  id?: number;
  credentialWarning?: string;
  privateEmail?: boolean;
  emails?: { email: string; primary?: boolean; verified?: boolean }[];
}

function CollaborationRow({
  icon: Icon,
  children,
  className,
  ...props
}: ComponentProps<"button"> & { icon: LucideIcon }) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
    </button>
  );
}

export function ConnectSharedProject({
  projectId = null,
  connected,
  sidebar = false,
}: {
  sidebar?: boolean;
  projectId?: string | null;
  connected?: () => void;
}) {
  const formId = useId();
  const [visible, setVisible] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [destination, setDestination] = useState("");
  const [server, setServer] = useState("https://github.com");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [resolved, setResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [device, setDevice] = useState("");
  const [clientId, setClientId] = useState("");
  const [remember, setRemember] = useState(true);
  const [transport, setTransport] = useState("provided");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const run = async (fn: () => Promise<void>) => {
    const ticket = generation.current;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (ticket === generation.current) setError(String(e));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  const applyProfile = (profile: Profile) => {
    setName((previous) => previous || profile.name || profile.login || "");
    const choices = (profile.emails ?? [])
      .filter((e) => e.verified !== false)
      .map((e) => e.email);
    if (server === "https://github.com" && profile.id && profile.login)
      choices.unshift(
        `${profile.id}+${profile.login}@users.noreply.github.com`,
      );
    setEmails(choices);
    setEmail(
      (previous) =>
        previous ||
        (server === "https://github.com"
          ? choices[0]
          : profile.privateEmail
            ? ""
            : profile.email || choices[0]) ||
        "",
    );
    if (profile.privateEmail && server !== "https://github.com")
      toast.info(
        "Your account email is private. Choose the email to use for shared commits.",
      );
    if (profile.credentialWarning) toast.info(profile.credentialWarning);
    setToken("");
  };
  const identify = async (value: string) => {
    const ticket = generation.current;
    const profile = await collaboration<Profile>(null, "profile", {
      server,
      token: value,
      remember,
    });
    if (ticket === generation.current) applyProfile(profile);
  };
  const signIn = () =>
    run(async () => {
      const ticket = generation.current;
      const start = await collaboration<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        interval: number;
        expires_in: number;
      }>(null, "device_start");
      if (ticket !== generation.current) return;
      setDevice(`Enter ${start.user_code} in your browser`);
      await openExternal(start.verification_uri);
      let interval = Math.max(5, start.interval || 5);
      const expires = Date.now() + (start.expires_in || 900) * 1000;
      while (ticket === generation.current && Date.now() < expires) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        if (ticket !== generation.current) return;
        const result = await collaboration<{
          profile?: Profile;
          error?: string;
          error_description?: string;
        }>(null, "device_poll", { deviceCode: start.device_code, remember });
        if (ticket !== generation.current) return;
        if (result.profile) {
          applyProfile(result.profile);
          setDevice("");
          return;
        }
        if (result.error === "slow_down") interval += 5;
        else if (result.error !== "authorization_pending")
          throw new Error(
            result.error_description || result.error || "Sign-in failed",
          );
      }
      setDevice("");
      if (ticket === generation.current)
        throw new Error("Sign-in expired. Try again.");
    });
  const close = (value: boolean) => {
    setVisible(value);
    if (!value) {
      generation.current++;
      setBusy(false);
      setDevice("");
      setToken("");
      void collaboration(projectId, "cancel").catch(() => {});
      void collaboration(null, "cancel").catch(() => {});
    } else if (projectId) {
      const ticket = generation.current;
      setBusy(true);
      setError("");
      setResolved(false);
      void collaboration<CollaborationStatus>(projectId, "status")
        .then((s) => {
          if (ticket !== generation.current) return;
          setIsConnected(s.connected);
          setResolved(!!(s.connected && s.url && s.branch));
          if (s.url) {
            setUrl(s.url);
            try {
              setServer(new URL(s.url).origin);
            } catch {}
          }
          if (s.branch) setBranch(s.branch);
          if (s.name) setName(s.name);
          if (s.email) setEmail(s.email);
        })
        .catch((e) => {
          if (ticket === generation.current) setError(String(e));
        })
        .finally(() => {
          if (ticket === generation.current) setBusy(false);
        });
    }
  };
  return (
    <>
      {sidebar ? (
        <button
          type="button"
          className="flex h-full min-w-0 items-center justify-center gap-2 rounded-md px-2 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => close(true)}
          title="Shared project settings"
          aria-label="Open collaboration settings"
        >
          <UsersIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="truncate font-medium text-xs">Collaboration</span>
        </button>
      ) : (
        <Button size="sm" variant="outline" onClick={() => close(true)}>
          Connect shared project
        </Button>
      )}
      <Dialog open={visible} onOpenChange={close}>
        <DialogContent className="max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              {projectId ? "Shared project settings" : "Connect shared project"}
            </DialogTitle>
            <DialogDescription>
              {isConnected
                ? "Manage the connected repository, branch, credentials, and contributor identity. Saved checkpoints and accepted changes are shared automatically."
                : "Connect a GitHub or Gitea repository. Saved checkpoints and accepted changes will be shared automatically."}
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={busy} className="contents">
            <label htmlFor={`${formId}-url`} className="space-y-1 text-sm">
              Repository or branch link
              <Input
                id={`${formId}-url`}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setBranch("");
                  setResolved(false);
                  try {
                    const parsed = new URL(e.target.value);
                    if (parsed.protocol === "https:") setServer(parsed.origin);
                  } catch {
                    /* SSH URLs preserve the selected API server. */
                  }
                }}
                placeholder="https://github.com/team/paper or git@host:team/paper.git"
              />
            </label>
            <label className="space-y-1 text-sm">
              Git transport
              <select
                className="w-full rounded border bg-background p-2"
                value={transport}
                onChange={(e) => {
                  setTransport(e.target.value);
                  setResolved(false);
                }}
              >
                <option value="provided">Use the supplied URL</option>
                <option value="ssh">SSH with existing keys</option>
              </select>
            </label>
            <details className="space-y-2 text-sm">
              <summary className="cursor-pointer">
                Sign in / credentials
              </summary>
              <label htmlFor={`${formId}-server`}>
                Hosting server
                <Input
                  id={`${formId}-server`}
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                />
              </label>
              {server === "https://github.com" && (
                <Button disabled={busy} onClick={signIn}>
                  Sign in with GitHub
                </Button>
              )}
              {server !== "https://github.com" && (
                <>
                  <label htmlFor={`${formId}-client`}>
                    Gitea public OAuth client ID (optional)
                    <Input
                      id={`${formId}-client`}
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </label>
                  <Button
                    disabled={busy || !clientId}
                    onClick={() =>
                      run(async () => {
                        const ticket = generation.current;
                        const start = await collaboration<{
                          state: string;
                          authorizationUrl: string;
                        }>(null, "oauth_start", { server, clientId });
                        if (ticket !== generation.current) return;
                        await openExternal(start.authorizationUrl);
                        const profile = await collaboration<Profile>(
                          null,
                          "oauth_finish",
                          { state: start.state, remember },
                        );
                        if (ticket === generation.current)
                          applyProfile(profile);
                      })
                    }
                  >
                    Sign in with Gitea
                  </Button>
                </>
              )}
              {device && <p role="status">{device}</p>}
              <label htmlFor={`${formId}-token`}>
                Access token
                <Input
                  id={`${formId}-token`}
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <Button
                disabled={busy || !token}
                onClick={() => run(() => identify(token))}
              >
                Use token and retrieve identity
              </Button>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember credentials in the system credential store
              </label>
              <p className="text-muted-foreground">
                SSH uses your existing keys and SSH agent. API sign-in supplies
                your identity independently. If native storage is unavailable,
                sign-in lasts for this session.
              </p>
            </details>
            <Button
              disabled={busy || !url}
              onClick={() =>
                run(async () => {
                  const ticket = generation.current;
                  const result = await collaboration<{
                    url: string;
                    branch: string;
                    branches: string[];
                  }>(projectId, "resolve", {
                    url,
                    branch: branch || undefined,
                    transport,
                  });
                  if (ticket !== generation.current) return;
                  setUrl(result.url);
                  setBranch(result.branch);
                  setBranches(result.branches);
                  setResolved(true);
                })
              }
            >
              Check repository
            </Button>
            {resolved && (
              <label htmlFor={`${formId}-branch`} className="space-y-1 text-sm">
                Shared branch
                <Input
                  id={`${formId}-branch`}
                  list={`${formId}-branches`}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
                <datalist id={`${formId}-branches`}>
                  {branches.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </label>
            )}
            {!projectId && (
              <label
                htmlFor={`${formId}-destination`}
                className="space-y-1 text-sm"
              >
                New local folder
                <div className="flex gap-2">
                  <Input
                    id={`${formId}-destination`}
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    onClick={() =>
                      run(async () => {
                        const parent = await open({
                          directory: true,
                          multiple: false,
                        });
                        if (typeof parent === "string")
                          setDestination(
                            `${parent.replace(/[\\/]$/, "")}/${
                              url
                                .split("/")
                                .pop()
                                ?.replace(/\.git$/, "") || "shared-project"
                            }`,
                          );
                      })
                    }
                  >
                    Choose parent
                  </Button>
                </div>
              </label>
            )}
            <label htmlFor={`${formId}-name`} className="space-y-1 text-sm">
              Your contributor name
              <Input
                id={`${formId}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label htmlFor={`${formId}-email`} className="space-y-1 text-sm">
              Commit email
              <Input
                id={`${formId}-email`}
                list={`${formId}-emails`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <datalist id={`${formId}-emails`}>
                {emails.map((e) => (
                  <option key={e} value={e} />
                ))}
              </datalist>
            </label>
            <p className="text-muted-foreground text-xs">
              This shares repository history, including existing files and
              commit messages. Your selected name and email will appear in new
              commits.
            </p>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <Button
              disabled={
                busy ||
                !resolved ||
                !name ||
                !email ||
                (!projectId && !destination)
              }
              onClick={() =>
                run(async () => {
                  const ticket = generation.current;
                  const result = await collaboration<{
                    project: { id: string; root: string };
                  }>(projectId, "connect", {
                    url,
                    branch,
                    destination,
                    name,
                    email,
                  });
                  if (ticket !== generation.current) return;
                  close(false);
                  connected?.();
                  if (!projectId)
                    await useDocumentStore
                      .getState()
                      .openProject(result.project.root);
                  else void syncProject(projectId).catch(() => {});
                })
              }
            >
              {busy ? "Working…" : isConnected ? "Save connection" : "Connect"}
            </Button>
            {isConnected && (
              <Button
                variant="outline"
                onClick={() =>
                  run(async () => {
                    await collaboration(projectId, "disconnect");
                    setIsConnected(false);
                    close(false);
                    connected?.();
                  })
                }
              >
                Disconnect
              </Button>
            )}
          </fieldset>
        </DialogContent>
      </Dialog>
    </>
  );
}

function resizeReviewInstructions(input: HTMLTextAreaElement | null) {
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
}

export function CollaborationPanel({ projectId }: { projectId: string }) {
  const reviewInstructionsId = useId();
  const [status, setStatus] = useState<CollaborationStatus>({
    connected: false,
  });
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [scope, setScope] = useState("");
  const findingsRequest = useRef(0);
  useEffect(() => {
    return () => {
      findingsRequest.current++;
    };
  }, [projectId]);
  const openFindings = async (
    findings: Omit<ReviewFindings, "report">,
    args: { proposalId: string } | { reviewId: string },
  ) => {
    const ticket = ++findingsRequest.current;
    const generation = useDocumentStore.getState().openingGeneration;
    const value = await collaboration<{ report: string }>(
      projectId,
      "report",
      args,
    );
    const doc = useDocumentStore.getState();
    if (
      ticket !== findingsRequest.current ||
      doc.projectId !== projectId ||
      doc.openingGeneration !== generation
    )
      return;
    useReviewFindingsStore
      .getState()
      .open(projectId, { ...findings, report: value.report });
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const proposals = useAgentChatStore((state) => state.proposals);
  const reviews = proposals.filter(
    (p) =>
      p.projectId === projectId &&
      p.origin === "reviewer" &&
      p.state !== "original",
  );
  const resolutions = proposals.filter(
    (p) =>
      p.projectId === projectId &&
      p.origin === "resolution" &&
      p.state !== "original",
  );
  const reviewRevision = reviews
    .map((p) => `${p.id}:${p.generation}:${p.state}`)
    .join("|");
  const reviewList = useReviewList(projectId, reviewRevision);
  const activeFindings = useReviewFindingsStore((state) =>
    state.projectId === projectId ? state.activeTab : null,
  );
  const entries = reviewList.reviews.map((review) => {
    const pending = reviews.find(
      (p) =>
        review.proposalId === p.id ||
        (!review.local && review.id === p.id && p.reviewSaved),
    );
    return {
      id: `${review.proposalId ? "proposal" : "review"}:${review.id}`,
      title: review.scope || "General scientific review",
      status:
        pending && !pending.reviewSaved
          ? ("pending" as const)
          : review.local
            ? ("local" as const)
            : ("saved" as const),
      reviewedCommit: review.reviewedCommit,
      ready: review.schemaVersion === 1,
      args: review.proposalId
        ? { proposalId: review.proposalId }
        : { reviewId: review.id },
    };
  });
  for (const p of reviews) {
    if (
      reviewList.reviews.some(
        (review) =>
          review.proposalId === p.id ||
          (!review.local && review.id === p.id && p.reviewSaved),
      )
    )
      continue;
    entries.push({
      id: `proposal:${p.id}`,
      title: "Manuscript review",
      status: p.reviewSaved ? "saved" : "pending",
      reviewedCommit: undefined,
      ready:
        !!p.hasReview ||
        p.changes.some((change) => change.path.endsWith("/report.md")),
      args: { proposalId: p.id },
    });
  }
  const locked = useAgentChatStore((s) => s.locked);
  const reload = () =>
    collaboration<CollaborationStatus>(projectId, "status")
      .then(setStatus)
      .catch(() => {});
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active)
        void collaboration<CollaborationStatus>(projectId, "status")
          .then((s) => {
            if (active) setStatus(s);
          })
          .catch(() => {});
    };
    const sync = () => {
      void syncProject(projectId, true)
        .catch(() => {})
        .finally(refresh);
    };
    refresh();
    sync();
    const subscription = listen<{ projectId: string }>(
      "project-collaboration",
      ({ payload }) => {
        if (payload.projectId === projectId) {
          refresh();
          reviewList.refresh();
        }
      },
    );
    window.addEventListener("focus", sync);
    window.addEventListener("prism-collaboration", refresh);
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
      window.removeEventListener("focus", sync);
      window.removeEventListener("prism-collaboration", refresh);
    };
  }, [projectId, reviewList.refresh]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
      void reload();
    }
  };
  return (
    <section
      className="mt-2 border-sidebar-border border-t text-xs"
      aria-label="Collaboration"
    >
      <div className="relative flex h-8 shrink-0 items-center justify-center gap-2 px-9">
        <ConnectSharedProject
          sidebar
          projectId={projectId}
          connected={reload}
        />
        <button
          type="button"
          className={cn(
            "absolute right-1 rounded-md p-1.5 hover:bg-sidebar-accent",
            status.busy
              ? "text-blue-600 dark:text-blue-400"
              : "text-muted-foreground hover:text-foreground disabled:opacity-50",
          )}
          title={
            status.busy
              ? "Synchronizing…"
              : status.connected
                ? "Sync now"
                : "Refresh reviews"
          }
          aria-label={
            status.busy
              ? "Synchronizing…"
              : status.connected
                ? "Sync now"
                : "Refresh reviews"
          }
          aria-busy={!!status.busy}
          disabled={busy || status.busy}
          onClick={() =>
            run(async () => {
              try {
                if (status.connected) {
                  const doc = useDocumentStore.getState();
                  if (!useAgentChatStore.getState().locked && doc.projectRoot) {
                    await doc.saveAllFiles();
                    if (
                      useDocumentStore.getState().files.some((f) => f.isDirty)
                    )
                      throw new Error("Some edits could not be saved");
                    await useHistoryStore
                      .getState()
                      .createSnapshot(
                        doc.projectRoot,
                        "docs(history): sync document",
                      );
                  }
                  await syncProject(projectId);
                }
              } finally {
                reviewList.refresh();
              }
            })
          }
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-0.5 px-1 pb-1.5">
        {status.connected && (
          <>
            <div
              className="flex min-w-0 items-center gap-2 px-2 py-1"
              role="status"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  status.warning || status.localEdits
                    ? "bg-amber-500"
                    : status.busy
                      ? "bg-muted-foreground"
                      : "bg-green-500",
                )}
              />
              <span
                className="truncate"
                title={
                  status.message ||
                  status.warning ||
                  status.localEdits ||
                  undefined
                }
              >
                {status.busy
                  ? "Synchronizing…"
                  : status.message ||
                    status.warning ||
                    status.localEdits ||
                    (status.behind
                      ? "Updates available"
                      : status.ahead
                        ? "Saved locally · waiting to share"
                        : "Up to date")}
              </span>
            </div>
            <div
              className="flex min-w-0 items-center gap-2 px-2 py-1 text-muted-foreground"
              title={
                status.checkedAt
                  ? `Checked ${new Date(status.checkedAt * 1000).toLocaleTimeString()}`
                  : undefined
              }
            >
              <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{status.branch}</span>
            </div>
          </>
        )}
        <div
          className="flex min-w-0 items-center gap-2 px-2 py-1 text-muted-foreground"
          title={
            status.connected
              ? `Connected to ${status.url || status.remote}`
              : "Open Collaboration settings to connect a shared project"
          }
        >
          <LinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {status.connected
              ? `Connected to ${status.url || status.remote}`
              : "Not connected"}
          </span>
        </div>
        {status.connected && (
          <>
            {status.busy && (
              <CollaborationRow
                icon={XIcon}
                onClick={() => void collaboration(projectId, "cancel")}
              >
                Cancel sync
              </CollaborationRow>
            )}
            <CollaborationRow
              icon={HistoryIcon}
              onClick={() => setHistoryOpen(true)}
            >
              View changes
            </CollaborationRow>
          </>
        )}
        <CollaborationRow
          icon={ClipboardCheckIcon}
          className="text-purple-700 dark:text-purple-300"
          disabled={busy || locked}
          onClick={() => setReviewOpen(true)}
        >
          Request review
        </CollaborationRow>
        {resolutions.map((p) => (
          <CollaborationRow
            key={p.id}
            icon={GitMergeIcon}
            disabled={busy || ["running", "repairing"].includes(p.state)}
            onClick={() =>
              run(async () => {
                const chats = useAgentChatStore.getState();
                const owner = chats.tabs.find(
                  (t) =>
                    t.id === p.chatId ||
                    (t.sessionId && t.sessionId === p.threadId),
                );
                if (owner) {
                  chats.setActiveTab(owner.id);
                  return;
                }
                const chatId = chats.createTab();
                await collaboration(projectId, "attach", {
                  proposalId: p.id,
                  chatId,
                });
                await useAgentChatStore.getState().refreshReview();
              })
            }
          >
            Review pending resolution
          </CollaborationRow>
        ))}
        <details className="group" open>
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded px-2 py-1 hover:bg-sidebar-accent [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3 shrink-0 group-open:rotate-90"
            />
            <FolderIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="ml-1">Reviews</span>
            <span className="ml-auto text-muted-foreground">
              {entries.length}
            </span>
          </summary>
          <ul
            className="max-h-56 space-y-0.5 overflow-y-auto"
            aria-label="Review findings"
          >
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  disabled={busy || !entry.ready}
                  aria-current={
                    activeFindings === entry.id ? "page" : undefined
                  }
                  aria-label={`Open review: ${entry.title} (${entry.status})`}
                  title={`${entry.title}${entry.reviewedCommit ? ` · Reviewed revision ${entry.reviewedCommit.slice(0, 8)}` : ""}${!entry.ready ? " · Findings unavailable yet or require a newer version" : ""}`}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded py-1 pr-2 pl-7 text-left hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                    activeFindings === entry.id && "bg-sidebar-accent",
                  )}
                  onClick={() =>
                    run(() =>
                      openFindings(
                        {
                          id: entry.id,
                          title: entry.title,
                          status: entry.status,
                          reviewedCommit: entry.reviewedCommit,
                        },
                        entry.args,
                      ),
                    )
                  }
                >
                  <FileTextIcon
                    className="size-3.5 shrink-0 text-purple-500"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {entry.title.replace(/\s+/g, " ")}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {entry.status === "saved"
                      ? "Saved"
                      : entry.status === "local"
                        ? "Local"
                        : entry.ready
                          ? "Pending"
                          : "Reviewing…"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {reviewList.loading && !entries.length && (
            <p className="py-1 pl-7 text-muted-foreground" role="status">
              Loading reviews…
            </p>
          )}
          {!reviewList.loading && !reviewList.error && !entries.length && (
            <p className="py-1 pl-7 text-muted-foreground">No reviews yet</p>
          )}
          {reviewList.error && (
            <CollaborationRow
              icon={RefreshCwIcon}
              title={reviewList.error}
              onClick={reviewList.refresh}
            >
              Could not load reviews · Retry
            </CollaborationRow>
          )}
        </details>
      </div>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Request review</DialogTitle>
            <DialogDescription>
              The reviewer will prepare findings and suggested edits on a local
              branch. Save the review independently, then keep selected document
              changes when ready.
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={reviewInstructionsId} className="font-medium text-sm">
            Review instructions (optional)
          </label>
          <Textarea
            id={reviewInstructionsId}
            ref={resizeReviewInstructions}
            rows={5}
            className="max-h-[45vh] min-h-32 resize-none overflow-y-auto [field-sizing:fixed]"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              resizeReviewInstructions(e.currentTarget);
            }}
            placeholder="Describe what the reviewer should focus on, any constraints, and the improvements you would like suggested…"
          />
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (
                  useDocumentStore.getState().files.some((file) => file.isDirty)
                )
                  throw new Error(
                    "Save the manuscript before requesting review",
                  );
                const chatId = useAgentChatStore.getState().createTab("review");
                const prepared = await collaboration<PreparedProposal>(
                  projectId,
                  "review_start",
                  { chatId, scope },
                );
                if (useDocumentStore.getState().projectId !== projectId) return;
                setReviewOpen(false);
                await useAgentChatStore.getState().refreshReview();
                if (useDocumentStore.getState().projectId !== projectId) return;
                useAgentChatStore.getState().setActiveTab(chatId);
                await useAgentChatStore.getState().sendPrompt(prepared.prompt);
              })
            }
          >
            Start review
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Shared document history</DialogTitle>
            <DialogDescription>
              Inspect accepted local and collaborator changes.
            </DialogDescription>
          </DialogHeader>
          <HistoryPanel />
        </DialogContent>
      </Dialog>
    </section>
  );
}
