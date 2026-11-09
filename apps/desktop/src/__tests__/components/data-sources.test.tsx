import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DataSources } from "@/components/data-sources";
import { openSourceSettings } from "@/lib/data-sources";
vi.mock("@/lib/data-sources", () => ({
  getProjectSettings: vi.fn(async () => ({ sources: [{ id: "one", name: "Reachable", path: "/data/one" }, { id: "two", name: "Missing", path: "/data/two" }] })),
  getSourceStatus: vi.fn(async () => [{ id: "one", reachable: true, error: null }, { id: "two", reachable: false, error: "Directory does not exist" }]),
  openSourceSettings: vi.fn(),
}));
it("shows both reachable and unavailable sources with explanations and settings access", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<DataSources projectId="p" />));
    const missing = host.querySelector<HTMLButtonElement>('button[title^="/data/two"]')!;
    expect(missing.title).toContain("Directory does not exist");
    expect(missing.querySelector("span")!.className).toContain("bg-red-500");
    expect(host.querySelector('button[title^="/data/one"] span')!.className).toContain("bg-green-500");
    await act(async () => missing.click());
    expect(openSourceSettings).toHaveBeenCalledWith("p");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
