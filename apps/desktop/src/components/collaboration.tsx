import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
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

export function ConnectSharedProject({
  projectId = null,
  connected,
}: {
  projectId?: string | null;
  connected?: () => void;
}) {
  const formId = useId();
  const [visible, setVisible] = useState(false);
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
      void collaboration<CollaborationStatus>(projectId, "status")
        .then((s) => {
          if (ticket !== generation.current) return;
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
        });
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => close(true)}>
        Connect shared project
      </Button>
      <Dialog open={visible} onOpenChange={close}>
        <DialogContent className="max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Connect shared project</DialogTitle>
            <DialogDescription>
              Connect a GitHub or Gitea repository. Saved checkpoints and
              accepted changes will be shared automatically.
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
              {busy ? "Working…" : "Connect"}
            </Button>
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
    setSavedReviews(null);
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedReviews, setSavedReviews] = useState<
    | {
        id: string;
        scope?: string;
        reviewedCommit?: string;
        schemaVersion: number;
        proposalId?: string;
        local?: boolean;
      }[]
    | null
  >(null);
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
        if (payload.projectId === projectId) refresh();
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
  }, [projectId]);
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
  const proposals = useAgentChatStore((s) => s.proposals);
  const reviews = proposals.filter((p) => p.origin === "reviewer");
  const resolutions = proposals.filter((p) => p.origin === "resolution");
  return (
    <div className="space-y-2 border-t px-3 py-3 text-xs">
      <div className="font-medium">Collaboration</div>
      {!status.connected ? (
        <ConnectSharedProject projectId={projectId} connected={reload} />
      ) : (
        <>
          <p role="status">
            {busy || status.busy
              ? "Synchronizing…"
              : status.message ||
                status.warning ||
                status.localEdits ||
                (status.behind
                  ? "Updates available"
                  : status.ahead
                    ? "Saved locally · waiting to share"
                    : "Up to date")}
          </p>
          <p className="text-muted-foreground">
            {status.branch}
            {status.checkedAt
              ? ` · checked ${new Date(status.checkedAt * 1000).toLocaleTimeString()}`
              : ""}
          </p>
          <div className="flex flex-wrap gap-1">
            <ConnectSharedProject projectId={projectId} connected={reload} />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(async () => {
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
                })
              }
            >
              Sync now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void collaboration(projectId, "cancel")}
            >
              Cancel sync
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setHistoryOpen(true)}
            >
              View changes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await collaboration(projectId, "disconnect");
                })
              }
            >
              Disconnect
            </Button>
          </div>
        </>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || locked}
        onClick={() => setReviewOpen(true)}
      >
        Request review
      </Button>
      {resolutions.map((p) => (
        <Button
          key={p.id}
          size="sm"
          variant="outline"
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
        </Button>
      ))}
      {reviews.map((p) => (
        <Button
          key={p.id}
          size="sm"
          variant="ghost"
          onClick={() =>
            run(async () => {
              const path = p.changes.find((c) =>
                c.path.endsWith("/report.md"),
              )?.path;
              if (p.hasReview || path)
                await openFindings(
                  {
                    id: `proposal:${p.id}`,
                    title: p.reviewSaved ? "Saved review" : "Pending review",
                    status: p.reviewSaved ? "saved" : "pending",
                  },
                  { proposalId: p.id },
                );
              else toast.info("The reviewer has not written findings yet.");
            })
          }
        >
          View reviewer findings
        </Button>
      ))}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const saved = await collaboration<NonNullable<typeof savedReviews>>(
              projectId,
              "reviews",
            );
            if (useDocumentStore.getState().projectId === projectId)
              setSavedReviews(saved);
          })
        }
      >
        View saved reviews
      </Button>
      <Dialog
        open={savedReviews !== null}
        onOpenChange={(v) => {
          if (!v) setSavedReviews(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Saved reviews</DialogTitle>
            <DialogDescription>
              Saved findings and locally retained reviews, including discarded
              suggestions.
            </DialogDescription>
          </DialogHeader>
          {savedReviews?.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No review findings yet. Completed findings are retained here even
              if you discard suggested document changes.
            </p>
          )}
          {savedReviews?.map((review) => (
            <Button
              key={`${review.proposalId ? "local" : "saved"}:${review.id}`}
              variant="outline"
              disabled={busy || review.schemaVersion !== 1}
              onClick={() =>
                run(() =>
                  openFindings(
                    {
                      id: `${review.proposalId ? "proposal" : "review"}:${review.id}`,
                      title: review.scope || "General scientific review",
                      status: review.local ? "local" : "saved",
                      reviewedCommit: review.reviewedCommit,
                    },
                    review.proposalId
                      ? { proposalId: review.proposalId }
                      : { reviewId: review.id },
                  ),
                )
              }
            >
              {review.schemaVersion === 1
                ? review.scope || "General scientific review"
                : "Review from a newer version"}{" "}
              · {review.reviewedCommit?.slice(0, 8)}
              {review.local ? " · Local" : ""}
            </Button>
          ))}
        </DialogContent>
      </Dialog>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Request review</DialogTitle>
            <DialogDescription>
              The reviewer will prepare findings and suggested edits on a local
              branch. Keep accepts them into your manuscript.
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
    </div>
  );
}
