import { invoke } from "@/lib/backend";

export function pdfBase64(data: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Cannot read PDF for export"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.readAsDataURL(new Blob([data], { type: "application/pdf" }));
  });
}
export type PdfExportProfile = "high-quality" | "compact";

export async function optimizePdf(
  projectRoot: string,
  data: ArrayBuffer,
  profile: PdfExportProfile,
) {
  const result = await invoke<{
    pdfBase64: string;
    originalBytes: number;
    exportBytes: number;
    reduced: boolean;
  }>("optimize_pdf", { projectRoot, profile, pdfBase64: await pdfBase64(data) });
  const binary = atob(result.pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, reduced: result.reduced };
}
export function pdfSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
