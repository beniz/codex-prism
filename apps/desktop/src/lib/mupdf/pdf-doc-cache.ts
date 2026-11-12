import { getMupdfClient, type RequestOptions } from "./mupdf-client";
import type { PageSize } from "./types";

interface CachedDoc {
  docId: number;
  pageSizes: PageSize[];
  refs: number;
  retired: boolean;
  close(): Promise<void>;
}
export interface DocCacheResult {
  docId: number;
  pageSizes: PageSize[];
  cacheHit: boolean;
  /** Each acquisition owns one reference, including cache hits. */
  release(): void;
}
const cache = new Map<string, CachedDoc>();
const opening = new Map<string, Promise<CachedDoc>>();
const hashes = new WeakMap<
  ArrayBufferLike,
  Map<string, string | Promise<string>>
>();
let epoch = 0;
function hashSlot(data: Uint8Array) {
  let map = hashes.get(data.buffer);
  if (!map) {
    map = new Map();
    hashes.set(data.buffer, map);
  }
  return { map, range: `${data.byteOffset}:${data.byteLength}` };
}
function knownKey(
  data: Uint8Array,
  artifactId?: string,
  scope = "",
): string | undefined {
  if (artifactId) return JSON.stringify([scope, "artifact", artifactId]);
  const { map, range } = hashSlot(data);
  const hash = map.get(range);
  return typeof hash === "string"
    ? JSON.stringify([scope, "sha256", hash])
    : undefined;
}
async function identity(data: Uint8Array, artifactId?: string, scope = "") {
  const known = knownKey(data, artifactId, scope);
  if (known) return known;
  const { map, range } = hashSlot(data);
  let hash = map.get(range);
  if (!hash) {
    const promise = crypto.subtle
      .digest("SHA-256", data.slice().buffer)
      .then((bytes) => {
        const value = Array.from(new Uint8Array(bytes), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        map.set(range, value);
        return value;
      })
      .catch((error) => {
        map.delete(range);
        throw error;
      });
    map.set(range, promise);
    hash = promise;
  }
  return JSON.stringify([scope, "sha256", await hash]);
}
function retire(entry: CachedDoc) {
  if (entry.retired) return;
  entry.retired = true;
  if (!entry.refs) void entry.close().catch(() => {});
}
function trim() {
  while (cache.size > 5) {
    const victim = [...cache].find(([, entry]) => !entry.refs);
    if (!victim) return; // Mounted viewers own leases; never evict their documents.
    cache.delete(victim[0]);
    retire(victim[1]);
  }
}
function lease(entry: CachedDoc, cacheHit: boolean): DocCacheResult {
  entry.refs++;
  let released = false;
  return {
    docId: entry.docId,
    pageSizes: entry.pageSizes,
    cacheHit,
    release() {
      if (released) return;
      released = true;
      entry.refs--;
      if (entry.retired && !entry.refs) void entry.close().catch(() => {});
      trim();
    },
  };
}
export function getCachedDocument(
  data: Uint8Array,
  artifactId?: string,
  scope = "",
): DocCacheResult | null {
  const key = knownKey(data, artifactId, scope);
  const entry = key ? cache.get(key) : undefined;
  if (!entry || entry.retired) return null;
  cache.delete(key!);
  cache.set(key!, entry);
  return lease(entry, true);
}
export async function getOrOpenDocument(
  data: Uint8Array,
  artifactId?: string,
  scope = "",
  options?: RequestOptions,
): Promise<DocCacheResult> {
  const startedEpoch = epoch;
  const key = await identity(data, artifactId, scope);
  if (startedEpoch !== epoch) throw new DOMException("Cancelled", "AbortError");
  const hit = getCachedDocument(data, artifactId, scope);
  if (hit) return hit;
  let pending = opening.get(key);
  if (!pending) {
    pending = (async () => {
      const client = getMupdfClient();
      const docId = await client.openDocument(
        data.slice().buffer,
        undefined,
        options,
      );
      try {
        if (startedEpoch !== epoch)
          throw new DOMException("Cancelled", "AbortError");
        const pageSizes = await client.getAllPageSizes(docId, options);
        if (startedEpoch !== epoch)
          throw new DOMException("Cancelled", "AbortError");
        const entry: CachedDoc = {
          docId,
          pageSizes,
          refs: 0,
          retired: false,
          close: () => client.closeDocument(docId),
        };
        cache.set(key, entry);
        return entry;
      } catch (error) {
        await client.closeDocument(docId).catch(() => {});
        throw error;
      }
    })();
    opening.set(key, pending);
  }
  try {
    const entry = await pending;
    if (startedEpoch !== epoch || entry.retired)
      throw new DOMException("Cancelled", "AbortError");
    const result = lease(entry, false);
    trim();
    return result;
  } finally {
    if (opening.get(key) === pending) opening.delete(key);
  }
}
export async function clearDocCache(): Promise<void> {
  epoch++;
  opening.clear();
  getMupdfClient().clearPageCache?.();
  const entries = [...cache.values()];
  cache.clear();
  for (const entry of entries) retire(entry);
}
