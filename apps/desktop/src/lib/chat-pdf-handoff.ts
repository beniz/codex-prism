import { create } from "zustand";
import type { Proposal, ProposalPdfBuild } from "@/lib/backend";

export interface ChatPdfArtifact {
  proposal: Proposal;
  main: string;
  build: ProposalPdfBuild;
  bytes: Uint8Array;
}

export const artifactKey = (p: Proposal, main: string) => JSON.stringify([p.projectId, p.id, main]);
export const artifacts = new Map<string, ChatPdfArtifact>();
const acceptedViewers = new WeakMap<Uint8Array, { proposalId: string; artifactId?: string }>();
export function acceptedViewer(bytes: Uint8Array | null) {
  return bytes ? acceptedViewers.get(bytes) : undefined;
}

// The review event can remove the proposal before Keep has published the main PDF.
const useHeldPdfs = create<{ entries: Map<string, ChatPdfArtifact> }>(() => ({ entries: new Map() }));
export function clearCachedChatPdfs() {
  artifacts.clear();
  useHeldPdfs.setState({ entries: new Map() });
}

const heldKey = (project: string, chat: string, main: string) => JSON.stringify([project, chat, main]);
export function useHeldPdf(project: string | null, chat: string, main?: string) {
  return useHeldPdfs(s => project && main ? s.entries.get(heldKey(project, chat, main)) : undefined);
}

export function holdReviewedPdfs(p: Proposal, chat: string) {
  const held = [...artifacts.values()].filter(a => a.proposal.projectId === p.projectId &&
    a.proposal.id === p.id && a.proposal.generation === p.generation);
  if (held.length) useHeldPdfs.setState(s => {
    const entries = new Map(s.entries);
    for (const a of held) entries.set(heldKey(p.projectId, chat, a.main), a);
    return { entries };
  });
  return {
    acceptedBytes(main: string, artifactId: string | undefined) {
      const a = held.find(item => item.main === main);
      if (!a || a.build.artifactId !== artifactId) return undefined;
      acceptedViewers.set(a.bytes, { proposalId: p.id, artifactId: a.build.artifactId });
      return a.bytes;
    },
    replacementBytes(main: string, pdf: Uint8Array) {
      if (held.some(a => a.main === main)) acceptedViewers.set(pdf, { proposalId: p.id });
      return pdf;
    },
    finish() {
      if (held.length) useHeldPdfs.setState(s => {
        const entries = new Map(s.entries);
        for (const a of held) {
          const key = heldKey(p.projectId, chat, a.main);
          if (entries.get(key) === a) entries.delete(key);
        }
        return { entries };
      });
    },
  };
}
