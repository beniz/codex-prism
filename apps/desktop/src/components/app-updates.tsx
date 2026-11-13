import { useChatPdfBusy } from "@/hooks/use-chat-pdf";
import { Download, RefreshCw } from "lucide-react";
import { useUpdateStore, updateBlocker } from "@/stores/update-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { openExternal } from "@/lib/backend/desktop-host";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function UpdateIndicator() {
  const status = useUpdateStore((s) => s.status);
  const setOpen = useUpdateStore((s) => s.setOpen);
  const version = status?.installedVersion || status?.availableVersion;
  if (!version) return null;
  const label = status?.installedVersion
    ? `Restart to use v${version}`
    : `Update available: v${version}`;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={label}
      title={label}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Download className="size-3.5" aria-hidden="true" />
    </button>
  );
}
export function UpdateSettings() {
  const state = useUpdateStore();
  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Application updates</span>
        <Button
          variant="outline"
          size="sm"
          disabled={state.phase !== "idle"}
          onClick={() => {
            state.setOpen(true);
            void state.check(true);
          }}
        >
          Check for updates
        </Button>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={state.automatic}
          onChange={(e) => state.setAutomatic(e.target.checked)}
        />
        Automatically check every 12 hours
      </label>
    </div>
  );
}
export function UpdateDialog() {
  const state = useUpdateStore();
  // Subscribe to readiness changes while the panel is open; native gate rechecks all projects.
  useAgentChatStore((s) => s.tabs.some((t) => t.isStreaming));
  useAgentChatStore((s) => s.proposals);
  useDocumentStore((s) => s.isCompiling);
  useDocumentStore((s) => s.isSaving);
  const status = state.status;
  const building = useChatPdfBusy();
  useDocumentStore((s) => s.pendingRecompile);
  useAgentChatStore((s) => s.restoringChats);
  const blocked = building ? "Wait for PDF builds to finish." : updateBlocker();
  const busy = state.phase !== "idle";
  const version = status?.installedVersion || status?.availableVersion;
  const external = (url: string) => {
    void openExternal(url).catch((error) =>
      useUpdateStore.setState({ error: String(error) }),
    );
  };
  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => {
        if (state.phase !== "installing") state.setOpen(open);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Application updates</DialogTitle>
          <DialogDescription>
            {status
              ? `Running codex-prism v${status.runningVersion}`
              : "Check for the latest codex-prism release."}
          </DialogDescription>
        </DialogHeader>
        {version && (
          <p className="font-medium">
            {status?.installedVersion ? "Installed" : "Available"}: v{version}
          </p>
        )}
        {status?.notes && (
          <div className="max-h-52 overflow-auto whitespace-pre-wrap text-muted-foreground text-sm">
            {status.notes}
          </div>
        )}
        {status?.availableVersion && (
          <Button variant="link" onClick={() => external(status.releaseUrl)}>
            {status.canInstall
              ? "Read release notes"
              : "Open release downloads"}
          </Button>
        )}
        {status?.installation === "deb" &&
          !status.installedVersion &&
          status.availableVersion && (
            <div className="space-y-2 text-sm">
              <p>
                Install the new .deb yourself. Download it from the release
                page, then run:
              </p>
              <pre className="overflow-auto rounded bg-muted p-2">
                {`sudo apt install ./codex-prism-${status.availableVersion}-linux-x86_64.deb`}
              </pre>
              <p>
                You can also use dpkg. If your administrator configured an APT
                repository, update through that repository. After installing,
                quit and relaunch the app.
              </p>
            </div>
          )}
        {status?.availableVersion && status.installation === "source" && (
          <p className="text-sm">
            Update your checkout after saving or committing local changes,
            follow the source build instructions, then relaunch. This app will
            not change your checkout.
          </p>
        )}
        {status?.availableVersion && status.installation === "source" && (
          <Button
            variant="outline"
            onClick={() =>
              external(
                "https://github.com/beniz/codex-prism/blob/main/README_AGENTS.md#build-from-source",
              )
            }
          >
            Source update instructions
          </Button>
        )}
        {status?.availableVersion &&
          !status.canInstall &&
          !["deb", "source"].includes(status.installation) && (
            <p className="text-sm">
              This installation cannot update itself. Install the appropriate
              package from the release page, then quit and relaunch the app.
            </p>
          )}
        {state.phase === "downloading" && (
          <p role="status">
            Downloading…{" "}
            {state.progress?.total
              ? `${Math.floor((100 * state.progress.received) / state.progress.total)}%`
              : ""}
          </p>
        )}
        {state.phase === "installing" && (
          <p role="status">Saving and installing… The app will restart.</p>
        )}
        {state.error && (
          <p role="alert" className="text-destructive text-sm">
            {state.error}
          </p>
        )}
        {blocked && (status?.ready || status?.installedVersion) && (
          <p className="text-muted-foreground text-sm">{blocked}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void state.inspectLocal(true);
              void state.check(true);
            }}
          >
            <RefreshCw className="size-4" />
            {state.phase === "checking" ? "Checking…" : "Check for updates"}
          </Button>
          {status?.installedVersion || status?.ready ? (
            <Button
              disabled={busy || !!blocked}
              onClick={() => void state.install()}
            >
              {status.installedVersion
                ? `Restart to use v${status.installedVersion}`
                : "Restart and update"}
            </Button>
          ) : status?.availableVersion && status.canInstall ? (
            <Button disabled={busy} onClick={() => void state.download()}>
              Download update
            </Button>
          ) : null}
        </div>
        {!version && status && !state.error && state.phase === "idle" && (
          <p className="text-muted-foreground text-sm">
            No newer release found in the last check.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
