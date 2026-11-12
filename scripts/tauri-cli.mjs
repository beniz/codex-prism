import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const cli = () => require.resolve("@tauri-apps/cli/tauri.js");

// Execute the installed CLI with an argument array on every OS. Going through
// cmd.exe and a pnpm .cmd shim adds a second, incompatible layer of quoting.
export function spawnTauri(args, options = {}) {
  return spawn(process.execPath, [cli(), ...args], {
    cwd: desktop,
    ...options,
  });
}
export function runTauriSync(args, options = {}) {
  return execFileSync(process.execPath, [cli(), ...args], {
    cwd: desktop,
    ...options,
  });
}
