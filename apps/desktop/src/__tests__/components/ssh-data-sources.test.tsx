import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SshDataSources } from "@/components/agent-chat/ssh-data-sources";
import { testRemoteSource, type ProjectSettings } from "@/lib/data-sources";
vi.mock("@/lib/data-sources", () => ({ testRemoteSource: vi.fn(async () => ({ reachable: true })) }));
it("configures multiple connections, tests a draft, and removes only its own directories", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let saved: ProjectSettings;
  function Harness() {
    const [settings, setSettings] = useState<ProjectSettings>({ revision: 0, instructions: "", sources: [{ id: "local", name: "Local", path: "/local" }] });
    saved = settings;
    return <SshDataSources projectId="project" settings={settings} setSettings={setSettings} disabled={false} />;
  }
  const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.textContent === name)!;
  async function edit(label: string, value: string) {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => button("Add SSH connection").click());
    await edit("SSH host", "research-host");
    await act(async () => button("Add remote directory").click());
    await edit("Remote directory", "/research/data");
    await act(async () => button("Test connection").click());
    expect(testRemoteSource).toHaveBeenCalledWith("project", expect.objectContaining({ host: "research-host" }), "/research/data");
    expect(host.textContent).toContain("directory is reachable");
    await edit("SSH host", "another-host");
    expect(host.textContent).not.toContain("directory is reachable");
    await act(async () => button("Add SSH connection").click());
    expect(saved!.connections).toHaveLength(2);
    await act(async () => button("Remove connection").click());
    expect(saved!.connections).toHaveLength(1);
    expect(saved!.sources).toEqual([{ id: "local", name: "Local", path: "/local" }]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
