// Real React components with a disposable host boundary; no real credentials or remotes.
import { createRoot } from "react-dom/client";
import "../../src/styles/globals.css";
import { useDocumentStore } from "../../src/stores/document-store";
import { useAgentChatStore } from "../../src/stores/agent-chat-store";
const calls: { operation: string; projectId: string | null; args: any }[] = [];
let opened = "";
let submitted = "";
let callback = 0;
(window as any).__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
  },
  transformCallback: () => ++callback,
  invoke: async (command: string, args: any) => {
    if (command !== "collaboration") return [];
    calls.push(args);
    switch (args.operation) {
      case "status":
        return {
          connected: args.projectId === "existing",
          url: "https://git.example.test/team/paper",
          branch: "draft/one",
          name: "Existing Author",
          email: "existing@example.test",
        };
      case "resolve":
        return {
          url: "https://git.example.test/team/paper",
          branch: "draft/one",
          branches: ["main", "draft/one"],
        };
      case "profile":
        return {
          name: "Collaborator",
          email: "author@example.test",
          emails: [{ email: "author@example.test", verified: true }],
        };
      case "connect":
        return { project: { id: "cloned", root: "/temporary/shared" } };
      case "sync":
        return { changed: false };
      case "review_start":
        return { proposalId: "review", prompt: "Review the argument" };
      case "reviews":
        return [
          {
            id: "saved",
            scope: "Clarity",
            reviewedCommit: "abcdef12",
            schemaVersion: 1,
          },
        ];
      case "report":
        return { report: "A finding with source context" };
      default:
        return null;
    }
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};
useDocumentStore.setState({
  projectId: null,
  openProject: async (path) => {
    opened = path;
  },
});
useAgentChatStore.setState({
  locked: false,
  proposals: [],
  refreshReview: async () => {},
  sendPrompt: async (prompt) => {
    submitted = prompt;
  },
});
const { ConnectSharedProject, CollaborationPanel } = await import(
  "../../src/components/collaboration"
);
const root = createRoot(document.getElementById("root")!);
const pause = () => new Promise((r) => setTimeout(r, 100));
async function wait(test: () => boolean) {
  for (let i = 0; i < 80; i++) {
    if (test()) return;
    await pause();
  }
  throw new Error(`UI timeout: ${document.body.innerText}`);
}
function button(label: string) {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
}
async function click(label: string) {
  await wait(() => !!button(label) && !button(label)!.disabled);
  button(label)!.click();
  await pause();
}
async function field(label: string, value: string) {
  const input = [...document.querySelectorAll("label")]
    .find((l) => l.textContent?.trim().startsWith(label))
    ?.querySelector("input");
  if (!input) throw new Error(`Missing field ${label}`);
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
}
(window as any).runSmoke = async () => {
  root.render(<ConnectSharedProject />);
  await click("Connect shared project");
  await field(
    "Repository or branch link",
    "https://git.example.test/team/paper/src/branch/draft/one",
  );
  document.querySelector("details")!.open = true;
  await field("Access token", "fixture-only");
  await click("Use token and retrieve identity");
  await click("Check repository");
  await field("New local folder", "/temporary/shared");
  await click("Connect");
  await wait(() => opened === "/temporary/shared");
  const clone = calls.find((c) => c.operation === "connect")!;
  if (
    clone.projectId !== null ||
    clone.args.name !== "Collaborator" ||
    clone.args.email !== "author@example.test" ||
    clone.args.branch !== "draft/one"
  )
    throw new Error("Clone confirmation lost identity or branch");
  root.render(<ConnectSharedProject key="existing" projectId="existing" />);
  await pause();
  await click("Connect shared project");
  await wait(() =>
    [...document.querySelectorAll("input")].some(
      (i) => i.value === "Existing Author",
    ),
  );
  if (
    [...document.querySelectorAll("label")].some((l) =>
      l.textContent?.startsWith("New local folder"),
    )
  )
    throw new Error("Existing project requests clone destination");
  await click("Check repository");
  await click("Connect");
  await wait(() => calls.filter((c) => c.operation === "connect").length === 2);
  useDocumentStore.setState({ projectId: "existing", files: [] });
  root.render(<CollaborationPanel projectId="existing" />);
  await click("Request review");
  await click("Start review");
  await wait(() => submitted === "Review the argument");
  await click("View saved reviews");
  await click("Clarity · abcdef12");
  await wait(() =>
    document.body.innerText.includes("A finding with source context"),
  );
  return {
    ok: true,
    checks: [
      "single connection flow",
      "clone destination",
      "API identity",
      "slash branch",
      "existing identity preserved",
      "review routing",
      "saved findings",
    ],
  };
};
