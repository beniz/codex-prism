import { afterEach, expect, it, vi } from "vitest";
import { backend } from "@/lib/backend";
import { projectCompletionIndex } from "@/lib/latex-completion-project";
import {
  LatexCompletionIndex,
  type IndexUpdate,
} from "@/lib/latex-completion-index";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
const initial = useDocumentStore.getState();
afterEach(() => {
  useDocumentStore.setState(initial);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const file = (path: string, content?: string): ProjectFile => ({
  id: path,
  name: path,
  relativePath: path,
  type: path.endsWith(".bib") ? "bib" : "tex",
  ref: { projectId: "p", path },
  isDirty: false,
  content,
});
class WorkerFixture {
  private index = new LatexCompletionIndex();
  onmessage?: (event: { data: unknown }) => void;
  static updates: IndexUpdate[] = [];
  postMessage(update: IndexUpdate) {
    WorkerFixture.updates.push(update);
    queueMicrotask(() => this.onmessage?.({ data: this.index.update(update) }));
  }
  terminate() {}
}
it("reads only the declared unopened bibliography and reuses a large index across queries", async () => {
  vi.stubGlobal("Worker", WorkerFixture);
  WorkerFixture.updates = [];
  const source = file("main.tex", "\\addbibresource{refs.bib}");
  useDocumentStore.setState({
    activeFileId: source.id,
    files: [source, file("refs.bib"), file("unused.bib")],
  });
  const content = Array.from(
    { length: 5000 },
    (_, i) => `@book{key${i},title={Title ${i}}}`,
  ).join("\n");
  const read = vi
    .spyOn(backend.files, "read")
    .mockResolvedValue({
      revision: "1",
      bytes: [...new TextEncoder().encode(content)],
    });
  const index = projectCompletionIndex();
  const query = (term: string) =>
    index.query({ active: source.id, kind: "citations", term }, () => false);
  try {
    expect((await query("key10"))?.citations?.[0].key).toBe("key10");
    expect((await query("Title 4999"))?.citations?.[0].key).toBe("key4999");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0].path).toBe("refs.bib");
    expect(
      WorkerFixture.updates[WorkerFixture.updates.length - 1]?.changed,
    ).toEqual([]);
    useDocumentStore.setState({
      files: [source, file("refs.bib", "@article{draft,year=2026}")],
    });
    expect((await query("draft"))?.citations?.[0].key).toBe("draft");
    expect((await query("key4999"))?.citations).toEqual([]);
  } finally {
    index.destroy();
  }
});
it("drops an in-flight file read after a project or checkout reload", async () => {
  vi.stubGlobal("Worker", WorkerFixture);
  useDocumentStore.setState({
    activeFileId: "main.tex",
    files: [file("main.tex")],
  });
  let finish!: () => void;
  const read = vi.spyOn(backend.files, "read").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ bytes: [], revision: "1" });
      }),
  );
  const index = projectCompletionIndex();
  const result = index.query(
    { active: "main.tex", kind: "commands" },
    () => false,
  );
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  useDocumentStore.setState({
    openingGeneration: initial.openingGeneration + 1,
  });
  finish();
  expect(await result).toBeNull();
  index.destroy();
});
