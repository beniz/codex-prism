import type { Transaction } from "@codemirror/state";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCollaborationLock } from "@/lib/collaboration";

export const EDIT_BLOCKED_EVENT = "prism-editor-edit-blocked";

/** Reject only edits, preserving navigation, selection, copying and backend reloads. */
export function guardEditorTransaction(
  tr: Transaction,
  backendReload: boolean,
) {
  const projectId = useDocumentStore.getState().projectId;
  const locked =
    useAgentChatStore.getState().locked ||
    (projectId !== null &&
      useCollaborationLock.getState().projectId === projectId);
  if (tr.docChanged && !backendReload && locked) {
    window.dispatchEvent(new Event(EDIT_BLOCKED_EVENT));
    return [];
  }
  return tr;
}
