import { createRoot } from "react-dom/client";
import "../../src/styles/globals.css";
import {
  useAgentChatStore,
  activeProposal,
  ensureAgentEvents,
} from "../../src/stores/agent-chat-store";
import { useDocumentStore } from "../../src/stores/document-store";
import { useSettingsStore } from "../../src/stores/settings-store";
import { proposals } from "../../src/lib/backend";
const completedBuilds: string[] = [];
let buildRequests = 0;
const callbacks = new Map<number, (value: unknown) => void>();
const listeners = new Map<string, number>();
async function call(command: string, args: Record<string, unknown> = {}) {
  if (["codex_sessions", "detect_editors"].includes(command)) return [];
  if (command === "codex_status")
    return {
      account: { requiresOpenaiAuth: false },
      models: { data: [] },
      version: "fixture",
    };
  if (command === "plugin:event|listen") {
    listeners.set(String(args.event), Number(args.handler));
    return 1;
  }
  const isProposalBuild = command === "project_service" && args.operation === "proposal_compile";
  if (isProposalBuild) buildRequests++;
  const response = await fetch("http://127.0.0.1:19372", {
    method: "POST",
    body: JSON.stringify({ command, args }),
  });
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  if (isProposalBuild) completedBuilds.push(String((args.args as any).proposalId));
  if (command === "compile_latex" || command === "load_existing_pdf")
    return new Uint8Array(result.value).buffer;
  return result.value;
}
(window as any).__TAURI_INTERNALS__ = {
  invoke: call,
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
  },
  transformCallback: (fn: any) => {
    const id = callbacks.size + 1;
    callbacks.set(id, fn);
    return id;
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};
const { WorkspaceLayout } = await import(
  "../../src/components/workspace/workspace-layout"
);
const { project, source } = await call("fixture");
useDocumentStore.setState({
  projectId: project.id,
  projectRoot: project.root,
  activeFileId: "main.tex",
  files: [
    {
      id: "main.tex",
      name: "main.tex",
      relativePath: "main.tex",
      ref: { projectId: project.id, path: "main.tex" },
      type: "tex",
      content: source,
      isDirty: false,
    },
  ],
  initialized: true,
});
useAgentChatStore.setState({
  projectId: project.id,
  activeProjectPath: project.root,
});
useSettingsStore.setState({ visualChangeReports: false, autoRecompile: false });
useDocumentStore
  .getState()
  .setPdfData(new Uint8Array(await call("fixture_pdf")), "main.tex");
await ensureAgentEvents();
setInterval(async () => {
  for (const event of await call("events"))
    callbacks.get(listeners.get(event.event)!)?.({ ...event, id: 1 });
}, 100);
function Harness() {
  return <WorkspaceLayout />;
}
createRoot(document.getElementById("root")!).render(<Harness />);
const wait = async (predicate: () => boolean) => {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("UI wait timed out: " + document.body.innerText);
};
const text = async () =>
  new TextDecoder().decode(
    new Uint8Array((await call("project_read", { path: "main.tex" })).bytes),
  );
(window as any).runSmoke = async () => {
  const send = async (name: string) => {
    const s = useAgentChatStore.getState();
    const id = s.activeTabId;
    await s.sendPrompt(name);
    return id;
  };
  await wait(() => !!document.querySelector(".mupdf-text-layer"));
  document.querySelector<HTMLButtonElement>('[aria-label="Code"]')?.click();
  await wait(() => !!document.querySelector(".cm-editor"));
  const editor = document.querySelector(".cm-editor");
  const a = await send("A");
  useAgentChatStore.getState().createTab();
  const b = await send("B");
  if (!(await text()).includes("Original passage"))
    throw new Error("Main changed during execution");
  if (
    useAgentChatStore.getState().proposals.filter((p) => p.state === "running")
      .length !== 2
  )
    throw new Error("Both chats must run concurrently");
  if (document.querySelector(".cm-editor") !== editor)
    throw new Error("Editor remounted");
  if (!document.querySelector(".mupdf-text-layer"))
    throw new Error("PDF hidden during agent turn");
  if (document.querySelector('[aria-label="Proposal source"]'))
    throw new Error("Proposal source view still present");
  await useAgentChatStore.getState().cancelExecution();
  useAgentChatStore.getState().setActiveTab(a);
  await useAgentChatStore.getState().cancelExecution();
  await wait(() =>
    useAgentChatStore.getState().proposals.every((p) => p.state !== "running"),
  );
  await wait(
    () =>
      !!document.querySelector(".mupdf-text-layer") &&
      Array.from(document.querySelectorAll(".mupdf-text-layer")).some(
        (el) =>
          !el.closest(".invisible") && el.textContent?.includes("A passage"),
      ),
  );
  // Both completed PDFs must already exist before visiting the inactive chat.
  await wait(() => new Set(completedBuilds).size === 2);
  const compiledBeforeSwitch = buildRequests;
  useAgentChatStore.getState().setActiveTab(b);
  await wait(
    () =>
      !!document.querySelector(".mupdf-text-layer") &&
      Array.from(document.querySelectorAll(".mupdf-text-layer")).some(
        (el) =>
          !el.closest(".invisible") && el.textContent?.includes("B passage"),
      ),
  );
  if (
    document.querySelector(".cm-editor") !== editor ||
    !document
      .querySelector(".cm-content")
      ?.textContent?.includes("Original passage")
  )
    throw new Error("Chat switching changed main source");
  if (buildRequests !== compiledBeforeSwitch) throw new Error("Switching tabs rebuilt an existing PDF");
  useSettingsStore.setState({ visualChangeReports: true });
  await wait(
    () => !!document.querySelector('[aria-label="Proposal visual report"] img'),
  );
  useSettingsStore.setState({ visualChangeReports: false });
  useAgentChatStore.getState().setActiveTab(a);
  await useAgentChatStore.getState().decideProposal("apply");
  useAgentChatStore.getState().setActiveTab(b);
  await useAgentChatStore.getState().decideProposal("apply");
  if (activeProposal(useAgentChatStore.getState())?.state !== "conflicts")
    throw new Error("Expected conflict");
  if (!(await text()).includes("A passage"))
    throw new Error("Conflict changed main");
  await useAgentChatStore.getState().decideProposal("repair");
  await useAgentChatStore.getState().cancelExecution();
  await wait(
    () => activeProposal(useAgentChatStore.getState())?.state === "interrupted",
  );
  await wait(
    () =>
      !!document.querySelector(".mupdf-text-layer") &&
      Array.from(document.querySelectorAll(".mupdf-text-layer")).some(
        (el) =>
          !el.closest(".invisible") &&
          el.textContent?.includes("Repaired A and B passage"),
      ),
  );
  await useAgentChatStore.getState().decideProposal("apply");
  if (!(await text()).includes("Repaired A and B passage"))
    throw new Error("Repair not applied");
  if ((await proposals.list(project.id)).length)
    throw new Error("Unresolved proposals remain");
  return {
    ok: true,
    steps:
      "two running chats → visible PDF → both background PDFs built before tab switch → cached independent chat PDFs → apply A → conflict B → agent repair → apply",
    history: await call("git_log"),
  };
};
