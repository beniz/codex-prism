import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, root, validateVersion } from "./release.mjs";

import { verifySignedFile } from "./updater-artifacts.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packages = [
  ["codex-prism-linux-x64", ".deb", "linux-x86_64.deb"],
  ["codex-prism-linux-x64", ".AppImage", "x86_64.AppImage"],
  ["codex-prism-windows-x64", "-setup.exe", "windows-x86_64-setup.exe"],
  ["codex-prism-macos-arm64", ".dmg", "macos-arm64.dmg"],
];

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function assemble(
  input,
  output,
  {
    version,
    commit,
    notes,
    publicKey = process.env.PRISM_UPDATE_PUBLIC_KEY,
    manualRelease = false,
  },
) {
  validateVersion(version);
  // Validate every platform before staging a release with missing packages.
  const selected = [];
  for (const [directory, extension, suffix] of packages) {
    const source = join(input, directory);
    // Upload-artifact preserves version folders after a wildcard in its path.
    const matches = (await filesBelow(source)).filter((path) =>
      path.endsWith(extension),
    );
    if (matches.length !== 1)
      throw new Error(
        `Expected one ${extension} in ${directory}; found ${matches.length}`,
      );
    selected.push([matches[0], `codex-prism-${version}-${suffix}`]);
  }
  const platforms = {};
  if (!manualRelease) {
    if (!publicKey)
      throw new Error("Release assembly requires PRISM_UPDATE_PUBLIC_KEY");
    const macFiles = await filesBelow(join(input, "codex-prism-macos-arm64"));
    const archives = macFiles.filter((path) => path.endsWith(".app.tar.gz"));
    if (archives.length !== 1)
      throw new Error("Expected one macOS updater archive");
    selected.push([
      archives[0],
      `codex-prism-${version}-macos-arm64.app.tar.gz`,
    ]);
    for (const [source, name] of [...selected]) {
      const target = name.endsWith(".AppImage")
        ? "linux-x86_64"
        : name.endsWith("-setup.exe")
          ? "windows-x86_64"
          : name.endsWith(".app.tar.gz")
            ? "darwin-aarch64"
            : null;
      if (!target) continue;
      const signature = await verifySignedFile(source, publicKey);
      platforms[target] = {
        signature,
        url: `https://github.com/beniz/codex-prism/releases/download/v${version}/${name}`,
      };
      selected.push([`${source}.sig`, `${name}.sig`]);
    }
  }
  await mkdir(output, { recursive: true });
  const artifacts = [];
  for (const [source, name] of selected) {
    const bytes = await readFile(source);
    await copyFile(source, join(output, name));
    artifacts.push({ name, size: bytes.length, sha256: sha256(bytes) });
  }
  const latest = `${JSON.stringify({ version, notes, platforms }, null, 2)}\n`;
  await writeFile(join(output, "latest.json"), latest);
  artifacts.push({
    name: "latest.json",
    size: Buffer.byteLength(latest),
    sha256: sha256(latest),
  });
  await writeFile(join(output, "RELEASE_NOTES.md"), notes);
  artifacts.push({
    name: "RELEASE_NOTES.md",
    size: Buffer.byteLength(notes),
    sha256: sha256(notes),
  });
  await writeFile(
    join(output, "release.json"),
    `${JSON.stringify({ version, commit, artifacts }, null, 2)}\n`,
  );
  const manifest = await readFile(join(output, "release.json"));
  await writeFile(
    join(output, "SHA256SUMS"),
    [
      ...artifacts.map(({ name, sha256: hash }) => `${hash}  ${name}`),
      `${sha256(manifest)}  release.json`,
    ].join("\n") + "\n",
  );
  return [
    ...artifacts.map(({ name }) => join(output, name)),
    join(output, "release.json"),
    join(output, "SHA256SUMS"),
  ];
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function uploadDraft(tag, files, { repo, run = gh }) {
  validateVersion(tag.replace(/^v/, ""));
  if (!tag.startsWith("v"))
    throw new Error("Expected a v-prefixed release tag");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? ""))
    throw new Error("Set GH_REPO to owner/repository");
  // Listing includes authenticated drafts; a missing tag is not inferred from
  // an HTTP error (which could instead mean a permission or network failure).
  const findRelease = () =>
    run([
      "api",
      `repos/${repo}/releases?per_page=100`,
      "--paginate",
      "--jq",
      ".[] | @json",
    ])
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((release) => release.tag_name === tag);
  let release = findRelease();
  if (!release) {
    const notes = files.find((path) => basename(path) === "RELEASE_NOTES.md");
    const url = run([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--verify-tag",
      "--draft",
      "--title",
      `codex-prism ${tag}`,
      "--notes-file",
      notes,
      ...(tag.includes("-") ? ["--prerelease"] : []),
    ]).trim();
    // A successful create made an empty draft. GitHub's list endpoint can lag
    // behind this write, so do not immediately re-read it before uploading.
    release = { draft: true, assets: [], html_url: url };
  }
  if (!release.draft) throw new Error("Refusing to modify a published release");
  // Check all collisions before uploading anything. No clobber: retries may
  // reuse identical artifacts, but must never silently replace a different build.
  const pending = [];
  for (const path of files) {
    const name = basename(path);
    const existing = release.assets.find((asset) => asset.name === name);
    if (!existing) {
      pending.push(path);
      continue;
    }
    if (existing.digest !== `sha256:${sha256(await readFile(path))}`)
      throw new Error(
        `Draft already contains a different or unverifiable ${name}; review and remove that asset before retrying`,
      );
  }
  for (const path of pending)
    run(["release", "upload", tag, path, "--repo", repo]);
  return release.html_url;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [tag, input, output] = process.argv.slice(2);
  if (!tag || !input || !output)
    throw new Error("Usage: node scripts/github-release.mjs TAG INPUT OUTPUT");
  const version = await check(root, tag);
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  if (git(["rev-parse", `refs/tags/${tag}^{commit}`]) !== commit)
    throw new Error("Checkout does not match the release tag");
  let notes;
  try {
    notes = await readFile(
      join(root, "docs/releases", `${version}.md`),
      "utf8",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    notes =
      `# codex-prism ${tag}\n\n` +
      "Packages for Ubuntu 26.04 x86_64 (.deb/AppImage), Windows 10/11 x64 (setup.exe), and macOS Apple Silicon (.dmg).\n\n" +
      "Windows setup provisions prerequisites. Linux and macOS require Codex and TeX installed separately. Windows packages are unsigned; macOS packages are ad-hoc signed and not notarized. Download and install new releases manually.\n";
  }
  const files = await assemble(resolve(input), resolve(output), {
    version,
    commit,
    notes,
    manualRelease: process.env.PRISM_MANUAL_RELEASE === "1",
  });
  console.log(
    `Draft release: ${await uploadDraft(tag, files, { repo: process.env.GH_REPO })}`,
  );
}
