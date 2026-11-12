import type { MupdfClient, RequestOptions } from "./mupdf-client";
import { PageCache } from "./page-cache";

type Priority = "foreground" | "background";
type Method = Exclude<keyof MupdfClient, "destroy" | "openDocument">;
interface DocumentRecord {
  id: number;
  bytes: ArrayBuffer;
  magic: string;
  closing: boolean;
  close?: Promise<void>;
}
interface Slot {
  client: MupdfClient;
  failed: boolean;
  busy: boolean;
  background: boolean;
  replicas: Map<number, number>;
}
interface Consumer {
  priority: Priority;
  owner?: string;
  finish(error?: unknown, result?: unknown): void;
}
interface Job {
  doc: DocumentRecord;
  method: Method | "openDocument";
  args: unknown[];
  consumers: Set<Consumer>;
  target?: Slot;
  started: boolean;
  retries: number;
  key?: string;
  cacheEpoch: number;
}
const cancelled = () => new DOMException("Cancelled", "AbortError");
export interface MupdfPool extends MupdfClient {
  clearPageCache(): void;
  promotePage(
    docId: number,
    page: number,
    ownerId: string | undefined,
    priority: Priority,
  ): void;
  peekPage(docId: number, page: number, dpi: number): ImageData | undefined;
}

/** Logical document IDs never escape into the transport; each worker owns separate replicas. */
export function createMupdfPool(
  factory: (onFatal: (error: Error) => void) => MupdfClient,
): MupdfPool {
  const docs = new Map<number, DocumentRecord>();
  const slots: Slot[] = [];
  const queue: Job[] = [];
  const renders = new Map<string, Job>();
  const affinity = new Map<string, Slot>();
  const cache = new PageCache();
  let nextId = 1;
  let cacheEpoch = 0;
  let limit = 2;
  let fatal: Error | undefined;
  let pumping = false;
  const keyFor = (doc: number, page: number, dpi: number) =>
    `${doc}:${page}:${dpi}`;
  const foreground = (job: Job) =>
    [...job.consumers].some((c) => c.priority === "foreground");
  const rank = (job: Job) =>
    job.method === "closeDocument" ? 0 : foreground(job) ? 1 : 2;
  function finish(job: Job, error?: unknown, result?: unknown) {
    if (job.key && renders.get(job.key) === job) renders.delete(job.key);
    for (const consumer of [...job.consumers]) consumer.finish(error, result);
    job.args = [];
  }
  function stopIfEmpty() {
    if (docs.size || queue.length || slots.some((s) => s.busy)) return;
    for (const slot of slots) slot.client.destroy();
    slots.length = 0;
    affinity.clear();
    cache.clear();
  }
  function makeSlot() {
    const slot: Slot = {
      client: undefined as unknown as MupdfClient,
      failed: false,
      busy: false,
      background: false,
      replicas: new Map(),
    };
    try {
      slot.client = factory((error) => {
        slot.failed = true;
        slot.replicas.clear();
        limit = 1;
        if (!slots.some((s) => s !== slot && !s.failed)) fatal = error;
        pump();
      });
    } catch (error) {
      limit = 1;
      if (!slots.some((s) => !s.failed))
        fatal = error instanceof Error ? error : new Error(String(error));
      return undefined;
    }
    slots.push(slot);
    return slot;
  }
  async function replica(slot: Slot, doc: DocumentRecord) {
    const existing = slot.replicas.get(doc.id);
    if (existing !== undefined) {
      slot.replicas.delete(doc.id);
      slot.replicas.set(doc.id, existing);
      return existing;
    }
    if (slot.replicas.size >= 5) {
      const [id, local] = slot.replicas.entries().next().value!;
      await slot.client.closeDocument(local);
      slot.replicas.delete(id);
    }
    if (doc.closing) throw cancelled();
    const local = await slot.client.openDocument(doc.bytes.slice(0), doc.magic);
    slot.replicas.set(doc.id, local);
    return local;
  }
  async function run(slot: Slot, job: Job) {
    slot.busy = true;
    slot.background = rank(job) === 2;
    job.started = true;
    try {
      if (job.method === "closeDocument") {
        const local = slot.replicas.get(job.doc.id);
        if (local !== undefined && !slot.failed)
          await slot.client.closeDocument(local);
        slot.replicas.delete(job.doc.id);
        finish(job);
      } else {
        const local = await replica(slot, job.doc);
        if (job.doc.closing) throw cancelled();
        // Abort may happen while an indispensable open is running.
        if (!job.consumers.size) return;
        const result =
          job.method === "openDocument"
            ? job.doc.id
            : await (
                slot.client[job.method] as (...args: any[]) => Promise<unknown>
              )(local, ...job.args);
        if (job.doc.closing) throw cancelled();
        if (job.key && job.consumers.size && job.cacheEpoch === cacheEpoch)
          cache.set(job.key, result as ImageData);
        finish(job, undefined, result);
      }
    } catch (error) {
      if (job.method === "closeDocument")
        finish(job); // A terminated worker already freed its documents.
      else if (
        slot.failed &&
        !fatal &&
        !job.doc.closing &&
        job.consumers.size &&
        job.retries++ === 0
      ) {
        job.started = false;
        queue.unshift(job);
      } else finish(job, error);
    } finally {
      if (!job.consumers.size && job.key && renders.get(job.key) === job)
        renders.delete(job.key);
      slot.busy = false;
      slot.background = false;
      pump();
      stopIfEmpty();
    }
  }
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      queue.sort((a, b) => rank(a) - rank(b));
      for (let i = 0; i < queue.length; ) {
        const job = queue[i];
        if (fatal && job.method !== "closeDocument") {
          queue.splice(i, 1);
          finish(job, fatal);
          continue;
        }
        if (job.target?.failed) {
          queue.splice(i, 1);
          finish(job);
          continue;
        }
        if (rank(job) === 2 && slots.some((s) => s.busy && s.background)) {
          i++;
          continue;
        }
        const available = slots.filter(
          (s) => !s.failed && !s.busy && (!job.target || job.target === s),
        );
        const owner = [...job.consumers].find((c) => c.owner)?.owner;
        let slot: Slot | undefined =
          available.find((s) => s.replicas.has(job.doc.id)) ??
          available.find((s) => owner && affinity.get(owner) === s) ??
          available[0];
        if (
          !slot &&
          !job.target &&
          slots.filter((s) => !s.failed).length < limit &&
          !fatal &&
          (!slots.length || foreground(job))
        )
          slot = makeSlot();
        if (!slot) {
          if (fatal) {
            queue.splice(i, 1);
            finish(job, fatal);
            continue;
          }
          i++;
          continue;
        }
        queue.splice(i, 1);
        if (owner) {
          affinity.delete(owner);
          affinity.set(owner, slot);
          while (affinity.size > 32)
            affinity.delete(affinity.keys().next().value!);
        }
        void run(slot, job);
      }
    } finally {
      pumping = false;
    }
  }
  function request<T>(
    doc: DocumentRecord,
    method: Job["method"],
    args: unknown[],
    options: RequestOptions = {},
    target?: Slot,
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(cancelled());
    if (doc.closing && method !== "closeDocument")
      return Promise.reject(cancelled());
    if (fatal && method !== "closeDocument") return Promise.reject(fatal);
    const key =
      method === "drawPage"
        ? keyFor(doc.id, args[0] as number, args[1] as number)
        : undefined;
    const hit = key ? cache.get(key) : undefined;
    if (hit) return Promise.resolve(hit as T);
    const shared = key ? renders.get(key) : undefined;
    const job: Job = shared ?? {
      doc,
      method,
      args,
      target,
      key,
      cacheEpoch,
      started: false,
      retries: 0,
      consumers: new Set(),
    };
    return new Promise<T>((resolve, reject) => {
      const consumer: Consumer = {
        priority: options.priority ?? "background",
        owner: options.ownerId,
        finish(error, result) {
          if (!job.consumers.delete(consumer)) return;
          options.signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(result as T);
        },
      };
      function abort() {
        consumer.finish(cancelled());
        if (!job.consumers.size && !job.started) {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          finish(job);
        }
      }
      job.consumers.add(consumer);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (!shared) {
        if (key) renders.set(key, job);
        queue.push(job);
      }
      pump();
    });
  }
  function read<T>(
    id: number,
    method: Method,
    args: unknown[],
    options?: RequestOptions,
  ): Promise<T> {
    const doc = docs.get(id);
    return doc
      ? request(doc, method, args, options)
      : Promise.reject(new Error("PDF document is closed"));
  }
  const pool: MupdfPool = {
    clearPageCache() {
      cacheEpoch++;
      cache.clear();
    },
    async openDocument(buffer, magic = "application/pdf", options) {
      const owned =
        typeof structuredClone === "function"
          ? structuredClone(buffer, { transfer: [buffer] })
          : buffer.slice(0);
      const doc: DocumentRecord = {
        id: nextId++,
        bytes: owned,
        magic,
        closing: false,
      };
      docs.set(doc.id, doc);
      try {
        return await request<number>(doc, "openDocument", [], {
          priority: options?.priority,
          ownerId: options?.ownerId,
        });
      } catch (error) {
        await pool.closeDocument(doc.id);
        throw error;
      }
    },
    closeDocument(id) {
      const doc = docs.get(id);
      if (!doc) return Promise.resolve();
      if (doc.close) return doc.close;
      doc.closing = true;
      cache.removeDocument(id);
      for (const job of [...queue])
        if (job.doc === doc) {
          queue.splice(queue.indexOf(job), 1);
          finish(job, cancelled());
        }
      doc.close = Promise.all(
        slots.map((slot) => request<void>(doc, "closeDocument", [], {}, slot)),
      ).then(() => {
        docs.delete(id);
        doc.bytes = new ArrayBuffer(0);
        stopIfEmpty();
      });
      return doc.close;
    },
    countPages: (id, options) => read(id, "countPages", [], options),
    getPageSize: (id, page, options) =>
      read(id, "getPageSize", [page], options),
    getAllPageSizes: (id, options) => read(id, "getAllPageSizes", [], options),
    drawPage: (id, page, dpi, options) =>
      read(id, "drawPage", [page, dpi], options),
    getPageText: (id, page, options) =>
      read(id, "getPageText", [page], options),
    getPageLinks: (id, page, options) =>
      read(id, "getPageLinks", [page], options),
    renderThumbnail: (id, page, width, options) =>
      read(id, "renderThumbnail", [page, width], options),
    reviewRegions: (id, boxes, options) =>
      read(id, "reviewRegions", [boxes], options),
    reviewCrop: (id, region, options) =>
      read(id, "reviewCrop", [region], options),
    peekPage: (id, page, dpi) =>
      docs.get(id)?.closing ? undefined : cache.get(keyFor(id, page, dpi)),
    promotePage(id, page, ownerId, priority) {
      for (const job of new Set([...queue, ...renders.values()]))
        if (
          job.doc.id === id &&
          job.args[0] === page &&
          ["drawPage", "getPageText", "getPageLinks"].includes(job.method)
        )
          for (const consumer of job.consumers)
            if (consumer.owner === ownerId) consumer.priority = priority;
      pump();
    },
    destroy() {
      fatal = new Error("PDF pool was closed");
      for (const doc of docs.values()) doc.closing = true;
      for (const job of queue.splice(0)) finish(job, fatal);
      for (const slot of slots) slot.client.destroy();
      docs.clear();
      cache.clear();
      affinity.clear();
    },
  };
  return pool;
}
