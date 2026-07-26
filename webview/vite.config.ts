import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  css: {
    // Opt into Dart Sass's modern compiler API (the legacy one warns on
    // every build and goes away in Sass 2.0).
    preprocessorOptions: { scss: { api: "modern-compiler" } }
  },
  // Dev server for the hot-reload loop: point `luno.devServerUrl` at this and
  // the panel loads sources from here instead of webview/dist. The port is
  // strict so the URL in settings can't silently go stale, and CORS is open
  // because the webview's origin is `vscode-webview://…`, not localhost.
  server: {
    port: 5173,
    strictPort: true,
    cors: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        entryFileNames: "main.js",
        assetFileNames: (info) => (info.name?.endsWith(".css") ? "main.css" : "[name][extname]"),
        format: "iife"
      }
    },
    cssCodeSplit: false,
    minify: true,
    target: "es2022"
  }
});
