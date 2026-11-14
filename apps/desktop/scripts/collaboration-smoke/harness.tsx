// Real React components with a disposable host boundary; no real credentials or remotes.
import { createRoot } from "react-dom/client";
import "../../src/styles/globals.css";
import { ProposedChangesPanel } from "../../src/components/agent-chat/proposed-changes-panel";
import { proposals } from "../../src/lib/backend";
import { useDocumentStore } from "../../src/stores/document-store";
import { useAgentChatStore } from "../../src/stores/agent-chat-store";
import { useReviewFindingsStore } from "../../src/stores/review-findings-store";
import { ReviewFindingsTabs } from "../../src/components/workspace/preview/review-findings";
const report = `# Manuscript review

## Overall assessment
The argument is promising. **Clarify the experimental comparison** before drawing a general conclusion.

## Major findings
### 1. Distinguish evidence from interpretation
**Source:** \`main.tex:120–135\`

> Our approach consistently outperforms every baseline.

The current results support a narrower claim:
1. Name the evaluated instances and baselines.
2. Report uncertainty alongside the mean.

**Suggested revision:** Limit the claim to the reported experiments.

## Minor findings
- Define $n$ before introducing the complexity bound $O(n^2)$.
- Use consistent terminology in the abstract and conclusion.

| Priority | Location | Action |
| --- | --- | --- |
| Major | Results | Qualify the comparison |
| Minor | Abstract | Define the terminology |

## Recommended next steps
- [ ] Check the evidence supporting each comparison.
- [ ] Reconcile definitions across sections.

[Supporting reference](https://example.test/paper)
![An illustration](https://example.test/do-not-fetch.png)
`;
const calls: { operation: string; projectId: string | null; args: any }[] = [];
let opened = "";
let submitted = "";
let callback = 0;
let retainedLocalReview = false;
let delayReport = false;
let finishReport: ((value: { report: string }) => void) | undefined;
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
          ...(retainedLocalReview
            ? [
                {
                  id: "retained",
                  proposalId: "retained",
                  scope: "Retained findings",
                  reviewedCommit: "abcdef12",
                  schemaVersion: 1,
                  local: true,
                },
              ]
            : []),
        ];
      case "report":
        if (delayReport) {
          delayReport = false;
          return new Promise((resolve) => {
            finishReport = resolve;
          });
        }
        return { report };
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
  if (button(label)!.getAttribute("role") === "tab") {
    button(label)!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
  }
  button(label)!.click();
  await pause();
}
async function field(label: string, value: string) {
  const fieldLabel = [...document.querySelectorAll("label")].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  const input = fieldLabel?.control;
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
  root.render(
    <div style={{ display: "flex", height: "100vh" }}>
      <aside style={{ width: 280 }}>
        <CollaborationPanel projectId="existing" />
        <ProposedChangesPanel />
      </aside>
      <main style={{ flex: 1, minWidth: 0 }}>
        <ReviewFindingsTabs>
          <div data-pdf-fixture>PDF remains available</div>
        </ReviewFindingsTabs>
      </main>
    </div>,
  );
  await click("Request review");
  await click("Start review");
  await wait(() => submitted === "Review the argument");
  const pdf = document.querySelector("[data-pdf-fixture]");
  await click("View saved reviews");
  await click("Clarity · abcdef12");
  await wait(() => !!document.querySelector(".review-findings-markdown h2"));
  const article = document.querySelector(
    'article[aria-label="Reviewer findings"]',
  )!;
  if (
    !article.querySelector("blockquote") ||
    !article.querySelector("table") ||
    !article.querySelector(".katex") ||
    !article.querySelector("strong") ||
    !article.querySelector("code")
  )
    throw new Error("Findings formatting missing");
  if (article.querySelector("img"))
    throw new Error("Report loads external images");
  if (article.closest('[role="dialog"]'))
    throw new Error("Findings still in a modal");
  if (pdf !== document.querySelector("[data-pdf-fixture]"))
    throw new Error("PDF was remounted");
  await click("PDF");
  if (!document.querySelector("[data-pdf-fixture]")?.checkVisibility())
    throw new Error("PDF not visible on switch");
  await click("Findings · Clarity");
  await click("View saved reviews");
  await click("Clarity · abcdef12");
  if (useReviewFindingsStore.getState().tabs.length !== 1)
    throw new Error("Duplicate report tab");
  document
    .querySelector<HTMLButtonElement>('[aria-label="Close findings: Clarity"]')!
    .click();
  await pause();
  if (!document.querySelector("[data-pdf-fixture]")?.checkVisibility())
    throw new Error("Closing findings did not restore PDF");
  useAgentChatStore.setState({
    proposals: [
      {
        id: "pending",
        projectId: "existing",
        chatId: useAgentChatStore.getState().activeTabId,
        origin: "reviewer",
        hasReview: true,
        reviewSaved: false,
        state: "ready",
        generation: 1,
        conflicts: [],
        parent: null,
        changes: [
          {
            path: ".prism-collab/reviews/pending/report.md",
            kind: "added",
            binary: false,
            newContent: report,
          },
        ],
      },
    ],
  });
  const chat = useAgentChatStore.getState().activeTabId;
  await click("View reviewer findings");
  await wait(() => useReviewFindingsStore.getState().tabs.length === 1);
  if (useAgentChatStore.getState().activeTabId !== chat)
    throw new Error("Reading findings switched chats");
  if (!document.body.innerText.includes("Pending review"))
    throw new Error("Missing pending status");
  useDocumentStore.setState({ projectId: "other" });
  await pause();
  if (document.body.innerText.includes("Manuscript review"))
    throw new Error("Report leaked into another project");
  useDocumentStore.setState({ projectId: "existing" });
  delayReport = true;
  await click("View reviewer findings");
  await wait(() => !!finishReport);
  const previousTabs = useReviewFindingsStore.getState().tabs;
  useDocumentStore.setState({ projectId: "other" });
  finishReport!({ report: "This late report belongs to the old project" });
  await pause();
  if (useReviewFindingsStore.getState().tabs !== previousTabs)
    throw new Error("Late report changed findings after navigation");
  useDocumentStore.setState({ projectId: "existing" });
  await click("View saved reviews");
  await click("Clarity · abcdef12");
  // Exercise the real decision controls with a deterministic native boundary.
  useAgentChatStore.setState({
    projectId: "existing",
    proposals: [
      {
        ...useAgentChatStore.getState().proposals[0],
        changes: ["main.tex", "section.tex"].map((path) => ({
          path,
          kind: "modified",
          binary: false,
          oldContent: "Before",
          newContent: "After",
        })),
      },
    ],
  });
  let kept: string[] = [];
  proposals.operate = (async (proposal, action, extra) => {
    if (action === "save_review") {
      useAgentChatStore.setState({
        locked: false,
        proposals: [
          {
            ...proposal,
            generation: proposal.generation + 1,
            reviewSaved: true,
            blocksEditing: false,
          },
        ],
      });
    } else if (action === "apply") {
      kept = extra?.paths as string[];
      useAgentChatStore.setState({
        proposals: [
          {
            ...proposal,
            generation: proposal.generation + 1,
            changes: proposal.changes.filter(
              (change) => !kept.includes(change.path),
            ),
          },
        ],
      });
    } else if (action === "discard") {
      retainedLocalReview = true;
      useAgentChatStore.setState({ proposals: [] });
    }
    return { sourceChanged: false, conflicts: [] };
  }) as typeof proposals.operate;
  await click("Save review");
  if (useAgentChatStore.getState().proposals[0].changes.length !== 2)
    throw new Error("Save review accepted document changes");
  await wait(() => !!document.querySelector('input[type="checkbox"]'));
  const checklist = [
    ...document.querySelectorAll<HTMLLabelElement>(
      'section[aria-label="Review chat proposal"] label',
    ),
  ];
  checklist
    .find((label) => label.textContent?.includes("section.tex"))!
    .querySelector<HTMLInputElement>("input")!
    .click();
  await click("Keep selected (1)");
  if (kept.join() !== "main.tex")
    throw new Error("Acceptance did not respect selected files");
  if (
    useAgentChatStore.getState().proposals[0].changes[0].path !== "section.tex"
  )
    throw new Error("Unselected edit was not retained");
  await click("Discard suggested changes");
  await click("View saved reviews");
  await click("Retained findings · abcdef12 · Local");
  if (!document.body.innerText.includes("Local review"))
    throw new Error("Retained findings are not labeled local");
  if (
    calls.filter((call) => call.operation === "report").at(-1)?.args
      .proposalId !== "retained"
  )
    throw new Error("Retained findings did not use their archived snapshot");
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
      "formatted Markdown and math",
      "PDF stays mounted across tab switches",
      "close and reopen findings",
      "pending findings preserve chat selection",
      "project isolation",
      "late report ignored after project navigation",
      "save review leaves document changes pending",
      "selected acceptance retains unselected files",
      "discard retains saved findings",
      "archived local review opens from its retained snapshot",
    ],
  };
};
