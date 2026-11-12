import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useFirstChangedPage,
  clearFirstChangedPageCache,
} from "@/hooks/use-first-changed-page";
import { loadFirstChangedPdfPage } from "@/lib/changed-pdf-page-client";
import type { ChatPdfArtifact } from "@/hooks/use-chat-pdf";
vi.mock("@/lib/changed-pdf-page-client", () => ({
  loadFirstChangedPdfPage: vi.fn(),
}));
let root: Root;
let current: ReturnType<typeof useFirstChangedPage>;
const pending: Array<{ signal: AbortSignal; resolve(page?: number): void }> =
  [];
const artifact = (id: string, generation = 1) =>
  ({
    proposal: { id, generation, projectId: "project", changes: [] },
    main: "main.tex",
    build: { artifactId: id, locations: [] },
    bytes: new Uint8Array(1),
  }) as unknown as ChatPdfArtifact;
function Probe({
  value,
  project = "project",
}: {
  value?: ChatPdfArtifact;
  project?: string;
}) {
  current = useFirstChangedPage(value, project);
  return null;
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  clearFirstChangedPageCache();
  pending.length = 0;
  vi.mocked(loadFirstChangedPdfPage)
    .mockReset()
    .mockImplementation(
      (_input, signal) =>
        new Promise((resolve) => pending.push({ signal, resolve })),
    );
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it("cancels on switching and rejects stale replies, retaining completed results on return", async () => {
  await act(async () => root.render(<Probe value={artifact("a")} />));
  await act(async () => root.render(<Probe value={artifact("b")} />));
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => pending[0].resolve(9));
  expect(current).toBeUndefined();
  await act(async () => pending[1].resolve(3));
  expect(current?.page).toBe(3);
  await act(async () => root.render(<Probe value={artifact("a")} />));
  expect(current).toBeUndefined();
  await act(async () => root.render(<Probe value={artifact("b")} />));
  expect(current?.page).toBe(3);
  expect(pending).toHaveLength(3);
});
it("scopes analysis to generation and project and aborts on unmount", async () => {
  await act(async () => root.render(<Probe value={artifact("a")} />));
  await act(async () => pending[0].resolve(2));
  await act(async () => root.render(<Probe value={artifact("a", 2)} />));
  expect(current).toBeUndefined();
  await act(async () =>
    root.render(<Probe project="another" value={artifact("a", 2)} />),
  );
  await act(async () => pending[1].resolve(4));
  expect(current).toBeUndefined();
  await act(async () => root.render(<Probe value={artifact("a", 2)} />));
  await act(async () => root.render(null));
  expect(pending[2].signal.aborted).toBe(true);
});
it("caches a completed no-change result without repeated work", async () => {
  await act(async () => root.render(<Probe value={artifact("a")} />));
  await act(async () => pending[0].resolve());
  await act(async () => root.render(<Probe />));
  await act(async () => root.render(<Probe value={artifact("a")} />));
  expect(current).toBeUndefined();
  expect(pending).toHaveLength(1);
});
