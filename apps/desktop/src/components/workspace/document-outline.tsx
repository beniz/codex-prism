import { memo, useEffect, useState } from "react";
import { ListIcon } from "lucide-react";
import {
  parseProjectTableOfContents,
  type ProjectTocItem,
} from "@/lib/latex-outline";
import { usePdfNavigationStore } from "@/stores/pdf-navigation-store";
import { resolveTexRoot } from "@/lib/latex-project";
import { useDocumentStore } from "@/stores/document-store";

const OutlineEntries = memo(function OutlineEntries({
  toc,
}: {
  toc: ProjectTocItem[];
}) {
  function jump(item: ProjectTocItem) {
    const state = useDocumentStore.getState();
    const file = state.files.find((file) => file.id === item.fileId);
    if (!file || file.content === undefined) return;
    const line = item.line;
    const lines = file.content.split("\n");
    let position = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++)
      position += lines[i].length + 1;
    if (state.activeFileId !== file.id) state.setActiveFile(file.id);
    state.requestJumpToPosition(position);
    if (state.projectRoot && file?.type === "tex") {
      usePdfNavigationStore.getState().navigate({
        projectRoot: state.projectRoot,
        filePath: file.relativePath,
        line,
        sourceLine: lines[line - 1] ?? "",
      });
    }
  }
  return toc.length ? (
    toc.map((item, index) => (
      <button
        key={index}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
        style={{ paddingLeft: `${Math.max(0, item.level - 1) * 12 + 8}px` }}
        onClick={() => jump(item)}
      >
        {item.number && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {item.number}
          </span>
        )}
        <span className="truncate">{item.title}</span>
      </button>
    ))
  ) : (
    <div className="px-2 py-1 text-muted-foreground text-xs">
      No sections found
    </div>
  );
});

// Mount with the active file as its key so switching files updates immediately.
export function DocumentOutline() {
  const files = useDocumentStore((state) => state.files);
  const activeFileId = useDocumentStore((state) => state.activeFileId);
  const parse = () =>
    parseProjectTableOfContents(files, resolveTexRoot(activeFileId, files));
  const [toc, setToc] = useState(parse);
  useEffect(() => {
    // Parsing and reconciling every heading must not block the typing frame.
    const timer = setTimeout(() => setToc(parse()), 250);
    return () => clearTimeout(timer);
  }, [files, activeFileId]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-center gap-2 px-3">
        <ListIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-xs">Outline</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <OutlineEntries toc={toc} />
      </div>
    </div>
  );
}
