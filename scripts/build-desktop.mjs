import { spawn } from "node:child_process";

const env = { ...process.env };

const args = ["--filter=@codex-prism/desktop", "tauri", "build"];

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  args.push("--config", "src-tauri/tauri.local-build.conf.json");
}

const child =
  process.platform === "win32"
    ? spawn(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `corepack pnpm ${args.join(" ")}`],
        {
          env,
          stdio: "inherit",
        },
      )
    : spawn("corepack", ["pnpm", ...args], {
        env,
        stdio: "inherit",
      });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
