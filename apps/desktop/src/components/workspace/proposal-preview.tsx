import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { loadReviewBlocks } from "@/lib/review-diff-client";
import { Crop } from "./preview/visual-review-panel";
import type { SourceBox, Region } from "@/lib/visual-review";
import type { ChatPdfBuild as ProposalBuild } from "@/hooks/use-chat-pdf";
import { useEffect, useState } from "react";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { proposals, type Proposal } from "@/lib/backend";

export function PendingChatWork() {
  const pending = useAgentChatStore(s => s.proposals);
  if (!pending.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2 text-xs">
      <span>
        {pending.filter((p) => p.state !== "original").length}{" "}
        unresolved proposals
      </span>
      {pending
        .filter((p) => !p.threadId && p.chatId)
        .map((orphan) => (
          <button
            type="button"
            key={orphan.id}
            className="underline"
            onClick={() => {
              const id = orphan.chatId!;
              if (!useAgentChatStore.getState().tabs.some((t) => t.id === id))
                useAgentChatStore.setState((s) => ({
                  tabs: [
                    ...s.tabs,
                    {
                      ...s.tabs[0],
                      id,
                      title: "Recovered proposal",
                      sessionId: null,
                      isStreaming: false,
                      messages: [],
                    },
                  ],
                }));
              useAgentChatStore.getState().setActiveTab(id);
            }}
          >
            Recover interrupted chat
          </button>
        ))}
    </div>
  );
}

export function ProposalReport({
  proposal,
  main,
  result,
}: {
  proposal: Proposal;
  main: string;
  result: ProposalBuild;
}) {
  const [report, setReport] = useState<{
    before: number;
    after: number;
    cards: { path: string; before: Region[]; after: Region[] }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const opened: number[] = [];
    const client = getMupdfClient();
    setReport(null);
    setError(null);
    void (async () => {
      try {
        const base = await proposals.operate<ProposalBuild>(
          proposal,
          "compile",
          { mainFile: main, side: "base" },
        );
        if (abort.signal.aborted) return;
        const before = await client.openDocument(
          new Uint8Array(base.bytes).buffer,
        );
        opened.push(before);
        if (abort.signal.aborted) return;
        const after = await client.openDocument(
          new Uint8Array(result.bytes).buffer,
        );
        opened.push(after);
        if (abort.signal.aborted) return;
        const cards = [];
        for (const change of proposal.changes) {
          if (abort.signal.aborted) return;
          const blocks = change.binary
            ? []
            : await loadReviewBlocks(
                change.oldContent ?? "",
                change.newContent ?? "",
                abort.signal,
              );
          const locate = (locations: SourceBox[], side: "before" | "after") =>
            locations.filter(
              (b) =>
                b.file === change.path &&
                blocks.some((block) => {
                  const r = block[side];
                  return r && b.line >= r.start && b.line <= r.end;
                }),
            );
          cards.push({
            path: change.path,
            before: await client.reviewRegions(
              before,
              locate(base.locations, "before"),
              { signal: abort.signal },
            ),
            after: await client.reviewRegions(
              after,
              locate(result.locations, "after"),
              { signal: abort.signal },
            ),
          });
        }
        if (!abort.signal.aborted) setReport({ before, after, cards });
      } catch (e) {
        for (const id of opened.splice(0)) void client.closeDocument(id).catch(() => {});
        if (!abort.signal.aborted) setError(String(e));
      } finally {
        if (abort.signal.aborted)
          for (const id of opened.splice(0)) void client.closeDocument(id).catch(() => {});
      }
    })();
    return () => {
      abort.abort();
      for (const id of opened.splice(0)) void client.closeDocument(id).catch(() => {});
    };
  }, [proposal.id, proposal.generation, main, result]);
  return (
    <div
      role="region"
      aria-label="Proposal visual report"
      className="h-full w-[300px] max-w-full shrink-0 overflow-auto border-l p-2 text-xs"
    >
      <strong>Visual changes · immutable base → proposal</strong>
      {error ? (
        <p role="alert">{error}</p>
      ) : report ? (
        report.cards.map((card, i) => (
          <div key={i}>
            <p>{card.path}</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                {card.before.length
                  ? card.before.map((r, j) => (
                      <Crop key={j} doc={report.before} region={r} />
                    ))
                  : "No mapped baseline region"}
              </div>
              <div>
                {card.after.length
                  ? card.after.map((r, j) => (
                      <Crop key={j} doc={report.after} region={r} />
                    ))
                  : "No mapped result region"}
              </div>
            </div>
          </div>
        ))
      ) : (
        <p>Preparing visual report…</p>
      )}
    </div>
  );
}
