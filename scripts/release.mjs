import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  stat,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsonFiles = [
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];
const cargoFile = "apps/desktop/src-tauri/Cargo.toml";
const lockFile = "apps/desktop/src-tauri/Cargo.lock";
const crateVersion =
  /(\[\[package\]\]\nname = "codex-prism-desktop"\nversion = ")[^"]+(")/;
export function validateVersion(version) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(
      version ?? "",
    )
  )
    throw new Error(
      "Expected a version such as 1.3.1 or 1.4.0-rc.1 (without v)",
    );
  const suffix = version.split("-").slice(1).join("-");
  if (suffix.split(".").some((part) => /^0\d+$/.test(part)))
    throw new Error(
      "Numeric prerelease identifiers cannot have leading zeroes",
    );
  return version;
}
function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
export async function versions(cwd = root) {
  const entries = await Promise.all(
    jsonFiles.map(async (file) => [
      file,
      JSON.parse(await readFile(join(cwd, file), "utf8")).version,
    ]),
  );
  entries.push([
    cargoFile,
    (await readFile(join(cwd, cargoFile), "utf8")).match(
      /^version = "([^"]+)"/m,
    )?.[1],
  ]);
  entries.push([
    lockFile,
    (await readFile(join(cwd, lockFile), "utf8")).match(
      /\[\[package\]\]\nname = "codex-prism-desktop"\nversion = "([^"]+)"/,
    )?.[1],
  ]);
  return entries;
}
export async function check(cwd = root, tag) {
  const entries = await versions(cwd);
  const version = validateVersion(entries[0][1]);
  if (entries.some(([, value]) => value !== version))
    throw new Error(`Version mismatch: ${JSON.stringify(entries)}`);
  if (tag && tag !== `v${version}`)
    throw new Error(`Tag ${tag} does not match v${version}`);
  return version;
}
export async function prepare(version, cwd = root) {
  validateVersion(version);
  const updates = [];
  for (const file of jsonFiles) {
    const data = JSON.parse(await readFile(join(cwd, file), "utf8"));
    data.version = version;
    updates.push([file, `${JSON.stringify(data, null, 2)}\n`]);
  }
  const cargo = await readFile(join(cwd, cargoFile), "utf8");
  const lock = await readFile(join(cwd, lockFile), "utf8");
  if (!/^version = "[^"]+"/m.test(cargo) || !crateVersion.test(lock))
    throw new Error("Cannot find application Cargo version");
  updates.push([
    cargoFile,
    cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`),
  ]);
  updates.push([
    lockFile,
    lock.replace(
      crateVersion,
      (_match, prefix, suffix) => `${prefix}${version}${suffix}`,
    ),
  ]);
  for (const [file, contents] of updates)
    await writeFile(join(cwd, file), contents);
}
async function hash(path) {
  const h = createHash("sha256");
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return h.digest("hex");
}
async function filesBelow(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
export async function collect(cwd = root) {
  const version = await check(cwd);
  const bundle = join(
    cwd,
    "apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle",
  );
  const files = await filesBelow(bundle);
  const dir = join(cwd, "dist/releases", `v${version}`);
  await mkdir(dir, { recursive: true });
  const artifacts = [];
  for (const extension of ["deb", "AppImage"]) {
    const matches = files.filter((file) => file.endsWith(`.${extension}`));
    if (matches.length !== 1)
      throw new Error(
        `Expected exactly one ${extension} in ${bundle}; found ${matches.length}`,
      );
    const name = `codex-prism-${version}-linux-x86_64.${extension}`;
    const destination = join(dir, name);
    await copyFile(matches[0], destination);
    artifacts.push({
      name,
      size: (await stat(destination)).size,
      sha256: await hash(destination),
    });
  }
  const notes = `# codex-prism v${version}\n\nUbuntu 26.04 LTS x86_64 desktop release.\n\nInstall the .deb on an Ubuntu 26.04 system, or make the AppImage executable and run it.\n\nRequires the Codex CLI installed separately and authenticated with codex login. Automatic updates are not enabled.\n`;
  await writeFile(join(dir, "RELEASE_NOTES.md"), notes);
  artifacts.push({
    name: "RELEASE_NOTES.md",
    size: Buffer.byteLength(notes),
    sha256: await hash(join(dir, "RELEASE_NOTES.md")),
  });
  await writeFile(
    join(dir, "SHA256SUMS"),
    artifacts.map((a) => `${a.sha256}  ${a.name}\n`).join(""),
  );
  const manifest = {
    version,
    platform: "ubuntu-26.04-x86_64",
    commit: git(["rev-parse", "HEAD"], cwd),
    dirty: !!git(["status", "--porcelain"], cwd),
    artifacts,
  };
  await writeFile(
    join(dir, "release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return dir;
}
export async function publish({
  cwd = root,
  token = process.env.GITEA_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!token)
    throw new Error(
      "Set GITEA_TOKEN to a Gitea token with repository release write permission",
    );
  const version = await check(cwd);
  const tag = `v${version}`;
  const commit = git(["rev-parse", "HEAD"], cwd);
  if (git(["status", "--porcelain"], cwd))
    throw new Error("Commit all changes before publishing");
  if (git(["rev-parse", `${tag}^{commit}`], cwd) !== commit)
    throw new Error("Release tag must point to HEAD");
  const dir = join(cwd, "dist/releases", tag);
  const manifest = JSON.parse(
    await readFile(join(dir, "release.json"), "utf8"),
  );
  if (
    manifest.version !== version ||
    manifest.commit !== commit ||
    manifest.dirty
  )
    throw new Error(
      "Build artifacts from this clean, tagged checkout before publishing",
    );
  for (const artifact of manifest.artifacts) {
    if (artifact.name !== artifact.name.split(/[\\/]/).pop())
      throw new Error("Invalid artifact path");
    if ((await hash(join(dir, artifact.name))) !== artifact.sha256)
      throw new Error(`Checksum mismatch: ${artifact.name}`);
  }
  const sums = manifest.artifacts
    .map((a) => `${a.sha256}  ${a.name}\n`)
    .join("");
  if ((await readFile(join(dir, "SHA256SUMS"), "utf8")) !== sums)
    throw new Error("SHA256SUMS does not match the manifest");
  const server = "https://git.jolibrain.com";
  const base = `${server}/api/v1/repos/beniz/codex-prism`;
  const headers = { Authorization: `token ${token}` };
  async function request(path, options = {}, allow404 = false) {
    const response = await fetchImpl(`${base}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
      redirect: "error",
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `Gitea ${options.method ?? "GET"} ${path}: HTTP ${response.status}`,
      );
    return response.json();
  }
  const remoteTag = await request(`/tags/${tag}`);
  if (remoteTag.commit?.sha !== commit)
    throw new Error("Push the matching release tag to Gitea before uploading");
  let release = await request(`/releases/tags/${tag}`, {}, true);
  if (release && !release.draft)
    throw new Error(
      "Release is already published; existing public releases are not modified",
    );
  if (!release)
    release = await request("/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: commit,
        name: `codex-prism ${tag}`,
        draft: true,
        prerelease: version.includes("-"),
        body: await readFile(join(dir, "RELEASE_NOTES.md"), "utf8"),
      }),
    });
  const assets = await request(`/releases/${release.id}/assets`);
  for (const name of [
    ...manifest.artifacts.map((a) => a.name),
    "SHA256SUMS",
    "release.json",
  ]) {
    const existing = assets.find((a) => a.name === name);
    if (existing) {
      const url = new URL(existing.browser_download_url);
      if (url.origin !== server)
        throw new Error("Unexpected asset download host");
      const response = await fetchImpl(url, { headers, redirect: "error" });
      if (!response.ok) throw new Error(`Cannot verify existing asset ${name}`);
      const digest = createHash("sha256");
      for await (const chunk of response.body) digest.update(chunk);
      if (digest.digest("hex") !== (await hash(join(dir, name))))
        throw new Error(
          `Existing asset differs: ${name}. Remove the conflicting draft asset before retrying.`,
        );
      continue;
    }
    const body = new FormData();
    body.set("attachment", await openAsBlob(join(dir, name)), name);
    await request(
      `/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      { method: "POST", body },
    );
  }
  return release.html_url;
}
async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "prepare") {
    if (git(["status", "--porcelain"]))
      throw new Error("Commit current changes before preparing a release");
    await prepare(argument);
    console.log(
      `Prepared v${argument}. Review and commit the version changes, then tag and push. See docs/releases/README.md.`,
    );
  } else if (command === "check")
    console.log(`Version ${await check(root, argument)} is consistent`);
  else if (command === "build") {
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new Error("Releases currently target Linux x86_64 only");
    await check();
    const os = await readFile("/etc/os-release", "utf8");
    if (
      !/^ID=["']?ubuntu["']?$/m.test(os) ||
      !/^VERSION_ID=["']?26\.04["']?$/m.test(os)
    )
      throw new Error(
        "Build release packages on Ubuntu 26.04 (use build:desktop for other local builds)",
      );
    for (const command of [
      "patchelf",
      "rsvg-convert",
      "file",
      "wget",
      "curl",
    ]) {
      try {
        execFileSync("which", [command], { stdio: "ignore" });
      } catch {
        throw new Error(
          `Missing release dependency: ${command}. See docs/releases/README.md.`,
        );
      }
    }
    await rm(
      join(
        root,
        "apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle",
      ),
      { recursive: true, force: true },
    );
    execFileSync(
      "corepack",
      [
        "pnpm",
        "--filter=@codex-prism/desktop",
        "tauri",
        "build",
        "--target",
        "x86_64-unknown-linux-gnu",
        "--bundles",
        "deb,appimage",
        "--config",
        "src-tauri/tauri.local-build.conf.json",
        "--",
        "--locked",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          APPIMAGE_EXTRACT_AND_RUN: "1",
        },
      },
    );
    console.log(`Release files: ${await collect()}`);
  } else if (command === "publish")
    console.log(`Draft release: ${await publish()}`);
  else
    console.log(
      "Usage: corepack pnpm release <prepare VERSION|check [TAG]|build|publish>\nSee docs/releases/README.md for local and Gitea Actions releases.",
    );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
