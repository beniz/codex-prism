import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EnvironmentOnboarding } from "@/components/environment-onboarding";
const { state } = vi.hoisted(() => ({
  state: { status: "ready", checkStatus: vi.fn(async () => {}) },
}));
vi.mock("@/stores/agent-setup-store", () => ({
  useAgentSetupStore: (select: any) => select(state),
}));
vi.mock("@/components/agent-setup", () => ({
  AgentSetup: () => <div>Codex connection</div>,
}));
vi.mock("@/stores/uv-setup-store", () => {
  throw new Error("Startup must not load Python setup");
});
it("requires no Python or skills checks to finish setup", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.status = "error";
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<EnvironmentOnboarding />));
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Done",
  )!;
  expect(button.disabled).toBe(true);
  state.status = "ready";
  await act(async () => root.render(<EnvironmentOnboarding />));
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  act(() => root.unmount());
});
