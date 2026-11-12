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
  return { ok: true, shellMs, readyMs, reads, maximum, compiles, visibility: document.visibilityState };
};
