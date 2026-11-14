import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@/lib/backend";
import { syncProject, useCollaborationLock } from "@/lib/collaboration";
import { resetActivities, useActivityStore } from "@/stores/activity-store";

const { document, chats } = vi.hoisted(() => ({
  document: {
    projectId: "",
    projectRoot: "/paper",
    files: [] as { isDirty: boolean }[],
    refreshFiles: vi.fn(),
    setPendingRecompile: vi.fn(),
  },
  chats: {
    createTab: vi.fn(() => "resolution-chat"),
    setActiveTab: vi.fn(),
    refreshReview: vi.fn(),
    sendPrompt: vi.fn(),
  },
}));
vi.mock("@/lib/backend", () => ({ invoke: vi.fn() }));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: () => document },
}));
vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: { getState: () => chats },
}));
let counter = 0;
beforeEach(() => {
  vi.clearAllMocks();
  resetActivities();
  document.projectId = `collaboration-${++counter}`;
  document.files = [{ isDirty: false }];
  useCollaborationLock.setState({ projectId: null });
  vi.mocked(invoke).mockImplementation(async (_command, args) =>
    args?.operation === "status" ? { connected: true } : { changed: false },
  );
});

it.each([
  false,
  true,
])("tracks background sync activity through completion or failure (failure: %s)", async (fails) => {
  let finish!: () => void;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    if (args?.operation === "status") return { connected: true };
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (fails) throw new Error("Network unavailable");
    return { changed: false };
  });
  const task = syncProject(document.projectId, true);
  const completion = fails
    ? expect(task).rejects.toThrow("Network unavailable")
    : expect(task).resolves.toBeUndefined();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(useActivityStore.getState().operations).toMatchObject([
    { projectPath: "/paper", kind: "syncing", projectWide: false },
  ]);
  finish();
  await completion;
  expect(useActivityStore.getState().operations).toEqual([]);
});

it("does not announce synchronization for a disconnected project", async () => {
  vi.mocked(invoke).mockResolvedValue({ connected: false });
  await syncProject(document.projectId, true);
  expect(useActivityStore.getState().operations).toEqual([]);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("does not checkpoint edits or compile unchanged input on a background check", async () => {
  await syncProject(document.projectId, true);
  expect(vi.mocked(invoke).mock.calls.map(([, a]) => a?.operation)).toEqual([
    "status",
    "sync",
  ]);
  expect(document.refreshFiles).not.toHaveBeenCalled();
  expect(document.setPendingRecompile).not.toHaveBeenCalled();
  await syncProject(document.projectId, true);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("freezes manual edits only during integration and refreshes before releasing the lock", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    if (args?.operation === "status") return { connected: true };
    if (args?.operation === "sync") {
      expect(useCollaborationLock.getState().projectId).toBeNull();
      return { needsApply: true };
    }
    expect(useCollaborationLock.getState().projectId).toBe(document.projectId);
    return { changed: true };
  });
  document.refreshFiles.mockImplementation(async () => {
    expect(useCollaborationLock.getState().projectId).toBe(document.projectId);
  });
  await syncProject(document.projectId);
  expect(document.refreshFiles).toHaveBeenCalledOnce();
  expect(document.setPendingRecompile).toHaveBeenCalledWith(true);
  expect(useCollaborationLock.getState().projectId).toBeNull();
  document.refreshFiles.mockReset();
});

it("rechecks edits made while fetching instead of applying over a dirty buffer", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    if (args?.operation === "status") return { connected: true };
    document.files[0].isDirty = true;
    return { needsApply: true };
  });
  await expect(syncProject(document.projectId)).rejects.toThrow(
    "save local edits",
  );
  expect(
    vi.mocked(invoke).mock.calls.some(([, a]) => a?.operation === "sync_apply"),
  ).toBe(false);
  expect(document.refreshFiles).not.toHaveBeenCalled();
});

it("releases the edit lock after an integration failure", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    if (args?.operation === "status") return { connected: true };
    if (args?.operation === "sync") return { needsApply: true };
    throw new Error("Concurrent external edit");
  });
  await expect(syncProject(document.projectId)).rejects.toThrow(
    "Concurrent external edit",
  );
  expect(useCollaborationLock.getState().projectId).toBeNull();
});

it("routes conflicts through an owned chat and the normal agent submission", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) =>
    args?.operation === "status"
      ? { connected: true }
      : args?.operation === "sync"
        ? {
            resolution: {
              proposalId: "merge",
              prompt: "Reconcile these versions",
            },
          }
        : null,
  );
  await syncProject(document.projectId);
  expect(invoke).toHaveBeenCalledWith("collaboration", {
    projectId: document.projectId,
    operation: "attach",
    args: { proposalId: "merge", chatId: "resolution-chat" },
  });
  expect(chats.sendPrompt).toHaveBeenCalledWith("Reconcile these versions");
});

it("does not apply a fetched update after switching documents", async () => {
  const previous = document.projectId;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    if (args?.operation === "status") return { connected: true };
    document.projectId = "another-project";
    return { needsApply: true };
  });
  await syncProject(previous);
  expect(document.refreshFiles).not.toHaveBeenCalled();
  expect(
    vi.mocked(invoke).mock.calls.some(([, a]) => a?.operation === "sync_apply"),
  ).toBe(false);
});

it("refreshes report-only changes without scheduling a TeX build", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) =>
    args?.operation === "status"
      ? { connected: true }
      : args?.operation === "sync"
        ? { needsApply: true }
        : { changed: true, sourceChanged: false },
  );
  await syncProject(document.projectId);
  expect(document.refreshFiles).toHaveBeenCalledOnce();
  expect(document.setPendingRecompile).not.toHaveBeenCalled();
});

it("does not submit a resolver into a different project after attaching", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    if (args?.operation === "status") return { connected: true };
    if (args?.operation === "sync")
      return { resolution: { proposalId: "merge", prompt: "Resolve" } };
    document.projectId = "different-project";
    return null;
  });
  await syncProject(document.projectId);
  expect(chats.sendPrompt).not.toHaveBeenCalled();
});
