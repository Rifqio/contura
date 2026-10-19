/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Vitest empties CSS by default; the styles tests read tokens.css, fonts.css, app.css, flow.css,
    // flow-canvas.css, flow-tab.css and lineage.css as text.
    css: { include: [/tokens\.css/, /fonts\.css/, /app\.css/, /styles[\\/]flow\.css/, /flow-canvas\.css/, /flow-tab\.css/, /lineage\.css/] },
    // Timing tests run alone through `npm run test:perf` (vitest.perf.config.ts).
    exclude: [...configDefaults.exclude, ".claude/**", "**/*.perf.test.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
