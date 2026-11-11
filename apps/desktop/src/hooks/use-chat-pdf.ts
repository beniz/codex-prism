import { useSettingsStore } from "@/stores/settings-store";
import { matchSourceLine } from "@/lib/source-line-match";
import { useEffect, useSyncExternalStore } from "react";
import { activeProposal, useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { proposals, type Proposal, type ProposalPdfBuild } from "@/lib/backend";
import type { SourceBox } from "@/lib/visual-review";

export type ChatPdfBuild = ProposalPdfBuild;
export interface ChatPdfArtifact {
  proposal: Proposal;
  main: string;
  build: ChatPdfBuild;
  bytes: Uint8Array;
}
// Shared by the workspace coordinator and every viewer, including across viewer remounts.
const artifacts = new Map<string, ChatPdfArtifact>();
type Job = { busy: boolean; error: string | null };
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
let revision = 0;
let epoch = 0;
let selectedKey: string | undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => revision;
function notify() { revision++; listeners.forEach((listener) => listener()); }
function useBuildRevision() { return useSyncExternalStore(subscribe, snapshot); }
const artifactKey = (p: Proposal, main: string) => JSON.stringify([p.projectId, p.id, main]);
const jobKey = (p: Proposal, main: string) => JSON.stringify([p.projectId, p.id, p.generation, main]);
const eligible = (p: Proposal) => ["ready", "conflicts", "interrupted"].includes(p.state);
export function clearChatPdfCache() {
  epoch++;
  artifacts.clear();
  jobs.clear();
  selectedKey = undefined;
  notify();
}

async function ensureBuild(p: Proposal, main: string, force = false, foreground = false) {
  const key = artifactKey(p, main);
  const target = jobKey(p, main);
  const existing = jobs.get(target);
  const cached = artifacts.get(key);
  if (existing?.busy) return;
  if (!force && (existing?.error || (cached?.proposal.generation === p.generation))) return;
  // Background scheduling runs once per generation. An evicted foreground PDF is loaded again.
  if (!force && existing && !foreground) return;
  const job: Job = { busy: true, error: null };
  const startedEpoch = epoch;
  const current = () => startedEpoch === epoch && jobs.get(target) === job &&
    useDocumentStore.getState().projectId === p.projectId &&
    useAgentChatStore.getState().proposals.some((item) =>
      item.id === p.id && item.generation === p.generation && eligible(item));
  jobs.set(target, job);
  notify();
  try {
    let build = force ? null : await proposals.loadBuild(p, main);
    if (!current()) return;
    if (!build) {
      build = await proposals.operate<ChatPdfBuild>(p, "compile", {
        mainFile: main,
        side: "result",
        incremental: useSettingsStore.getState().incrementalCompilation,
      });
    }
    if (!current()) return;
    artifacts.delete(key);
    artifacts.set(key, { proposal: p, main, build, bytes: new Uint8Array(build.bytes) });
    while (artifacts.size > 10) {
      const victim = [...artifacts.keys()].find((entry) => entry !== selectedKey);
      if (!victim) break;
      artifacts.delete(victim);
    }
  } catch (e) {
    if (current()) job.error = String(e);
  } finally {
    job.busy = false;
    if (startedEpoch === epoch) notify();
  }
}

/** Mounted at workspace level: closing the PDF pane or selecting another tab does not stop builds. */
export function useChatPdfBuilds(main: string | undefined) {
  const chat = useAgentChatStore();
  const project = useDocumentStore((s) => s.projectId);
  useEffect(() => {
    for (const [key, artifact] of artifacts) {
      if (artifact.proposal.projectId !== project || !chat.proposals.some((p) =>
        p.id === artifact.proposal.id || p.parent === artifact.proposal.id)) artifacts.delete(key);
    }
    for (const key of jobs.keys()) {
      const [owner, id, generation] = JSON.parse(key) as [string, string, number];
      if (owner !== project || !chat.proposals.some((p) => p.id === id && p.generation === generation)) jobs.delete(key);
    }
    if (!main) return;
    for (const p of chat.proposals) {
      if (p.projectId === project && eligible(p) && p.changes.length > 0) void ensureBuild(p, main);
    }
  }, [project, main, chat.proposals]);
}

/** Selects one chat's PDF without owning background compilation. */
export function useChatPdf(main: string | undefined) {
  const chat = useAgentChatStore();
  const project = useDocumentStore((s) => s.projectId);
  const proposal = activeProposal(chat);
  const p = proposal?.projectId === project ? proposal : undefined;
  const version = useBuildRevision();
  const key = p && main ? artifactKey(p, main) : undefined;
  const job = p && main ? jobs.get(jobKey(p, main)) : undefined;
  useEffect(() => {
    selectedKey = key;
    if (key) {
      const cached = artifacts.get(key);
      if (cached) { artifacts.delete(key); artifacts.set(key, cached); }
    }
    if (p && main && eligible(p) && p.changes.length > 0) void ensureBuild(p, main, false, true);
  }, [key, p?.generation, p?.state, version]);
  const artifact = (key ? artifacts.get(key) : undefined) ??
    (p?.parent && main ? artifacts.get(artifactKey({ ...p, id: p.parent }, main)) : undefined);
  const current = !!artifact && artifact.proposal.id === p?.id && artifact.proposal.generation === p?.generation;
  const label = artifact ? (chat.tabs.find((t) => t.id === chat.activeTabId)?.title ?? "Chat") : "Main document";
  return {
    proposal: p, artifact, current, label, key,
    compile: () => p && main && eligible(p) ? ensureBuild(p, main, true, true) : Promise.resolve(),
    busy: !!job?.busy, error: job?.error ?? null,
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
