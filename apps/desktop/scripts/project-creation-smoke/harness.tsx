// Real creation components and shared workflow; disposable in-memory host boundary.
import { createRoot } from "react-dom/client";
import "../../src/styles/globals.css";
import { backend } from "../../src/lib/backend";
import { useProjectStore } from "../../src/stores/project-store";
import { useDocumentStore } from "../../src/stores/document-store";
import { useTemplateStore } from "../../src/stores/template-store";
import { privateTemplateItem } from "../../src/lib/template-catalog";
const disk = new Map<string, string>();
let settings: any = { revision: 0, instructions: "", sources: [], connections: [] };
let opened = "";
let copies = 0;
let failImport = false;
let callback = 0;
(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++callback,
  invoke: async (command: string, args: any, options: any) => {
    if (command === "plugin:path|join") return args.paths.join("/");
    if (command === "plugin:fs|exists") return disk.has(args.path);
    if (command === "plugin:fs|mkdir") { disk.set(args.path, "directory"); return; }
    if (command === "plugin:fs|write_text_file") { disk.set(decodeURIComponent(options.headers.path), new TextDecoder().decode(args)); return; }
    if (command === "plugin:dialog|open") return ["/external/reference.pdf"];
    if (command === "project_service") {
      if (args.operation === "settings_get") return structuredClone(settings);
      if (args.operation === "settings_set") {
        if (failImport) { failImport = false; throw new Error("Fixture import failure; retry"); }
        settings = { ...args.args, revision: settings.revision + 1, sources: [...args.args.sources, ...(args.args.pendingImports ?? []).map((f: any) => ({ id: f.path, name: "reference.pdf", kind: "file", path: f.destination }))] };
        return structuredClone(settings);
      }
    }
    return [];
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
backend.projects.register = async path => ({ id: path, name: "Fixture", root: path });
backend.templates.createProject = async (_id, _revision, path) => {
  copies++;
  disk.set(path, "directory");
  disk.set(`${path}/AGENTS.md`, "Private instructions");
  disk.set(`${path}/chapters/slides.tex`, "Complete private content");
  return { project: { id: path, name: "Fixture", root: path }, mainFile: "chapters/slides.tex" };
};
backend.templates.preview = async () => { throw new Error("Preview unavailable"); };
useProjectStore.setState({ lastProjectFolder: "/work" });
useDocumentStore.setState({ openProject: async (path, main) => { opened = `${path}/${main}`; } });
const { ProjectWizard } = await import("../../src/components/project-wizard");
const { TemplatePreview } = await import("../../src/components/template-gallery/template-preview");
const root = createRoot(document.getElementById("root")!);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function wait(test: () => boolean) { for (let i = 0; i < 100; i++) { if (test()) return; await pause(); } throw new Error(`UI timeout: ${document.body.innerText}`); }
function button(label: string) { return [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === label); }
async function click(label: string) { await wait(() => !!button(label) && !button(label)!.disabled); button(label)!.click(); await pause(); }
async function name(value: string) {
  await wait(() => !!document.querySelector('input[placeholder^="e.g."]'));
  const input = document.querySelector<HTMLInputElement>('input[placeholder^="e.g."]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
(window as any).runSmoke = async () => {
  root.render(<ProjectWizard mode="scratch" onBack={() => {}} />);
  await name("scratch"); await click("Add files"); await click("Create Project");
  await wait(() => opened === "/work/scratch/main.tex");
  if (settings.sources.length !== 1) throw new Error("Missing imported file");
  useTemplateStore.getState().openPreview("paper-standard");
  root.render(<TemplatePreview />);
  await click("Use Template"); await name("paper"); await click("Create Project");
  await wait(() => opened === "/work/paper/main.tex");
  if (!disk.has("/work/paper/references.bib")) throw new Error("Missing bibliography");
  const item = privateTemplateItem({ id: "private:fixture", name: "Private", revision: "one", mainFile: "chapters/slides.tex", tags: [], category: "academic", description: "" });
  useTemplateStore.setState({ templates: [item], previewTemplateId: item.id });
  await click("Use Template"); await name("private"); failImport = true;
  await click("Create Project");
  if (opened === "/work/private/chapters/slides.tex") throw new Error("Opened failed creation");
  await click("Create Project"); await wait(() => opened === "/work/private/chapters/slides.tex");
  if (copies !== 1 || disk.get("/work/private/AGENTS.md") !== "Private instructions") throw new Error("Retry replaced private content");
  return { ok: true, checks: ["scratch", "file import", "built-in bibliography", "private custom main", "failed import and retry", "preserved private instructions"] };
};
