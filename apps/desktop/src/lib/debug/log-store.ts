import { create } from "zustand";
import { invoke } from "@/lib/backend";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
}

/** Custom event name constant to avoid stringly-typed bugs. */
export const APP_VISIBILITY_RESTORED = "app-visibility-restored";

export interface SystemInfo {
  os: string;
  os_version: string;
  arch: string;
  app_version: string;
}

const MAX_ENTRIES = 2000;
const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Cache debug flag in memory — updated via storage event
let _debugEnabled = !!localStorage.getItem("debug");
window.addEventListener("storage", (e) => {
  if (e.key === "debug") _debugEnabled = !!e.newValue;
});

// Mutable ring buffer — avoids spreading 2000-entry arrays on every log call.
// Only exposed to React via a version counter that triggers selective re-reads.
const _buffer: LogEntry[] = [];
let _version = 0;

/** Push an entry into the local buffer. */
function _pushEntry(entry: LogEntry) {
  _buffer.push(entry);
  if (_buffer.length > MAX_ENTRIES) {
    _buffer.splice(0, _buffer.length - MAX_ENTRIES);
  }
}

interface LogStore {
  /** Incremented on each log/clear — subscribers use this to know when to re-read. */
  version: number;
  log: (
    level: LogLevel,
    source: string,
    message: string,
    data?: unknown,
  ) => void;
  getEntries: () => readonly LogEntry[];
  getFilteredLogs: (opts?: {
    level?: LogLevel;
    source?: string;
    search?: string;
  }) => LogEntry[];
  exportLogs: () => string;
  clear: () => void;
}

export const useLogStore = create<LogStore>((set) => ({
  version: 0,

  log: (level, source, message, data) => {
    if (level === "debug" && !_debugEnabled) return;

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message,
      data,
    };

    _pushEntry(entry);
    set({ version: ++_version });

    // Forward warn/error to Rust stderr via existing js_log command
    if (level === "warn" || level === "error") {
      const prefix = level === "error" ? "ERROR" : "WARN";
      const msg = `[${prefix}][${source}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`;
      invoke("js_log", { msg }).catch(() => {});
    }
  },

  getEntries: () => _buffer,

  getFilteredLogs: (opts) => {
    if (!opts) return _buffer;

    const { level, source, search } = opts;
    const minLevel = level ? LOG_LEVEL_ORDER[level] : 0;
    const searchLower = search?.toLowerCase();

    return _buffer.filter((e) => {
      if (LOG_LEVEL_ORDER[e.level] < minLevel) return false;
      if (source && e.source !== source) return false;
      if (searchLower) {
        const haystack = `${e.source} ${e.message}`.toLowerCase();
        if (!haystack.includes(searchLower)) return false;
      }
      return true;
    });
  },

  exportLogs: () => {
    return JSON.stringify(_buffer, null, 2);
  },

  clear: () => {
    _buffer.length = 0;
    set({ version: ++_version });
  },
}));

/** Get the GPU renderer string. Result is cached after first call. */
let _gpuRendererCache: string | null = null;
export function getGpuRenderer(): string {
  if (_gpuRendererCache !== null) return _gpuRendererCache;
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (gl && gl instanceof WebGLRenderingContext) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) {
        _gpuRendererCache = gl.getParameter(
          ext.UNMASKED_RENDERER_WEBGL,
        ) as string;
        return _gpuRendererCache;
      }
    }
  } catch {
    // ignore
  }
  _gpuRendererCache = "Unknown";
  return _gpuRendererCache;
}

/** Get recent visibility-related log entries. */
export function getVisibilityLogs(limit = 10): LogEntry[] {
  return _buffer
    .filter((e) => e.source === "app" && e.message.includes("Visibility"))
    .slice(-limit);
}
