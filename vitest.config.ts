import { defineConfig } from "vitest/config";
import * as fs from "node:fs";

// Vitest runs through Vite, which doesn't natively load `.md` files as
// strings the way esbuild's `text` loader does for the production build.
// Add a tiny plugin so `import x from "../prompts/foo.md"` works in tests
// the same way it works at extension-bundle time.
function mdAsText() {
  return {
    name: "luno:md-as-text",
    enforce: "pre" as const,
    transform(_code: string, id: string) {
      if (!id.endsWith(".md")) return null;
      const content = fs.readFileSync(id, "utf8");
      return {
        code: `export default ${JSON.stringify(content)};`,
        map: null
      };
    }
  };
}

export default defineConfig({
  plugins: [mdAsText()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
