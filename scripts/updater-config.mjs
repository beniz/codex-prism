// Public bundler configuration only. The signing secret stays in the environment.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function updaterConfig() {
  if (
    !process.env.TAURI_SIGNING_PRIVATE_KEY ||
    !process.env.PRISM_UPDATE_PUBLIC_KEY
  )
    throw new Error("Signed builds require updater private and public keys");
  const path = join(
    mkdtempSync(join(tmpdir(), "prism-updater-config-")),
    "config.json",
  );
  writeFileSync(
    path,
    JSON.stringify({
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: { pubkey: process.env.PRISM_UPDATE_PUBLIC_KEY.trim() },
      },
    }),
  );
  return path;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(updaterConfig());
