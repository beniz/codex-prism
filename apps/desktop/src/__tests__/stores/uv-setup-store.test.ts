import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@/lib/backend";
import { useUvSetupStore } from "@/stores/uv-setup-store";
vi.mock("@/lib/backend", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it("inspects an existing environment without provisioning it", async () => {
  vi.mocked(invoke).mockResolvedValue({
    venv_path: "/paper/.venv",
    python_path: "/paper/.venv/bin/python",
    created: false,
  });
  await useUvSetupStore.getState().inspectVenv("/paper");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("project_venv_status", {
    projectPath: "/paper",
  });
  expect(useUvSetupStore.getState().venvReady).toBe(true);
  vi.mocked(invoke).mockResolvedValue(null);
  await useUvSetupStore.getState().inspectVenv("/another");
  expect(useUvSetupStore.getState().venvReady).toBe(false);
  expect(useUvSetupStore.getState().pythonPath).toBeNull();
});
it("only provisions an environment on explicit setup", async () => {
  vi.mocked(invoke).mockResolvedValue({
    venv_path: "/paper/.venv",
    python_path: "/paper/.venv/bin/python",
    created: true,
  });
  await useUvSetupStore.getState().setupVenv("/paper");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("setup_project_venv", {
    projectPath: "/paper",
  });
});
