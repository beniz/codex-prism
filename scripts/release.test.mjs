import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  check,
  prepare,
  collect,
  publish,
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
  assert.match(
    await readFile(join(dir, "SHA256SUMS"), "utf8"),
    /^[a-f0-9]{64}  codex-prism/,
  );
});
test("publisher validates remote tag and uploads a draft through the Gitea API", async (t) => {
  const { cwd, git } = await fixture(t);
  await collect(cwd);
  const calls = [];
  const uploads = new Map();
  let exists = false;
  const fetchImpl = async (input, options) => {
    const url = String(input);
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, "token test-token");
    const json = (value) => Response.json(value);
    if (url.includes("/download/"))
      return new Response(uploads.get(url.split("/download/")[1]));
    if (url.endsWith("/tags/v1.3.0") && !url.includes("/releases/"))
      return json({ commit: { sha: git("rev-parse", "HEAD") } });
    if (url.endsWith("/releases/tags/v1.3.0"))
      return exists
        ? json({
            id: 7,
            draft: true,
            html_url: "https://git.jolibrain.com/release/7",
          })
        : new Response(null, { status: 404 });
    if (options.method === "POST" && url.endsWith("/releases")) {
      const body = JSON.parse(options.body);
      assert.equal(body.draft, true);
      exists = true;
      return json({ id: 7, html_url: "https://git.jolibrain.com/release/7" });
    }
    if (url.endsWith("/assets"))
      return json(
        [...uploads.keys()].map((name) => ({
          name,
          browser_download_url: `https://git.jolibrain.com/download/${name}`,
        })),
      );
    if (options.method === "POST" && url.includes("/assets?")) {
      const file = options.body.get("attachment");
      uploads.set(file.name, await file.arrayBuffer());
      return json({ id: uploads.size });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  assert.equal(
    await publish({ cwd, token: "test-token", fetchImpl }),
    "https://git.jolibrain.com/release/7",
  );
  assert.equal(uploads.size, 5);
  const count = calls.filter((c) => c.options.method === "POST").length;
  await publish({ cwd, token: "test-token", fetchImpl });
  assert.equal(calls.filter((c) => c.options.method === "POST").length, count);
  const dir = join(cwd, "dist/releases/v1.3.0");
  await writeFile(join(dir, "codex-prism-1.3.0-linux-x86_64.deb"), "tampered");
  await assert.rejects(
    publish({ cwd, token: "test-token", fetchImpl }),
    /Checksum mismatch/,
  );
});
test("dirty artifacts cannot be published even after committing", async (t) => {
  const { cwd, git } = await fixture(t);
  await writeFile(join(cwd, "change.txt"), "change");
  await collect(cwd);
  git("add", ".");
  git("commit", "-m", "change");
  git("tag", "-f", "v1.3.0");
  await assert.rejects(
    publish({ cwd, token: "test-token" }),
    /clean, tagged checkout/,
  );
});

test("publisher refuses mismatched remote tags and already published releases", async (t) => {
  const { cwd, git } = await fixture(t);
  await collect(cwd);
  let writes = 0;
  const wrongTag = async (_url, options) => {
    if (options.method === "POST") writes++;
    return Response.json({ commit: { sha: "wrong" } });
  };
  await assert.rejects(
    publish({ cwd, token: "test-token", fetchImpl: wrongTag }),
    /matching release tag/,
  );
  const publicRelease = async (url, options) => {
    if (options.method === "POST") writes++;
    return Response.json(
      String(url).includes("/releases/")
        ? { id: 7, draft: false }
        : { commit: { sha: git("rev-parse", "HEAD") } },
    );
  };
  await assert.rejects(
    publish({ cwd, token: "test-token", fetchImpl: publicRelease }),
    /already published/,
  );
  assert.equal(writes, 0);
});
