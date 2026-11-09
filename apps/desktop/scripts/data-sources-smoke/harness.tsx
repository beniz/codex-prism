import { createRoot } from "react-dom/client";
import "../../src/styles/globals.css";
import type { ProjectSettings } from "../../src/lib/data-sources";
let settings: ProjectSettings = { revision: 0, instructions: "", sources: [] };
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  if (command !== "project_service") return [];
  if (args.operation === "settings_get") return structuredClone(settings);
  if (args.operation === "settings_set") { settings = { ...args.args, revision: settings.revision + 1 }; return structuredClone(settings); }
  if (args.operation === "source_test") return { reachable: true };
  if (args.operation === "sources_status") return settings.sources.map(s => ({ id: s.id, reachable: true, error: null }));
  throw new Error(`Unexpected operation ${args.operation}`);
} };
const { ProjectInstructions } = await import("../../src/components/agent-chat/project-instructions");
const { DataSources } = await import("../../src/components/data-sources");
createRoot(document.getElementById("root")!).render(<main className="w-80"><ProjectInstructions projectId="fixture" projectName="Research" /><DataSources projectId="fixture" /></main>);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function waitFor(test: () => boolean) { for (let n = 0; n < 100; n++) { if (test()) return; await pause(); } throw new Error("UI condition timed out"); }
async function click(label: string) { await waitFor(() => { try { return !button(label).disabled; } catch { return false; } }); button(label).click(); await pause(); }
function button(label: string) { const b = [...document.querySelectorAll("button")].find(b => b.textContent === label); if (!b) throw new Error(`Missing button: ${label}`); return b; }
async function edit(label: string, value: string) {
  await waitFor(() => !!document.querySelector(`input[aria-label="${label}"]`));
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
(window as any).runSmoke = async () => {
  await pause(); document.querySelector<HTMLButtonElement>('[aria-label="Project settings"]')!.click(); await pause();
  await click("Add SSH connection");
  await edit("SSH host", "fixture-host");
  await click("Add remote directory"); await edit("Remote directory", "/research/data");
  await click("Test connection");
  if (!document.body.innerText.includes("directory is reachable")) throw new Error("Draft test feedback missing");
  await click("Save");
  const source = document.querySelector<HTMLButtonElement>('button[title^="/research/data"]');
  if (!source?.querySelector(".bg-green-500")) throw new Error("Reachable SSH source not shown in sidebar");
  source.click(); await pause();
  if (document.querySelector<HTMLInputElement>('[aria-label="SSH host"]')?.value !== "fixture-host") throw new Error("Connection was not retained");
  await click("Remove connection"); await click("Save");
  if (settings.sources.length || settings.connections?.length) throw new Error("Connection removal left stale sources");
  return { ok: true, checks: ["project settings", "SSH connection and directory", "test feedback", "sidebar availability", "reopen", "remove"] };
};
