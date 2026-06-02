import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    // Externalize node_modules deps, but BUNDLE our workspace @duel/* packages
    // so their raw .ts source is compiled into the main process (Node can't
    // load .ts at runtime).
    plugins: [externalizeDepsPlugin({ exclude: ["@duel/shared", "@duel/local-backend"] })],
    build: { outDir: "out/main" },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@duel/shared"] })],
    build: { outDir: "out/preload" },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    // Allow importing assets from the repo root (e.g. assets/.../sleeves),
    // which live outside the renderer root.
    server: {
      fs: { allow: [resolve(__dirname, "..")] },
    },
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
