import { createRoot } from "react-dom/client";
import { useDocumentStore } from "../../src/stores/document-store";
import { useAgentChatStore } from "../../src/stores/agent-chat-store";
import { WorkspaceLayout } from "../../src/components/workspace/workspace-layout";
import { backend } from "../../src/lib/backend";
import { pdf } from "../pdf-pool-smoke/fixture";
import "../../src/styles/globals.css";

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
let callback = 0, reads = 0, active = 0, maximum = 0, compiles = 0;
(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++callback,
  invoke: async (command: string, args: any) => {
    if (command === "project_service") {
      if (args.operation === "load_existing_pdf") return [...new Uint8Array(pdf(2))];
      if (args.operation === "compile_latex") { compiles++; throw new Error("Unexpected compile"); }
      if (args.operation === "history_status") return {};
      if (args.operation === "settings_get") return { revision: 0, instructions: "", sources: [], connections: [] };
    }
    return [];
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
backend.projects.register = async root => ({ id: root, root, name: "Fixture" });
backend.files.list = async () => {
  await pause(200);
  return { folders: [], files: Array.from({ length: 250 }, (_, i) => ({
    path: i ? `chapter-${i}.tex` : "main.tex", size: 100, changeToken: "1",
  })) };
};
backend.files.read = async ({ path }) => {
  reads++; active++; maximum = Math.max(maximum, active);
  await pause(20); active--;
  return { bytes: [...new TextEncoder().encode(path === "main.tex" ? "\\documentclass{article}\nText" : "\\section{Example} Text")], revision: "1" };
};
useAgentChatStore.setState({ locked: true, activeProjectPath: "/fixture" });
function Harness() {
  const root = useDocumentStore(s => s.projectRoot);
  return <div style={{ height: "100vh" }}>{root ? <WorkspaceLayout /> : <button>Open project</button>}</div>;
}
createRoot(document.body).render(<Harness />);
(window as any).runSmoke = async () => {
  const start = performance.now();
  const task = useDocumentStore.getState().openProject("/fixture");
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const shellMs = Math.round(performance.now() - start);
  if (useDocumentStore.getState().initialized || !document.querySelector("[data-panel-group]"))
    throw new Error("Workspace did not appear before discovery");
  await task;
  const readyMs = Math.round(performance.now() - start);
  for (let i = 0; i < 200 && !document.querySelector("canvas"); i++) await pause(25);
  if (!document.querySelector("canvas") || compiles) throw new Error("Existing PDF not shown");
  const panel = document.querySelector<HTMLElement>('[data-panel-id="pdf-preview"]')!;
  const toggle = panel.querySelector<HTMLButtonElement>('button[aria-label="Paper view"]')!;
  const splitWidth = panel.clientWidth;
  toggle.click();
  await pause(100);
  if (panel.clientWidth !== panel.parentElement!.clientWidth || panel.clientWidth <= splitWidth)
    throw new Error("Paper view did not fill the workspace");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await pause(100);
  if (panel.clientWidth !== splitWidth || toggle.getAttribute("aria-pressed") !== "false" || compiles)
    throw new Error("Leaving paper view did not restore the split");
  const grip = document.querySelector<HTMLButtonElement>('[aria-label="Resize message input"]')!;
  const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message Codex"]')!;
  const composer = document.querySelector<HTMLElement>("[data-chat-composer]")!;
  for (let i = 0; i < 28; i++) {
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await new Promise(requestAnimationFrame);
  }
  const expanded = field.offsetHeight;
  document.querySelector<HTMLButtonElement>('button[title="Show LaTeX code"]')!.click();
  await pause(100);
  const split = field.offsetHeight;
  if (split >= expanded || composer.scrollHeight > composer.clientHeight + 1 ||
      composer.getBoundingClientRect().bottom > innerHeight + 1)
    throw new Error(`Composer did not fit the editor split: ${expanded} → ${split}, ${composer.scrollHeight}/${composer.clientHeight}`);
  document.querySelector<HTMLButtonElement>('button[title="Hide LaTeX code"]')!.click();
  await pause(100);
  if (field.offsetHeight !== expanded) throw new Error("Preferred composer height was lost");
  return { ok: true, shellMs, readyMs, reads, maximum, compiles, visibility: document.visibilityState };
};
