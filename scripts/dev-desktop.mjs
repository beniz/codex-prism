import { spawn } from "node:child_process";

const watch = process.argv.includes("--watch");
const env = { ...process.env, CODEX_PRISM_WATCH: watch ? "1" : "0" };
const args = ["pnpm", "--filter=@codex-prism/desktop", "tauri", "dev"];
if (!watch) args.push("--no-watch");
console.log(
  watch
    ? "codex-prism: automatic reloads and restarts enabled."
    : "codex-prism: automatic reloads and restarts disabled. Relaunch to apply code changes.",
);

const child =
  process.platform === "win32"
    ? spawn(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `corepack ${args.join(" ")}`],
        {
          env,
          stdio: "inherit",
        },
      )
    : spawn("corepack", args, {
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
