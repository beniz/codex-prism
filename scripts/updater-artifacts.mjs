import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runTauriSync } from "./tauri-cli.mjs";

// Tauri signatures wrap the standard Minisign text format in base64.
export function verifyArtifact(bytes, encodedSignature, encodedKey) {
  const key = Buffer.from(
    Buffer.from(encodedKey.trim(), "base64")
      .toString("utf8")
      .trim()
      .split(/\r?\n/)[1] ?? "",
    "base64",
  );
  const lines = Buffer.from(encodedSignature.trim(), "base64")
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  const signature = Buffer.from(lines[1] ?? "", "base64");
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (
    key.length !== 42 ||
    signature.length !== 74 ||
    global.length !== 64 ||
    key.subarray(0, 2).toString() !== "Ed" ||
    !lines[2]?.startsWith("trusted comment: ") ||
    !key.subarray(2, 10).equals(signature.subarray(2, 10))
  )
    throw new Error("Invalid updater signature or signing key");
  const algorithm = signature.subarray(0, 2).toString();
  if (!["ED", "Ed"].includes(algorithm))
    throw new Error("Unknown updater signature algorithm");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const payload =
    algorithm === "ED"
      ? createHash("blake2b512").update(bytes).digest()
      : bytes;
  if (
    !verify(null, payload, publicKey, signature.subarray(10)) ||
    !verify(
      null,
      Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice(17))]),
      publicKey,
      global,
    )
  )
    throw new Error("Updater signature verification failed");
}
export async function verifySignedFile(path, publicKey) {
  const signature = (await readFile(`${path}.sig`, "utf8")).trim();
  verifyArtifact(await readFile(path), signature, publicKey);
  return signature;
}
export function signArtifact(path) {
  if (
    !process.env.TAURI_SIGNING_PRIVATE_KEY ||
    !process.env.PRISM_UPDATE_PUBLIC_KEY
  )
    throw new Error("Signed builds require updater private and public keys");
  // Keep private key in the child environment, never in arguments or logs.
  runTauriSync(["signer", "sign", path], { stdio: "inherit" });
}
