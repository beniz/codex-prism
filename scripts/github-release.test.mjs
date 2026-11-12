import { updaterConfig } from "./updater-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { assemble, uploadDraft } from "./github-release.mjs";

function signingFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const id = Buffer.alloc(8, 7);
  const rawKey = Buffer.concat([
    Buffer.from("Ed"),
    id,
    publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ]);
  const encodedKey = Buffer.from(
    `untrusted comment: test key\n${rawKey.toString("base64")}\n`,
  ).toString("base64");
  return {
    encodedKey,
    signature(bytes) {
      const signature = sign(
        null,
        createHash("blake2b512").update(bytes).digest(),
        privateKey,
      );
      const raw = Buffer.concat([Buffer.from("ED"), id, signature]);
      const comment = "test fixture";
      const global = sign(
        null,
        Buffer.concat([signature, Buffer.from(comment)]),
        privateKey,
      );
      return Buffer.from(
        `untrusted comment: test signature\n${raw.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`,
      ).toString("base64");
    },
  };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "prism-github-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "artifacts"),
    output = join(dir, "release");
  const keys = signingFixture();
  for (const [platform, names] of [
    ["linux-x64", ["app.deb", "app.AppImage"]],
    ["windows-x64", ["app-setup.exe"]],
    ["macos-arm64", ["app.dmg", "app.app.tar.gz"]],
  ]) {
    const folder = join(input, `codex-prism-${platform}`);
    await mkdir(folder, { recursive: true });
    for (const name of names) {
      const bytes = Buffer.from(`bytes:${name}`);
      await writeFile(join(folder, name), bytes);
      if (!name.endsWith(".dmg") && !name.endsWith(".deb"))
        await writeFile(join(folder, `${name}.sig`), keys.signature(bytes));
    }
  }
  return {
    input,
    output,
    options: {
      version: "1.6.2",
      commit: "abc123",
      notes: "Release notes\n",
      publicKey: keys.encodedKey,
    },
  };
}

test("assembles all platforms with distinct names, source commit, and verified checksums", async (t) => {
  const { input, output, options } = await fixture(t);
  const files = await assemble(input, output, options);
  assert.equal(files.length, 12);
  assert.ok(files.some((p) => p.endsWith("windows-x86_64-setup.exe")));
  assert.ok(files.some((p) => p.endsWith("macos-arm64.dmg")));
  const manifest = JSON.parse(await readFile(join(output, "release.json")));
  assert.equal(manifest.commit, options.commit);
  for (const line of (await readFile(join(output, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n")) {
    const [hash, name] = line.split("  ");
    assert.equal(
      hash,
      createHash("sha256")
        .update(await readFile(join(output, name)))
        .digest("hex"),
    );
  }
});

test("finds Linux packages inside the version folder preserved by artifact upload", async (t) => {
  const { input, output, options } = await fixture(t);
  const linux = join(input, "codex-prism-linux-x64");
  const versioned = join(linux, "v1.6.2");
  await mkdir(versioned);
  for (const name of ["app.deb", "app.AppImage", "app.AppImage.sig"])
    await rename(join(linux, name), join(versioned, name));
  const files = await assemble(input, output, options);
  assert.equal(files.length, 12);
  assert.equal(
    await readFile(join(output, "codex-prism-1.6.2-x86_64.AppImage"), "utf8"),
    "bytes:app.AppImage",
  );
});

test("missing or duplicate platform packages prevent release assembly", async (t) => {
  const { input, output, options } = await fixture(t);
  const installer = join(input, "codex-prism-windows-x64", "app-setup.exe");
  await rm(installer);
  await assert.rejects(
    assemble(input, output, options),
    /Expected one -setup.exe/,
  );
  await writeFile(installer, "one");
  await writeFile(
    join(input, "codex-prism-windows-x64", "other-setup.exe"),
    "two",
  );
  await assert.rejects(assemble(input, output, options), /found 2/);
});

test("draft retries reuse identical assets and reject changed or published assets", async (t) => {
  const { input, output, options } = await fixture(t);
  const files = await assemble(input, output, options);
  const assets = await Promise.all(
    files.map(async (path) => ({
      name: basename(path),
      digest: `sha256:${createHash("sha256")
        .update(await readFile(path))
        .digest("hex")}`,
    })),
  );
  const release = {
    tag_name: "v1.6.2",
    draft: true,
    assets,
    html_url: "https://example.test/draft",
  };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return [
      JSON.stringify({ ...release, tag_name: "v9.9.9" }),
      JSON.stringify(release),
    ].join("\n");
  };
  assert.equal(
    await uploadDraft("v1.6.2", files, { repo: "owner/repo", run }),
    release.html_url,
  );
  assert.equal(calls.length, 1);
  release.assets[0].digest = "sha256:different";
  await assert.rejects(
    uploadDraft("v1.6.2", files, { repo: "owner/repo", run }),
    /different or unverifiable/,
  );
  assert.ok(calls.every((args) => args[0] === "api"));
  release.draft = false;
  await assert.rejects(
    uploadDraft("v1.6.2", files, { repo: "owner/repo", run }),
    /published release/,
  );
});

test("creates only a draft for an existing tag; authentication errors do not create releases", async (t) => {
  const { input, output, options } = await fixture(t);
  const files = await assemble(input, output, options);
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (calls.length === 1) return "";
    if (args[0] === "api")
      throw new Error("Draft listing has not caught up yet");
    return args[1] === "create" ? "https://example.test/draft\n" : "";
  };
  assert.equal(
    await uploadDraft("v1.6.2-rc.1", files, { repo: "owner/repo", run }),
    "https://example.test/draft",
  );
  assert.equal(calls.filter((args) => args[0] === "api").length, 1);
  assert.ok(
    calls[1].includes("--draft") &&
      calls[1].includes("--verify-tag") &&
      calls[1].includes("--prerelease"),
  );
  assert.equal(
    calls.filter((args) => args[1] === "upload").length,
    files.length,
  );
  await assert.rejects(
    uploadDraft("v1.6.2", files, {
      repo: "owner/repo",
      run: () => {
        throw Object.assign(new Error("unauthorized"), { stderr: "HTTP 401" });
      },
    }),
    /unauthorized/,
  );
});

test("rejects tampered packages and missing signatures before staging releases", async (t) => {
  const { input, output, options } = await fixture(t);
  await writeFile(
    join(input, "codex-prism-linux-x64", "app.AppImage"),
    "tampered",
  );
  await assert.rejects(
    assemble(input, output, options),
    /signature verification failed/,
  );
});
test("update manifest contains immutable release URLs and verified signatures", async (t) => {
  const { input, output, options } = await fixture(t);
  await assemble(input, output, options);
  const feed = JSON.parse(await readFile(join(output, "latest.json"), "utf8"));
  assert.equal(feed.version, options.version);
  assert.deepEqual(Object.keys(feed.platforms).sort(), [
    "darwin-aarch64",
    "linux-x86_64",
    "windows-x86_64",
  ]);
  assert.ok(
    Object.values(feed.platforms).every(
      (p) =>
        p.signature &&
        p.url.includes(`/releases/download/v${options.version}/`),
    ),
  );
});

test("missing updater signature prevents draft assembly", async (t) => {
  const { input, output, options } = await fixture(t);
  await rm(join(input, "codex-prism-windows-x64", "app-setup.exe.sig"));
  await assert.rejects(assemble(input, output, options), /ENOENT/);
});
test("bundler configuration contains only the public signing key", async () => {
  const previous = [
    process.env.TAURI_SIGNING_PRIVATE_KEY,
    process.env.PRISM_UPDATE_PUBLIC_KEY,
  ];
  let path;
  try {
    process.env.TAURI_SIGNING_PRIVATE_KEY = "test-private-key";
    process.env.PRISM_UPDATE_PUBLIC_KEY = "test-public-key";
    path = updaterConfig();
    const contents = await readFile(path, "utf8");
    assert.equal(contents.includes("test-private-key"), false);
    assert.equal(
      JSON.parse(contents).plugins.updater.pubkey,
      "test-public-key",
    );
    delete process.env.PRISM_UPDATE_PUBLIC_KEY;
    assert.throws(updaterConfig, /require updater private and public keys/);
  } finally {
    for (const [i, key] of [
      "TAURI_SIGNING_PRIVATE_KEY",
      "PRISM_UPDATE_PUBLIC_KEY",
    ].entries()) {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    }
    if (path) await rm(dirname(path), { recursive: true, force: true });
  }
});
