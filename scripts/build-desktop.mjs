import { updaterConfig } from "./updater-config.mjs";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnTauri } from "./tauri-cli.mjs";

const env = { ...process.env };

const args = ["build"];
if (process.platform === "win32") {
  args.push("--config", "src-tauri/tauri.windows.conf.json");
}

const signedConfig = env.TAURI_SIGNING_PRIVATE_KEY ? updaterConfig() : null;
if (signedConfig) args.push("--config", signedConfig);
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  args.push("--config", "src-tauri/tauri.local-build.conf.json");
}

const child = spawnTauri(args, { env, stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (signedConfig)
    rmSync(dirname(signedConfig), { recursive: true, force: true });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
