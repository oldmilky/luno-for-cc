// ─────────────────────────────────────────────────────────────
// One flat config for both projects. The extension host and the
// webview are separate builds but a single codebase, and two
// configs would drift.
//
// Deliberately NOT type-aware (`projectService`): type-checked
// rules re-run the compiler and take it from ~2s to ~40s on this
// tree. `bun run lint` already runs `tsc --noEmit` over both
// projects, so everything type-aware is covered there — this pass
// is for what the compiler does not look at.
// ─────────────────────────────────────────────────────────────

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "webview/dist/**",
      "node_modules/**",
      "webview/node_modules/**",
      "ghost.one/**",
      "**/*.vsix"
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // The codebase leans on leading-underscore for deliberately unused
      // bindings — mocked params, destructured rest, catch clauses.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true
        }
      ],
      // `any` is a smell, not a build break: it is allowed with a stated
      // reason, which is exactly what a warning is for.
      "@typescript-eslint/no-explicit-any": "warn",
      // Two ways to spell the same fact. `interface` is the house style.
      "@typescript-eslint/consistent-type-definitions": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error"
    }
  },

  // ── Extension host ──────────────────────────────────────────
  {
    files: ["src/**/*.ts", "esbuild.config.mjs", "vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.node }
    }
  },

  // ── Webview ─────────────────────────────────────────────────
  {
    files: ["webview/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser }
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // ── A real backlog, deliberately not a build break ──────
      // react-hooks v7 ships the React Compiler's rules, which are far
      // stricter than the hook-order checks this code was written against.
      // They are not noise — each one is a genuine cascading-render or
      // stale-read risk — but there were 32 on adoption day across a dozen
      // components, and clearing them is a refactor, not a config change.
      //
      // Kept at `warn` so every run still reports them and the count is
      // visible. Promote each back to `error` as its group reaches zero;
      // the last one to flip should take this comment with it.
      //
      //   refs                        21   ref read during render
      //   set-state-in-effect          7   cascading renders
      //   immutability                 3
      //   preserve-manual-memoization  1
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",

      // Fast Refresh only reloads a module whose exports are all components.
      // A constant exported beside one silently turns edits into full reloads,
      // which is the whole point of the dev loop.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true }
      ]
    }
  },

  // ── Tests ───────────────────────────────────────────────────
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      // Fixtures and mocks legitimately fake shapes the real types forbid.
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
);
