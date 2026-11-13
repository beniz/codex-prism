import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { updates, type UpdateStatus } from "@/lib/backend/updates";
import {
  useUpdateStore,
  startUpdateChecks,
  UPDATE_INTERVAL,
} from "@/stores/update-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
vi.mock("@/lib/backend/updates", () => ({
  updates: {
    check: vi.fn(),
    local: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    restartLocal: vi.fn(),
    progress: vi.fn(async () => vi.fn()),
  },
}));
const status: UpdateStatus = {
  runningVersion: "1.7.0",
  installation: "appimage",
  availableVersion: "1.8.0",
  installedVersion: null,
  notes: "A release",
  releaseUrl: "https://github.com/beniz/codex-prism/releases/tag/v1.8.0",
  canInstall: true,
  ready: false,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
  vi.clearAllMocks();
  useUpdateStore.setState({
    automatic: true,
    lastAttempt: 0,
    status: null,
    phase: "idle",
    error: null,
    open: false,
  });
  useDocumentStore.setState({
    files: [],
    isCompiling: false,
    pendingRecompile: false,
    isSaving: false,
  });
  useAgentChatStore.setState({
    tabs: [],
    proposals: [],
    activeProjectPath: null,
  });
  vi.mocked(updates.check).mockResolvedValue({ ...status });
  vi.mocked(updates.local).mockResolvedValue({
    ...status,
    availableVersion: null,
    canInstall: false,
  });
});
afterEach(() => vi.useRealTimers());
describe("application updates", () => {
  it("checks once on startup and once after 12 hours, including repeated focus", async () => {
    const stop = startUpdateChecks();
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.check).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL - 1);
    expect(updates.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(updates.check).toHaveBeenCalledTimes(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("manual checks bypass disabled automatic checks", async () => {
    useUpdateStore.setState({ automatic: false });
    const stop = startUpdateChecks();
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL * 2);
    expect(updates.check).not.toHaveBeenCalled();
    await useUpdateStore.getState().check(true);
    expect(updates.check).toHaveBeenCalledTimes(1);
    stop();
  });
  it("does not retry offline failures continuously", async () => {
    vi.mocked(updates.check).mockRejectedValue(new Error("offline"));
    const stop = startUpdateChecks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updates.check).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().error).toContain("offline");
    stop();
  });
  it("retains remote availability when Debian detects an installed upgrade", async () => {
    useUpdateStore.setState({ status: { ...status, installation: "deb" } });
    vi.mocked(updates.local).mockResolvedValue({
      ...status,
      installation: "deb",
      availableVersion: null,
      installedVersion: "1.8.0",
      canInstall: false,
    });
    await useUpdateStore.getState().inspectLocal(true);
    expect(useUpdateStore.getState().status).toMatchObject({
      availableVersion: "1.8.0",
      installedVersion: "1.8.0",
    });
  });
  it("rechecks before download and never installs a source build", async () => {
    vi.mocked(updates.check).mockResolvedValue({
      ...status,
      installation: "source",
      canInstall: false,
    });
    await useUpdateStore.getState().download();
    expect(updates.download).not.toHaveBeenCalled();
  });
  it("announces manual updates without downloading or restarting", async () => {
    vi.mocked(updates.check).mockResolvedValue({
      ...status,
      canInstall: false,
    });
    await useUpdateStore.getState().check(true);
    expect(useUpdateStore.getState().status?.availableVersion).toBe("1.8.0");
    await useUpdateStore.getState().download();
    await useUpdateStore.getState().install();
    expect(updates.download).not.toHaveBeenCalled();
    expect(updates.install).not.toHaveBeenCalled();
    expect(updates.restartLocal).not.toHaveBeenCalled();
  });
  it("blocks installation while another chat runs", async () => {
    useUpdateStore.setState({ status: { ...status, ready: true } });
    useAgentChatStore.setState({
      tabs: [{ id: "other", isStreaming: true } as never],
    });
    await useUpdateStore.getState().install();
    expect(updates.install).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().error).toContain("agent turns");
  });
  it("does not restart after failed saves", async () => {
    useUpdateStore.setState({ status: { ...status, ready: true } });
    const save = vi
      .spyOn(useDocumentStore.getState(), "saveAllFiles")
      .mockResolvedValue();
    useDocumentStore.setState({
      files: [{ id: "dirty", isDirty: true } as never],
    });
    await useUpdateStore.getState().install();
    expect(updates.install).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().error).toContain("Save failed");
    save.mockRestore();
  });
  it("keeps the downloaded update retryable on an installer error", async () => {
    useUpdateStore.setState({ status: { ...status, ready: true } });
    vi.mocked(updates.install).mockRejectedValue(
      new Error("permission denied"),
    );
    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState()).toMatchObject({
      phase: "idle",
      error: "Error: permission denied",
      status: { ready: true },
    });
  });
});

it("persists the active project and chat draft without accepting pending proposals", async () => {
  useUpdateStore.setState({ status: { ...status, ready: true } });
  useDocumentStore.setState({
    projectRoot: "/tmp/paper",
    activeFileId: "main",
    files: [{ id: "main", relativePath: "main.tex", isDirty: false } as never],
  });
  useAgentChatStore.setState({
    activeProjectPath: "/tmp/paper",
    projectId: "project",
    restoringChats: false,
    activeTabId: "chat",
    tabs: [
      {
        id: "chat",
        title: "Draft",
        sessionId: "session",
        draft: "Unsent prompt",
        mode: "default",
        isStreaming: false,
      } as never,
    ],
    proposals: [{ id: "proposal", state: "ready" } as never],
  });
  vi.mocked(updates.install).mockResolvedValue();
  await useUpdateStore.getState().install();
  expect(
    JSON.parse(localStorage.getItem("codex-prism-update-session")!),
  ).toEqual({ root: "/tmp/paper", file: "main.tex" });
  expect(
    JSON.parse(localStorage.getItem("prism-chat-tabs-v1:/tmp/paper")!).tabs[0]
      .draft,
  ).toBe("Unsent prompt");
  expect(useAgentChatStore.getState().proposals[0].state).toBe("ready");
});
