import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTauri, runTauriSync } from "./tauri-cli.mjs";
import { verifySignedFile } from "./updater-artifacts.mjs";

test("Tauri launcher generates and signs with literal arguments and spaced paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "prism cli & spaces "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, "test key");
  const password = "test password & %PRISM_TEST_LITERAL%";
  const child = spawnTauri(
    ["signer", "generate", "--ci", "-w", key, "-p", password],
    { stdio: "ignore" },
  );
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, "signer generation must preserve argument boundaries");
  const payload = join(directory, "payload with spaces & percent%.bin");
  await writeFile(payload, "updater launcher regression fixture");
  const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
  runTauriSync(["signer", "sign", payload], {
    stdio: "ignore",
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: (await readFile(key, "utf8")).trim(),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
    },
  });
  await verifySignedFile(payload, publicKey);
});
