import { matchSourceLine } from "@/lib/source-line-match";
import { useEffect, useReducer, useRef } from "react";
import { activeProposal, useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { proposals, type Proposal } from "@/lib/backend";
import type { SourceBox } from "@/lib/visual-review";

export interface ChatPdfBuild {
  bytes: number[];
  artifactId: string;
  locations: SourceBox[];
}
export interface ChatPdfArtifact {
  proposal: Proposal;
  main: string;
  build: ChatPdfBuild;
  bytes: Uint8Array;
}
const artifacts = new Map<string, ChatPdfArtifact>();
export function clearChatPdfCache() {
  artifacts.clear();
}

/** Kept separate from main-document PDFs and source state. */
export function useChatPdf(main: string | undefined) {
  const chat = useAgentChatStore();
  const project = useDocumentStore((s) => s.projectId);
  const proposal = activeProposal(chat);
  const p = proposal?.projectId === project ? proposal : undefined;
  const cache = useRef(artifacts);
  const jobs = useRef(
    new Map<
      string,
      {
        proposalId: string;
        generation: number;
        busy: boolean;
        error: string | null;
      }
    >(),
  );
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const key = JSON.stringify([
    project,
    p?.threadId ?? p?.chatId ?? chat.activeTabId,
    main,
  ]);
  const running = p && ["running", "repairing", "applying"].includes(p.state);
  const compile = async () => {
    if (!p || !main || jobs.current.get(key)?.busy) return;
    const job = {
      proposalId: p.id,
      generation: p.generation,
      busy: true,
      error: null as string | null,
    };
    jobs.current.set(key, job);
    refresh();
    try {
      const build = await proposals.operate<ChatPdfBuild>(p, "compile", {
        mainFile: main,
        side: "result",
      });
      const latest = useAgentChatStore
        .getState()
        .proposals.find((item) => item.id === p.id);
      if (
        useDocumentStore.getState().projectId !== project ||
        latest?.generation !== p.generation ||
        latest.state === "original"
      )
        return;
      cache.current.delete(key);
      cache.current.set(key, {
        proposal: p,
        main,
        build,
        bytes: new Uint8Array(build.bytes),
      });
      while (cache.current.size > 10)
        cache.current.delete(cache.current.keys().next().value!);
    } catch (e) {
      job.error = String(e);
    } finally {
      job.busy = false;
      refresh();
    }
  };
  const job = jobs.current.get(key);
  useEffect(() => {
    if (!p || running || !main) return;
    const cached = cache.current.get(key)?.proposal;
    if (cached?.id === p.id && cached.generation === p.generation) return;
    if (
      job?.proposalId === p.id &&
      job.generation === p.generation &&
      (job.busy || job.error)
    )
      return;
    void compile();
  }, [key, p?.id, p?.generation, running, job?.busy]);
  useEffect(() => {
    for (const [entry, artifact] of cache.current) {
      if (
        artifact.proposal.projectId !== project ||
        !chat.proposals.some(
          (p) =>
            p.id === artifact.proposal.id || p.parent === artifact.proposal.id,
        )
      )
        cache.current.delete(entry);
    }
  }, [project, chat.proposals]);
  const artifact = p ? cache.current.get(key) : undefined;
  const current =
    !!artifact &&
    artifact.proposal.id === p?.id &&
    artifact.proposal.generation === p?.generation;
  const label = artifact
    ? (chat.tabs.find((t) => t.id === chat.activeTabId)?.title ?? "Chat")
    : "Main document";
  return {
    proposal: p,
    artifact,
    current,
    label,
    key,
    compile,
    busy: !!job?.busy,
    error: job?.error ?? null,
  };
}

/** Conservative mapping: unchanged files only, checked against current editor contents. */
export async function safeChatSource(
  artifact: ChatPdfArtifact,
  box: SourceBox,
) {
  const project = useDocumentStore.getState().projectId;
  if (project !== artifact.proposal.projectId) return null;
  const result = await proposals.operate<{ bytes: number[] | null }>(
    artifact.proposal,
    "read",
    {
      path: box.file,
      side: "result",
    },
  );
  const state = useDocumentStore.getState();
  const file = state.files.find((f) => f.relativePath === box.file);
  if (
    state.projectId !== project ||
    !file ||
    !result.bytes ||
    file.content !== new TextDecoder().decode(new Uint8Array(result.bytes))
  )
    return null;
  return { file: box.file, line: box.line, column: 0 };
}

/** Outline headings may move between main source and the displayed proposal. */
export async function chatHeadingLocation(
  artifact: ChatPdfArtifact,
  request: { filePath: string; line: number; sourceLine: string; sourceContent?: string },
): Promise<SourceBox | null> {
  const project = useDocumentStore.getState().projectId;
  if (project !== artifact.proposal.projectId) return null;
  const result = await proposals.operate<{ bytes: number[] | null }>(
    artifact.proposal, "read", { path: request.filePath, side: "result" },
  );
  if (useDocumentStore.getState().projectId !== project || !result.bytes) return null;
  const lines = new TextDecoder().decode(new Uint8Array(result.bytes)).split("\n");
  const matches = lines.flatMap((line, i) =>
    line.trim() === request.sourceLine.trim() ? [i + 1] : []);
  // Ambiguous or changed headings must not jump to unrelated text.
  const line = request.sourceContent !== undefined ? matchSourceLine(request.sourceContent, new TextDecoder().decode(new Uint8Array(result.bytes)), request.line) : matches.length === 1 ? matches[0] : null;
  if (line === null) return null;
  const box = artifact.build.locations
    .filter((b) => b.file === request.filePath && (request.sourceContent !== undefined || (b.line >= line - 1 && b.line <= line + 2)))
    .sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line) ||
      a.page - b.page || a.y - b.y)[0];
  // A fresh object ensures repeated clicks on the same heading scroll again.
  return box ? { ...box } : null;
}
