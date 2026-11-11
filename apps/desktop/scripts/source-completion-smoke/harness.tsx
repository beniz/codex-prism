import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SourceCompletion } from "../../src/components/agent-chat/source-completion";
import { sourceRequest } from "../../src/lib/source-completion";
import "../../src/styles/globals.css";
(window as any).__TAURI_INTERNALS__ = { invoke: async (_: string, args: any) => {
  if (args.operation === "source_catalogue") return { entries: [{ id: "attachments", sourceKey: "files:attachments", name: "attachments", kind: "files" }], revision: 1, generation: null };
  if (args.operation === "source_browse") return { entries: args.args.path === "/" ? [{ name: "reports with spaces", directory: true }] : [{ name: "paper draft.pdf", directory: false }], truncated: false, revision: 1, generation: null };
  if (args.operation === "source_reference_check") return { valid: true };
  throw new Error("Unexpected operation");
} };
function Harness() {
  const [draft, setDraft] = useState(""); const [sent, setSent] = useState(""); const input = useRef<HTMLTextAreaElement>(null);
  return <main className="max-w-xl p-4"><SourceCompletion projectId="fixture" chatId="chat" draft={draft} input={input} change={setDraft} /><textarea ref={input} aria-label="Message" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void sourceRequest("fixture", "chat", "source_reference_check", { prompt: draft }).then(() => { setSent(draft); setDraft(""); }); } }} /><p id="sent">{sent}</p></main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(test: () => boolean) { for (let n = 0; n < 100; n++) { if (test()) return; await pause(); } throw new Error("UI condition timed out"); }
(window as any).runSmoke = async () => {
  await until(() => !!document.querySelector("textarea"));
  const field = document.querySelector("textarea")!;
  const key = async (key: string) => { field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await pause(); };
  const type = async (value: string) => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.setSelectionRange(value.length, value.length);
    await pause();
  };
  const option = (label: string) => Array.from(document.querySelectorAll('[role="option"]')).find(e => e.textContent?.startsWith(label));
  const submit = async (expected: string) => {
    await until(() => field.value === expected && !document.querySelector('[role="listbox"]'));
    await key("Enter");
    await until(() => document.getElementById("sent")!.textContent === expected && field.value === "");
  };

  await type("Read @"); await key("Tab");
  await until(() => !!option("Use entire source"));
  await key("Enter");
  await submit("Read @attachments: ");

  await type("Read @attachments:/");
  await until(() => !!option("Use entire source"));
  await key("Enter");
  await submit("Read @attachments:/ ");

  await type('Read @attachments:"/reports with spaces/');
  await until(() => !!option("Use this directory"));
  await key("Enter");
  await submit('Read @attachments:"/reports with spaces/" ');

  await type("Read @");
  await until(() => !!option("Browse files"));
  await key("ArrowDown"); await key("Enter");
  await until(() => !!option("reports with spaces/"));
  await key("ArrowDown"); await key("Tab");
  await until(() => !!option("paper draft.pdf"));
  await key("ArrowDown"); await key("Enter");
  await submit('Read @attachments:"/reports with spaces/paper draft.pdf" ');
  return { ok: true, checks: ["@ Tab", "entire source", "explicit root", "quoted directory", "file browsing", "quoted file", "Enter acceptance", "submission and clearing"] };
};
