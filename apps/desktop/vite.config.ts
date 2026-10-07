import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;
const watch = process.env.CODEX_PRISM_WATCH !== "0";
const mupdfWasmFile = path.resolve(
  __dirname,
  "..",
  "..",
  "node_modules",
  "mupdf",
  "dist",
  "mupdf-wasm.wasm",
);

export default defineConfig({
  plugins: [react(), topLevelAwait()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    __MUPDF_WASM_FS_PATH__: JSON.stringify(mupdfWasmFile.replace(/\\/g, "/")),
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["mupdf"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: !watch
      ? false
      : host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
    watch: watch
      ? {
          ignored: ["**/src-tauri/**"],
        }
      : null,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
