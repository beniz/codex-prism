// Disposable runner only: two actual packages, real updater verification/install/relaunch.
import { spawn } from "node:child_process";
import { spawnTauri } from "./tauri-cli.mjs";
import { createServer } from "node:http";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  cp,
  chmod,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { repairAppImage } from "./appimage.mjs";
import { signArtifact, verifySignedFile } from "./updater-artifacts.mjs";
if (
  process.env.GITHUB_ACTIONS !== "true" &&
  process.env.PRISM_ALLOW_LOCAL_SMOKE !== "1"
)
  throw new Error("Use a disposable CI runner");
const root = resolve(process.env.RUNNER_TEMP || "/tmp", "prism-updater-smoke");
await mkdir(root, { recursive: true });
const log = [];
const run = (program, args, extra = {}) =>
  new Promise((ok, fail) => {
    const child = spawn(program, args, { stdio: "inherit", ...extra });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${program} failed: ${code}`)),
    );
  });
const tauri = (args) =>
  new Promise((ok, fail) => {
    const child = spawnTauri(args, { stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`Tauri CLI failed: ${code}`)),
    );
  });
const keyPath = join(root, "test.key");
await tauri([
  "signer",
  "generate",
  "--ci",
  "-w",
  keyPath,
  "-p",
  "disposable-updater-test",
  "-f",
]);
process.env.TAURI_SIGNING_PRIVATE_KEY = (
  await readFile(keyPath, "utf8")
).trim();
process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "disposable-updater-test";
process.env.PRISM_UPDATE_PUBLIC_KEY = (
  await readFile(`${keyPath}.pub`, "utf8")
).trim();
process.env.PRISM_OFFICIAL_BUILD = "1";
process.env.APPLE_SIGNING_IDENTITY = "-";
process.env.APPIMAGE_EXTRACT_AND_RUN = "1";
const versions = ["0.0.1", "0.0.2"];
const platform = process.platform;
const bundleDir = resolve("apps/desktop/src-tauri/target/release/bundle");
const bundles =
  platform === "win32"
    ? "nsis"
    : platform === "darwin"
      ? "app"
      : "appimage,deb";
async function filesBelow(path) {
  const out = [];
  for (const f of await readdir(path, { withFileTypes: true })) {
    const p = join(path, f.name);
    if (f.isDirectory()) out.push(...(await filesBelow(p)));
    else out.push(p);
  }
  return out;
}
for (const version of versions) {
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      version,
      app: { windows: [] },
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          dangerousInsecureTransportProtocol: true,
          pubkey: process.env.PRISM_UPDATE_PUBLIC_KEY,
        },
      },
    }),
  );
  await rm(bundleDir, { recursive: true, force: true });
  await tauri([
    "build",
    ...(platform === "win32"
      ? ["--config", "src-tauri/tauri.windows.conf.json"]
      : []),
    "--config",
    config,
    "--features",
    "updater-test",
    "--bundles",
    bundles,
    "--",
    "--locked",
  ]);
  await cp(bundleDir, join(root, version), { recursive: true });
}
const packages = await filesBelow(join(root, versions[1]));
const suffix =
  platform === "win32"
    ? "-setup.exe"
    : platform === "darwin"
      ? ".app.tar.gz"
      : ".AppImage";
const artifact = packages.find((p) => p.endsWith(suffix));
if (!artifact) throw new Error("Updater payload missing");
if (platform === "linux") {
  await repairAppImage(artifact);
  signArtifact(artifact);
}
const signature = await verifySignedFile(
  artifact,
  process.env.PRISM_UPDATE_PUBLIC_KEY,
);
let payload = await readFile(artifact);
const original = Buffer.from(payload);
const target = `${platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux"}-${process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch}`;
const server = createServer((req, res) => {
  if (req.url === "/latest.json")
    res.end(
      JSON.stringify({
        version: versions[1],
        notes: "CI upgrade",
        platforms: { [target]: { signature, url: `${url}/payload` } },
      }),
    );
  else if (req.url === "/payload") res.end(payload);
  else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}`;
const installed = join(root, "installed app");
await mkdir(installed, { recursive: true });
const aFiles = await filesBelow(join(root, versions[0]));
let executable;
let prerequisiteLog;
let prerequisiteBytes;
if (platform === "win32") {
  // Reuse the dependency fixtures from the existing installer smoke test for initial install only.
  await run("powershell", [
    "-NoProfile",
    "-File",
    "scripts/windows-updater-fixtures.ps1",
    "-Root",
    root,
  ]);
  process.env.PATH = `${join(root, "tools")};${process.env.PATH}`;
  const installer = aFiles.find((p) => p.endsWith("-setup.exe"));
  // NSIS /D must be last and must not be quoted (even with spaces).
  await run(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      '$p=Start-Process -FilePath $env:PRISM_INITIAL_INSTALLER -ArgumentList "/S /D=$env:PRISM_INSTALL_ROOT" -Wait -PassThru; exit $p.ExitCode',
    ],
    {
      env: {
        ...process.env,
        PRISM_INITIAL_INSTALLER: installer,
        PRISM_INSTALL_ROOT: installed,
      },
    },
  );
  executable = join(installed, "codex-prism.exe");
  prerequisiteLog = join(
    process.env.LOCALAPPDATA,
    "codex-prism",
    "installer.log",
  );
  prerequisiteBytes = await readFile(prerequisiteLog);
  // Make any unwanted prerequisite invocation fail during update.
  await rm(join(root, "tools"), { recursive: true, force: true });
} else if (platform === "darwin") {
  await cp(
    join(root, versions[0], "macos/codex-prism.app"),
    join(installed, "codex-prism.app"),
    { recursive: true },
  );
  executable = join(installed, "codex-prism.app/Contents/MacOS/codex-prism");
} else {
  executable = join(installed, "codex-prism.AppImage");
  await cp(
    aFiles.find((p) => p.endsWith(".AppImage")),
    executable,
  );
  await chmod(executable, 0o755);
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function waitFor(check, label) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error(`Timeout: ${label}`);
}
async function scenario(mode, binary = executable, onStarted) {
  const state = join(root, mode);
  await rm(state, { recursive: true, force: true });
  await mkdir(state, { recursive: true });
  const seed = "Preserve pending document and chat data";
  await writeFile(join(state, "sentinel"), seed);
  const child = spawn(
    platform === "win32" ? "powershell" : binary,
    platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          "scripts/windows-updater-launch.ps1",
          "-Executable",
          binary,
        ]
      : [],
    {
      env: {
        ...process.env,
        PRISM_TEST_ROOT: state,
        PRISM_TEST_MODE: mode,
        PRISM_TEST_TARGET: versions[1],
        PRISM_TEST_UPDATE_FEED: `${url}/latest.json`,
      },
      stdio: "inherit",
    },
  );
  let launchError;
  child.on("error", (e) => {
    launchError = e;
  });
  child.on("exit", (code, signal) => {
    log.push(`${mode} launcher exit: ${code ?? signal}`);
    if (code !== 0)
      launchError = new Error(`${mode} launcher failed: ${code ?? signal}`);
  });
  try {
    await waitFor(async () => {
      if (launchError) throw launchError;
      if (await exists(join(state, "error")))
        throw new Error(await readFile(join(state, "error"), "utf8"));
      return exists(join(state, "started.json"));
    }, "initial launch");
    if (onStarted) await onStarted(state);
    await waitFor(async () => {
      if (launchError) throw launchError;
      if (await exists(join(state, "error")))
        throw new Error(await readFile(join(state, "error"), "utf8"));
      if (mode === "tamper") return exists(join(state, "rejected"));
      try {
        return (
          JSON.parse(await readFile(join(state, "started.json"), "utf8"))
            .version === versions[1]
        );
      } catch {
        return false;
      }
    }, `${mode} result`);
    if ((await readFile(join(state, "sentinel"), "utf8")) !== seed)
      throw new Error("User data changed");
    log.push(`PASS ${mode}`);
  } catch (error) {
    log.push(`FAIL ${mode}: ${error.message}`);
    if (platform === "win32") {
      await run("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "scripts/windows-updater-diagnostics.ps1",
        "-State",
        state,
        "-Executable",
        binary,
      ]).catch((e) => log.push(`Diagnostics: ${e}`));
    }
    throw error;
  } finally {
    child.kill();
  }
}
try {
  payload = Buffer.from("tampered payload");
  await scenario("tamper");
  payload = original;
  await scenario("upgrade");
  if (
    prerequisiteLog &&
    !(await readFile(prerequisiteLog)).equals(prerequisiteBytes)
  )
    throw new Error("Updater ran prerequisite provisioning");
  if (platform === "linux" && process.env.GITHUB_ACTIONS === "true") {
    const sudo = process.getuid() === 0 ? [] : ["sudo"];
    const dpkg = async (file) =>
      run(sudo[0] || "dpkg", sudo.length ? ["dpkg", "-i", file] : ["-i", file]);
    await dpkg(aFiles.find((p) => p.endsWith(".deb")));
    await scenario("local", "/usr/bin/codex-prism", async (state) => {
      await dpkg(packages.find((p) => p.endsWith(".deb")));
      await writeFile(join(state, "installed"), "ready");
    });
  }
} finally {
  server.close();
  await rm(keyPath, { force: true });
  await writeFile(join(root, "results.txt"), log.join("\n"));
}
console.log(log.join("\n"));
