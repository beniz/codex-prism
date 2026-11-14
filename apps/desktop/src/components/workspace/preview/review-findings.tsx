import { memo, type ReactNode } from "react";
import { Tabs } from "radix-ui";
import { XIcon } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { toast } from "sonner";
import { openExternal } from "@/lib/backend/desktop-host";
import { useDocumentStore } from "@/stores/document-store";
import {
  useReviewFindingsStore,
  type ReviewFindings,
} from "@/stores/review-findings-store";
import { Button } from "@/components/ui/button";
import "./review-findings.css";

const components: Components = {
  a: ({ href, children }) =>
    href && /^(https?:|mailto:)/i.test(href) ? (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          void openExternal(href).catch((error) => toast.error(String(error)));
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Reports can refer to workspace assets; reading findings must not fetch remote images.
  img: ({ alt }) => <span className="text-muted-foreground">{alt}</span>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

const FindingsDocument = memo(function FindingsDocument({
  findings,
}: {
  findings: ReviewFindings;
}) {
  return (
    <article
      className="mx-auto max-w-3xl px-5 py-6 sm:px-8"
      aria-label="Reviewer findings"
    >
      <header className="mb-6 border-b pb-5">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-purple-500/10 px-2.5 py-1 font-medium text-purple-700 dark:text-purple-300">
            Reviewer findings
          </span>
          <span className="rounded-full bg-muted px-2.5 py-1">
            {findings.status === "saved"
              ? "Saved review"
              : findings.status === "local"
                ? "Local review"
                : "Pending review"}
          </span>
          {findings.reviewedCommit && (
            <span className="text-muted-foreground">
              Reviewed revision{" "}
              <code title={findings.reviewedCommit}>
                {findings.reviewedCommit.slice(0, 8)}
              </code>
            </span>
          )}
        </div>
        <h1 className="break-words font-semibold text-xl">{findings.title}</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Findings refer to the revision reviewed by the agent. Reopen findings
          to load the latest report.
        </p>
      </header>
      {findings.report.trim() ? (
        <div className="review-findings-markdown">
          <ReactMarkdown
            components={components}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
          >
            {findings.report}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          This review has no written findings yet.
        </p>
      )}
    </article>
  );
});

export function ReviewFindingsTabs({ children }: { children: ReactNode }) {
  const projectId = useDocumentStore((state) => state.projectId);
  const state = useReviewFindingsStore();
  const tabs = state.projectId === projectId ? state.tabs : [];
  const activeTab = tabs.some((tab) => tab.id === state.activeTab)
    ? state.activeTab
    : "pdf";
  return (
    <Tabs.Root
      value={activeTab}
      onValueChange={state.select}
      className="flex h-full min-h-0 flex-col"
    >
      {tabs.length > 0 && (
        <Tabs.List
          aria-label="Document and review findings"
          className="flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/30 p-1"
        >
          <Tabs.Trigger
            value="pdf"
            className="shrink-0 rounded px-3 py-2 text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            PDF
          </Tabs.Trigger>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="flex min-w-0 shrink-0 items-center rounded bg-purple-500/5"
            >
              <Tabs.Trigger
                value={tab.id}
                title={tab.title}
                className="flex max-w-60 items-center gap-2 rounded px-3 py-2 text-sm data-[state=active]:bg-purple-500/10 data-[state=active]:text-purple-700 dark:data-[state=active]:text-purple-300"
              >
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full bg-purple-500"
                />
                <span className="truncate">Findings · {tab.title}</span>
              </Tabs.Trigger>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Close findings: ${tab.title}`}
                onClick={() => state.close(tab.id)}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </Tabs.List>
      )}
      <Tabs.Content
        value="pdf"
        forceMount
        className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
      >
        {children}
      </Tabs.Content>
      {tabs.map((tab) => (
        <Tabs.Content
          key={tab.id}
          value={tab.id}
          forceMount
          className="min-h-0 flex-1 overflow-auto bg-background data-[state=inactive]:hidden"
        >
          <FindingsDocument findings={tab} />
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
