import { spawn } from "node:child_process";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const env = { ...process.env, CODEX_PRISM_WATCH: watch ? "1" : "0" };
const args = ["pnpm", "--filter=@codex-prism/desktop", "tauri", "dev"];
if (!watch) args.push("--no-watch");
console.log(
  watch
    ? "codex-prism: automatic reloads and restarts enabled."
    : "codex-prism: automatic reloads and restarts disabled. Relaunch to apply code changes.",
);
if (process.platform === "linux")
  env.CXXFLAGS = [env.CXXFLAGS, "-std=c++17"].filter(Boolean).join(" ");

function appendEnvFlag(name, flag) {
  const current = env[name] ?? "";
  env[name] = current.includes(flag)
    ? current
    : [current, flag].filter(Boolean).join(" ");
}

if (process.platform === "win32") {
  env.VCPKG_ROOT ||= join(env.USERPROFILE ?? "", "vcpkg");
  env.TECTONIC_DEP_BACKEND = "vcpkg";
  env.VCPKGRS_TRIPLET = "x64-windows-static-release";
  env.VCPKG_DEFAULT_TRIPLET = env.VCPKGRS_TRIPLET;
  appendEnvFlag("RUSTFLAGS", "-Ctarget-feature=+crt-static");
  env.CXXFLAGS = [env.CXXFLAGS, "/std:c++17"].filter(Boolean).join(" ");
}

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
