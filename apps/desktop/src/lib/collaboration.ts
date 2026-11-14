import { invoke } from "@/lib/backend";
import { create } from "zustand";
import { toast } from "sonner";
import { beginActivity } from "@/stores/activity-store";

export const useCollaborationLock = create<{ projectId: string | null }>(
  () => ({ projectId: null }),
);

export interface CollaborationStatus {
  connected: boolean;
  name?: string;
  email?: string;
  remote?: string;
  url?: string;
  branch?: string;
  checkedAt?: number;
  message?: string | null;
  warning?: string | null;
  localEdits?: string | null;
  busy?: boolean;
  ahead?: number;
  behind?: number;
}
export interface PreparedProposal {
  proposalId: string;
  prompt: string;
}
export function collaboration<T = unknown>(
  projectId: string | null,
  operation: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return invoke("collaboration", { projectId, operation, args });
}

const running = new Map<string, Promise<void>>();
const queued = new Set<string>();
const lastCheck = new Map<string, number>();
export async function syncProject(
  projectId: string,
  background = false,
): Promise<void> {
  if (running.has(projectId)) {
    if (!background) queued.add(projectId);
    return running.get(projectId);
  }
  if (background && Date.now() - (lastCheck.get(projectId) ?? 0) < 60_000)
    return;
  let activity: ReturnType<typeof beginActivity> | undefined;
  const task = (async () => {
    const status = await collaboration<CollaborationStatus>(
      projectId,
      "status",
    );
    if (!status.connected) return;
    lastCheck.set(projectId, Date.now());
    const { useDocumentStore } = await import("@/stores/document-store");
    const doc = useDocumentStore.getState();
    if (doc.projectId === projectId && doc.projectRoot)
      activity = beginActivity({ projectPath: doc.projectRoot }, "syncing");
    type SyncResult = CollaborationStatus & {
      resolution?: PreparedProposal;
      changed?: boolean;
      sourceChanged?: boolean;
      needsApply?: boolean;
    };
    let result = await collaboration<SyncResult>(projectId, "sync", {
      prepareOnly: true,
      deferApply:
        doc.projectId === projectId && doc.files.some((f) => f.isDirty),
    });
    if (useDocumentStore.getState().projectId !== projectId) return;
    if (result.needsApply) {
      const latest = useDocumentStore.getState();
      if (latest.files.some((f) => f.isDirty))
        throw new Error(
          "Updates available; save local edits before integrating",
        );
      useCollaborationLock.setState({ projectId });
      try {
        result = await collaboration<SyncResult>(projectId, "sync_apply");
        if (
          result.changed &&
          useDocumentStore.getState().projectId === projectId
        )
          await useDocumentStore.getState().refreshFiles();
      } finally {
        useCollaborationLock.setState({ projectId: null });
      }
    }
    activity?.finish();
    if (useDocumentStore.getState().projectId !== projectId) return;
    if (result.resolution) {
      const { useAgentChatStore } = await import("@/stores/agent-chat-store");
      const chatId = useAgentChatStore.getState().createTab();
      await collaboration(projectId, "attach", {
        proposalId: result.resolution.proposalId,
        chatId,
      });
      if (useDocumentStore.getState().projectId !== projectId) return;
      await useAgentChatStore.getState().refreshReview();
      if (useDocumentStore.getState().projectId !== projectId) return;
      useAgentChatStore.getState().setActiveTab(chatId);
      await useAgentChatStore.getState().sendPrompt(result.resolution.prompt);
    } else if (result.changed && result.sourceChanged !== false) {
      // Incoming files were refreshed while manual edits were frozen.
      // The existing compilation hook owns build selection and preserves the
      // visible PDF while rebuilding changed inputs.
      if (useDocumentStore.getState().projectId === projectId)
        useDocumentStore.getState().setPendingRecompile(true);
      toast.info(
        "Collaborator changes received. Use View changes to inspect them.",
      );
    }
  })();
  running.set(projectId, task);
  try {
    await task;
  } finally {
    activity?.finish();
    running.delete(projectId);
    window.dispatchEvent(
      new CustomEvent("prism-collaboration", { detail: projectId }),
    );
    if (queued.delete(projectId)) shareCheckpoint(projectId);
  }
}

export function shareCheckpoint(projectId: string | null) {
  if (projectId)
    void syncProject(projectId).catch(() => {
      /* Status retains the actionable error. */
    });
}
