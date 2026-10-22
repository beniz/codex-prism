import { useEffect, useRef, useState } from "react";
import { DownloadIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { writeFile } from "@tauri-apps/plugin-fs";
import { save, openExternal } from "@/lib/backend/desktop-host";
import { optimizePdf, pdfSize } from "@/lib/pdf-export";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function PdfExportButton({
  projectRoot,
  getPdf,
}: {
  projectRoot: string | null;
  getPdf: () => ArrayBuffer | null;
}) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<"ebook" | "original">("ebook");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const input = useRef<ArrayBuffer | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    input.current = null;
    setOpen(false);
    setBusy(false);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [projectRoot]);
  const close = () => {
    generation.current++;
    setOpen(false);
    setBusy(false);
    input.current = null;
  };
  async function exportPdf() {
    const data = input.current;
    if (!data || busy) return;
    const job = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      let bytes = new Uint8Array(data);
      let reduced = false;
      if (profile === "ebook") {
        if (!projectRoot)
          throw new Error("Open a project to optimize its PDF.");
        const result = await optimizePdf(projectRoot, data);
        bytes = result.bytes;
        reduced = result.reduced;
      }
      if (job !== generation.current) return;
      const name =
        projectRoot
          ?.replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() || "document";
      const now = new Date();
      const timestamp = [
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        now.getHours(),
        now.getMinutes(),
      ]
        .map((part) => String(part).padStart(2, "0"))
        .join("-");
      const path = await save({
        title: "Export PDF",
        defaultPath: `${name}-${timestamp}${profile === "ebook" ? "-ebook" : ""}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path || job !== generation.current) return;
      await writeFile(path, bytes);
      if (job !== generation.current) return;
      const message =
        profile === "original"
          ? `PDF exported (${pdfSize(bytes.length)})`
          : reduced
            ? `PDF exported: ${pdfSize(data.byteLength)} → ${pdfSize(bytes.length)} (${Math.round(100 * (1 - bytes.length / data.byteLength))}% smaller)`
            : `PDF exported (${pdfSize(bytes.length)}). Original retained because optimization did not reduce its size.`;
      toast.success(message);
      close();
    } catch (e) {
      if (job === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (job === generation.current) setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title="Export PDF"
        aria-label="Export PDF"
        onClick={() => {
          const data = getPdf();
          if (!data) return;
          input.current = data;
          setSize(data.byteLength);
          setError(null);
          setOpen(true);
        }}
      >
        <DownloadIcon className="size-3.5" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export PDF</DialogTitle>
            <DialogDescription>
              Choose the size and quality of your exported PDF. Current size:{" "}
              {pdfSize(size)}.
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={busy} className="space-y-3">
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
              <input
                type="radio"
                name="pdf-export-profile"
                value="ebook"
                checked={profile === "ebook"}
                onChange={() => {
                  setProfile("ebook");
                  setError(null);
                }}
                className="mt-1"
              />
              <span>
                <span className="block font-medium">Optimized PDF (ebook)</span>
                <span className="text-muted-foreground text-sm">
                  Smaller file for screen reading. Images may lose detail.
                  Requires Ghostscript.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
              <input
                type="radio"
                name="pdf-export-profile"
                value="original"
                checked={profile === "original"}
                onChange={() => {
                  setProfile("original");
                  setError(null);
                }}
                className="mt-1"
              />
              <span>
                <span className="block font-medium">Original PDF</span>
                <span className="text-muted-foreground text-sm">
                  Full quality, without additional compression.
                </span>
              </span>
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {error?.includes("Ghostscript is not installed") && (
            <Button
              variant="outline"
              onClick={() =>
                void openExternal(
                  "https://ghostscript.com/releases/gsdnld.html",
                ).catch((reason) => setError(String(reason)))
              }
            >
              Get Ghostscript
            </Button>
          )}
          {busy && (
            <p role="status" className="text-muted-foreground text-sm">
              {profile === "ebook"
                ? "Preparing optimized PDF…"
                : "Exporting PDF…"}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void exportPdf()}>
              {busy && <LoaderIcon className="size-4 animate-spin" />}Export
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
