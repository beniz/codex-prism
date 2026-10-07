import { useAgentChatStore } from "@/stores/agent-chat-store";
export function ProposedChangesPanel() {
  const s = useAgentChatStore();
  if (s.review.active || !s.review.changes.length) return null;
  return (
    <section className="max-h-72 overflow-auto border-t p-3">
      <h3>Review Codex changes</h3>
      <p className="text-xs">
        These edits are already on disk. Keep or undo each file to continue.
      </p>
      {s.review.changes.map((c) => (
        <details key={c.path} className="border-b p-2">
          <summary>
            {c.kind}: {c.path} {c.binary ? "(binary asset)" : ""}
          </summary>
          {!c.binary && (
            <div className="grid grid-cols-2 gap-2">
              <pre className="overflow-auto whitespace-pre-wrap text-xs">
                {c.oldContent ?? "(not present)"}
              </pre>
              <pre className="overflow-auto whitespace-pre-wrap text-xs">
                {c.newContent ?? "(deleted)"}
              </pre>
            </div>
          )}
          <button onClick={() => void s.resolveReview(c.path, false)}>
            Keep current
          </button>
          <button
            className="ml-4"
            onClick={() => void s.resolveReview(c.path, true)}
          >
            Undo
          </button>
        </details>
      ))}
    </section>
  );
}
