import { useEffect, useState } from "react";
import { backend } from "@/lib/backend";
import { useAgentSetupStore } from "@/stores/agent-setup-store";
import { useSettingsStore } from "@/stores/settings-store";

export function AgentSetup({
  onSaved,
  onCancel,
}: {
  variant?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const s = useAgentSetupStore();
  const autoReview = useSettingsStore((state) => state.autoReviewApprovals);
  const setAutoReview = useSettingsStore((state) => state.setAutoReviewApprovals);
  const [path, setPath] = useState("");
  useEffect(() => {
    void s.checkStatus();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void backend.agent
      .subscribe((e) => {
        if (
          e.method === "account/login/completed" ||
          e.method === "account/updated"
        )
          void s.checkStatus();
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return (
    <div className="space-y-3 p-4">
      <h3 className="font-semibold">Codex connection</h3>
      <p>
        {s.version ?? "Use your installed Codex CLI"} · {s.status}
      </p>
      <p className="text-sm text-muted-foreground">
        Uses your normal Codex account and configuration. Disconnect also signs
        the CLI out.
      </p>
      {s.error && (
        <p role="alert" className="text-destructive">
          {s.error}
        </p>
      )}
      {s.loginInfo && <p>{s.loginInfo}</p>}
      <div className="flex flex-wrap gap-3">
        <button onClick={() => void s.checkStatus()}>Refresh</button>
        <button onClick={() => void s.login()}>Sign in with ChatGPT</button>
        <button onClick={() => void s.login(true)}>Use device code</button>
        {s.status === "ready" && (
          <button onClick={() => void s.logout()}>Disconnect</button>
        )}
      </div>
      <label className="block">
        Approval handling
        <select
          className="block w-full rounded border bg-background p-2"
          value={autoReview ? "auto_review" : "user"}
          onChange={(event) => setAutoReview(event.target.value === "auto_review")}
          aria-describedby="codex-approval-help"
        >
          <option value="auto_review">Approve for me</option>
          <option value="user">Ask me</option>
        </select>
      </label>
      <p id="codex-approval-help" className="text-sm text-muted-foreground">
        Applies to the next turn in every project chat. With Approve for me,
        Codex reviews permission requests and can approve or deny them.
      </p>
      <label className="block">
        Codex executable (optional)
        <input
          className="block w-full rounded border p-2"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/path/to/codex"
        />
      </label>
      <button
        onClick={() =>
          void backend.agent
            .setPath(path)
            .then(() =>
              useAgentSetupStore.setState({
                error: null,
                loginInfo:
                  "Executable path saved. Restart codex-prism to apply it.",
              }),
            )
            .catch((e) => useAgentSetupStore.setState({ error: String(e) }))
        }
      >
        Save executable path
      </button>
      {onSaved && <button onClick={onSaved}>Done</button>}
      {onCancel && <button onClick={onCancel}>Close</button>}
    </div>
  );
}
