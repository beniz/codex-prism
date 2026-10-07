// All desktop-only capabilities stay behind this module, outside product state.
export { open as openExternal } from "@tauri-apps/plugin-shell";
export { open, save, ask, confirm, message } from "@tauri-apps/plugin-dialog";
export { getCurrentWindow } from "@tauri-apps/api/window";
export { getCurrentWebview } from "@tauri-apps/api/webview";
