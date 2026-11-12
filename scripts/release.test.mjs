import { normalizeAppDir, verifyAppDir } from "./appimage.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, rename, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  check,
  prepare,
  collect,
  validateVersion,
} from "./release.mjs";
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "prism-release-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "apps/desktop/src-tauri"), { recursive: true });
  for (const file of [
    "package.json",
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
  ])
    await writeFile(join(cwd, file), JSON.stringify({ version: "1.3.0" }));
  await writeFile(
    join(cwd, "apps/desktop/src-tauri/Cargo.toml"),
    '[package]\nname = "codex-prism-desktop"\nversion = "1.3.0"\n',
  );
  await writeFile(
    join(cwd, "apps/desktop/src-tauri/Cargo.lock"),
    'version = 4\n\n[[package]]\nname = "codex-prism-desktop"\nversion = "1.3.0"\n',
  );
  await writeFile(
    join(cwd, ".gitignore"),
    "dist/\napps/desktop/src-tauri/target/\n",
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "user.name", "Release test");
  git("add", ".");
  git("commit", "-m", "initial");
  git("tag", "v1.3.0");
  const bundle = join(
    cwd,
    "apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle",
  );
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "test.deb"), "package");
  await writeFile(join(bundle, "test.AppImage"), "image");
  return { cwd, git, bundle };
}
test("version preparation synchronizes every manifest and rejects invalid input", async (t) => {
  const { cwd } = await fixture(t);
  await prepare("2.0.0-rc.1", cwd);
  assert.equal(await check(cwd, "v2.0.0-rc.1"), "2.0.0-rc.1");
  for (const value of ["v1.0.0", "1.2", "1.2.3;echo", "1.2.3-01"])
    assert.throws(() => validateVersion(value));
  await assert.rejects(check(cwd, "v1.3.0"), /does not match/);
  await writeFile(join(cwd, "package.json"), '{"version":"9.0.0"}');
  await assert.rejects(check(cwd), /mismatch/);
});
test("version checks and preparation accept Windows CRLF Cargo manifests", async (t) => {
  const { cwd } = await fixture(t);
  for (const file of ["Cargo.toml", "Cargo.lock"]) {
    const path = join(cwd, "apps/desktop/src-tauri", file);
    await writeFile(path, (await readFile(path, "utf8")).replace(/\n/g, "\r\n"));
  }
  assert.equal(await check(cwd, "v1.3.0"), "1.3.0");
  await prepare("1.6.2", cwd);
  assert.equal(await check(cwd, "v1.6.2"), "1.6.2");
});
test("collect produces versioned installers and source provenance", async (t) => {
  const { cwd, git } = await fixture(t);
  const dir = await collect(cwd);
  const manifest = JSON.parse(await readFile(join(dir, "release.json")));
  assert.equal(manifest.commit, git("rev-parse", "HEAD"));
  assert.equal(manifest.dirty, false);
  assert.equal(
    manifest.artifacts[0].name,
    "codex-prism-1.3.0-linux-x86_64.deb",
  );
  assert.equal(manifest.artifacts[1].name, "codex-prism-1.3.0-x86_64.AppImage");
  assert.match(
    await readFile(join(dir, "SHA256SUMS"), "utf8"),
    /^[a-f0-9]{64}  codex-prism/,
  );
});
test("collect includes version-specific release notes and hashes their exact bytes", async (t) => {
  const { cwd } = await fixture(t);
  await mkdir(join(cwd, "docs/releases"), { recursive: true });
  const notes = "# Release notes\n\nTeX Live is required.\n";
  await writeFile(join(cwd, "docs/releases/1.3.0.md"), notes);
  const dir = await collect(cwd);
  assert.equal(await readFile(join(dir, "RELEASE_NOTES.md"), "utf8"), notes);
  const manifest = JSON.parse(await readFile(join(dir, "release.json")));
  const artifact = manifest.artifacts.find(
    (a) => a.name === "RELEASE_NOTES.md",
  );
  assert.equal(artifact.size, Buffer.byteLength(notes));
  const { createHash } = await import("node:crypto");
  assert.equal(
    artifact.sha256,
    createHash("sha256").update(notes).digest("hex"),
  );
});
// Windows stat/chmod do not represent the POSIX executable bits verified in
// an AppImage. Keep this complete package check on Linux and macOS.
test("AppDir icon survives relocation instead of depending on the build path", {
  skip: process.platform === "win32" ? "Requires POSIX executable permissions" : false,
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "prism-appdir-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "original");
  await mkdir(dir);
  const icon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await writeFile(join(dir, "prism.png"), icon);
  await writeFile(join(dir, "prism.desktop"), "[Desktop Entry]\nIcon=prism\n");
  await writeFile(join(dir, "AppRun"), "#!/bin/sh\nexit 0\n");
  await chmod(join(dir, "AppRun"), 0o755);
  await symlink(join(dir, "prism.png"), join(dir, ".DirIcon"));
  await normalizeAppDir(dir);
  const relocated = join(base, "relocated");
  await rename(dir, relocated);
  await verifyAppDir(relocated);
  assert.equal((await lstat(join(relocated, ".DirIcon"))).isSymbolicLink(), false);
  assert.deepEqual(await readFile(join(relocated, ".DirIcon")), icon);
  await rm(join(relocated, ".DirIcon"));
  await symlink(join(dir, "prism.png"), join(relocated, ".DirIcon"));
  await assert.rejects(verifyAppDir(relocated), /ENOENT/);
});

test("AppDir validation rejects icons outside the package", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "prism-appdir-invalid-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "app");
  await mkdir(dir);
  await writeFile(join(dir, "prism.desktop"), "[Desktop Entry]\nIcon=prism\n");
  await writeFile(join(base, "outside.png"), "external");
  await symlink(join(base, "outside.png"), join(dir, "prism.png"));
  await assert.rejects(normalizeAppDir(dir), /escapes/);
});

test("AppDir validation rejects a non-executable launcher", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "prism-appdir-permissions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const icon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await writeFile(join(dir, "prism.png"), icon);
  await writeFile(join(dir, "prism.desktop"), "[Desktop Entry]\nIcon=prism\n");
  await writeFile(join(dir, ".DirIcon"), icon);
  await writeFile(join(dir, "AppRun"), "#!/bin/sh\nexit 0\n");
  await chmod(join(dir, "AppRun"), 0o644);
  await assert.rejects(verifyAppDir(dir), /AppRun is not executable/);
});
