import { invoke } from "@/lib/backend";
import {
  useLogStore,
  getGpuRenderer,
  getVisibilityLogs,
  type SystemInfo,
} from "./log-store";

/**
 * Generate a JSON bug report containing logs, system info, and render state.
 * Returns a formatted JSON string suitable for clipboard or file export.
 */
export async function generateBugReport(): Promise<string> {
  let systemInfo: SystemInfo | null = null;
  try {
    systemInfo = await invoke<SystemInfo>("get_system_info");
  } catch {
    // Tauri command may not be available in all contexts
  }

  const entries = useLogStore.getState().getEntries();

  const report = {
    generated_at: new Date().toISOString(),
    system: {
      ...systemInfo,
      user_agent: navigator.userAgent,
      device_pixel_ratio: window.devicePixelRatio,
      gpu_renderer: getGpuRenderer(),
      screen: {
        width: screen.width,
        height: screen.height,
        color_depth: screen.colorDepth,
      },
      visibility_state: document.visibilityState,
      window_focused: document.hasFocus(),
    },
    visibility_events: getVisibilityLogs().map((e) => ({
      timestamp: new Date(e.timestamp).toISOString(),
      message: e.message,
    })),
    logs: entries.slice(-500).map((e) => ({
      time: new Date(e.timestamp).toISOString(),
      level: e.level,
      source: e.source,
      message: e.message,
      ...(e.data !== undefined ? { data: e.data } : {}),
    })),
    total_log_entries: entries.length,
  };

  return JSON.stringify(report, null, 2);
}
