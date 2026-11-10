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

it("groups file sources into one row and reports partial availability", async () => {
  const { getProjectSettings, getSourceStatus } = await import("@/lib/data-sources");
  vi.mocked(getProjectSettings).mockResolvedValueOnce({ revision: 1, instructions: "", sources: [
    { id: "a", name: "Paper", kind: "file", path: "attachments/paper.pdf" },
    { id: "b", name: "Missing paper", kind: "file", path: "attachments/missing.pdf" },
  ] });
  vi.mocked(getSourceStatus).mockResolvedValueOnce([{ id: "a", reachable: true, error: null }, { id: "b", reachable: false, error: "Missing" }]);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<DataSources projectId="files" />));
    const row = [...host.querySelectorAll("button")].find(b => b.textContent === "Files · 2")!;
    expect(row.title).toBe("1 of 2 files available");
    expect(row.querySelector("span")!.className).toContain("bg-amber-500");
    expect(host.textContent).not.toContain("Missing paper");
    await act(async () => row.click());
    expect(openSourceSettings).toHaveBeenCalledWith("files");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
