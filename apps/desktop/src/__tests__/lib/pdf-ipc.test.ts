import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { invoke, proposals, type Proposal, type ProposalPdfBuild } from "@/lib/backend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const proposal = { projectId: "project", id: "chat-proposal", generation: 2 } as Proposal;

it("accepts raw main PDF bytes without copying the buffer", async () => {
  const pdf = new Uint8Array([37, 80, 68, 70, 255]).buffer;
  vi.mocked(nativeInvoke).mockResolvedValueOnce({ id: "project" }).mockResolvedValueOnce(pdf);
  expect(await invoke("compile_latex", { projectDir: "/paper", mainFile: "main.tex" })).toBe(pdf);
  expect(nativeInvoke).toHaveBeenLastCalledWith("project_service", expect.objectContaining({ binaryPdf: true }));
});

it.each([false, true])("decodes proposal metadata and preserves binary bytes (array fallback %s)", async fallback => {
  const metadata = { artifactId: "result", locations: [{ file: "résumé.tex", line: 42 }] };
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  const pdf = new Uint8Array([37, 80, 68, 70, 0, 255]);
  const frame = new Uint8Array(4 + header.length + pdf.length);
  new DataView(frame.buffer).setUint32(0, header.length, true);
  frame.set(header, 4);
  frame.set(pdf, 4 + header.length);
  vi.mocked(nativeInvoke).mockResolvedValueOnce(fallback ? [...frame] : frame.buffer);
  const result = await proposals.operate<ProposalPdfBuild>(proposal, "compile");
  expect(result).toMatchObject(metadata);
  expect(new Uint8Array(result.bytes)).toEqual(pdf);
  vi.mocked(nativeInvoke).mockResolvedValueOnce(null);
  expect(await proposals.loadBuild(proposal, "main.tex")).toBeNull();
});
