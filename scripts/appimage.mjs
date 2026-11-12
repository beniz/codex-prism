// Normalize Tauri's AppImage metadata before release hashes are generated.
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

async function internalFile(dir, name) {
  const file = await realpath(join(dir, name));
  const rel = relative(await realpath(dir), file);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`AppDir entry escapes its directory: ${name}`);
  if (!(await lstat(file)).isFile()) throw new Error(`Not a file: ${name}`);
  return file;
}

async function appIcon(dir) {
  const desktop = (await readdir(dir)).filter((name) => name.endsWith(".desktop"));
  if (desktop.length !== 1) throw new Error("AppDir requires exactly one desktop file");
  const content = await readFile(await internalFile(dir, desktop[0]), "utf8");
  const icon = content.match(/^Icon=([^\r\n]+)$/m)?.[1];
  if (!icon || !/^[\w.-]+$/.test(icon)) throw new Error("Invalid AppDir Icon name");
  return internalFile(dir, `${icon}.png`);
}

async function png(file) {
  const data = await readFile(file);
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error("AppDir icon must be a PNG");
  return data;
}

export async function normalizeAppDir(dir) {
  const icon = await appIcon(dir);
  await png(icon);
  // Do not follow the old .DirIcon: it may point to an absolute build-machine path.
  await rm(join(dir, ".DirIcon"), { force: true });
  await copyFile(icon, join(dir, ".DirIcon"));
  await verifyAppDir(dir);
}

export async function verifyAppDir(dir) {
  await png(await appIcon(dir));
  await png(await internalFile(dir, ".DirIcon"));
  const entry = await internalFile(dir, "AppRun");
  if (!((await lstat(entry)).mode & 0o111)) throw new Error("AppRun is not executable");
}

export async function repairAppImage(input) {
  const image = resolve(input);
  const offset = Number(execFileSync(image, ["--appimage-offset"], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset > 16 * 1024 * 1024)
    throw new Error("Invalid AppImage filesystem offset");
  const temp = await mkdtemp(join(dirname(image), ".appimage-repair-"));
  try {
    const dir = join(temp, "AppDir");
    execFileSync("unsquashfs", ["-no-progress", "-o", String(offset), "-d", dir, image], { stdio: "ignore" });
    await normalizeAppDir(dir);
    const squash = join(temp, "filesystem");
    execFileSync("mksquashfs", [dir, squash, "-noappend", "-comp", "gzip", "-no-progress", "-processors", "2"], { stdio: "ignore" });
    const output = join(temp, "fixed.AppImage");
    const handle = await open(image, "r");
    const prefix = Buffer.alloc(offset);
    try {
      const { bytesRead } = await handle.read(prefix, 0, offset, 0);
      if (bytesRead !== offset) throw new Error("Truncated AppImage runtime");
    } finally {
      await handle.close();
    }
    const target = await open(output, "w", 0o755);
    try { await target.writeFile(prefix); } finally { await target.close(); }
    await pipeline(createReadStream(squash), createWriteStream(output, { flags: "a" }));
    await chmod(output, 0o755);
    // Validate the final image, not the build tree, in a different location.
    const checkDir = join(temp, "relocated");
    execFileSync("unsquashfs", ["-no-progress", "-o", String(offset), "-d", checkDir, output], { stdio: "ignore" });
    await verifyAppDir(checkDir);
    await rename(output, image);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
