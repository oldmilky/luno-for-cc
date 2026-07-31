import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The component half of the suite. Rooted in `webview/` so every import — the
// component's `react`, the test's `react-dom/client`, `framer-motion`, the
// Solar icons — resolves from one `node_modules`.
//
// SCSS modules come free: this runs through Vite, which compiles them and
// hands back the class map, so `s.someName` is a real string here rather than
// the `undefined` a bare esbuild run would produce. That matters more than it
// looks — a dangling `s.typo` renders unstyled and the build stays green, and
// this is the only place that can catch it.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "webview",
    include: ["test/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"]
  }
});
