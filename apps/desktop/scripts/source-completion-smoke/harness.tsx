import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SourceCompletion } from "../../src/components/agent-chat/source-completion";
import { sourceRequest } from "../../src/lib/source-completion";
import "../../src/styles/globals.css";
(window as any).__TAURI_INTERNALS__ = { invoke: async (_: string, args: any) => {
  if (args.operation === "source_catalogue") return { entries: [{ id: "attachments", sourceKey: "files:attachments", name: "attachments", kind: "files" }], revision: 1, generation: null };
  if (args.operation === "source_browse") return { entries: args.args.path === "/" ? [{ name: "reports", directory: true }] : [{ name: "paper draft.pdf", directory: false }], truncated: false, revision: 1, generation: null };
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
  await until(() => !!document.querySelector("textarea")); const field = document.querySelector("textarea")!;
  field.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Read @"); field.dispatchEvent(new Event("input", { bubbles: true })); field.setSelectionRange(6, 6);
  await pause(); field.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await until(() => !!document.querySelector('[role="option"]'));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until(() => document.querySelector('[role="option"]')?.textContent === "reports/");
  if (document.getElementById("sent")!.textContent) throw new Error("Enter submitted instead of accepting source");
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await until(() => document.querySelector('[role="option"]')?.textContent === "paper draft.pdf");
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until(() => field.value === 'Read @attachments:"/reports/paper draft.pdf" ');
  await until(() => !document.querySelector('[role="listbox"]'));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until(() => document.getElementById("sent")!.textContent!.includes("paper draft.pdf"));
  return { ok: true, checks: ["@ Tab", "source selection", "directory navigation", "quoted file", "Enter acceptance", "submission"] };
};
