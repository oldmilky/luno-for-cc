// Two test projects, one command.
//
// The host half runs in `node` and never touches a DOM. The webview half has
// to render React, and React lives only in `webview/node_modules` — so that
// project is rooted there rather than here, which is what keeps a component
// and the test rendering it on one copy of React. Two copies is the classic
// invalid-hook-call, and it is invisible until the first `useState`.
//
// `bun run test` still runs everything and still prints one summary; the gate
// in CLAUDE.md stays a single number.
export default ["./vitest.config.ts", "./webview/vitest.config.ts"];
