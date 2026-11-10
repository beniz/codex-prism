import rules from "../../../../crates/prism-core/src/file-rules.json";

/** Navigator policy: PDFs/reference files remain visible. Native libraries are
 * hidden here, but may be required inputs in workspace/template snapshots. */
export function isNavigatorArtifact(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    rules.auxiliary_suffixes.some((suffix) => lower.endsWith(suffix)) ||
    rules.navigator_binary_suffixes.some((suffix) => lower.endsWith(suffix))
  );
}
