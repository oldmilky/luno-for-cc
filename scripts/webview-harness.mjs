#!/usr/bin/env bun
// Serve the built webview outside VS Code so it can be driven in a real
// browser — screenshots, computed styles, frame-by-frame measurement.
//
// The panel is normally unreachable to any tool: it lives inside an
// `vscode-webview://` frame that Playwright cannot attach to. The bundle
// itself has only two dependencies on that host — `acquireVsCodeApi()` and the
// `window.LUNO_MODE` global — so stubbing those is enough to boot the whole UI
// on localhost.
//
// The stub is a *fake host*, not a silent shim: it answers the same boot
// handshake the extension host does (`refreshAuth` → `auth`). Seeding on a
// timer instead would race the mount effect that registers the listener.
//
// Run under **bun**, not node: the reply table is TypeScript, typed against
// the protocol in `webview/src/lib/rpc.ts`, so that a renamed field fails
// `bun run lint` instead of failing silently in the page.
//
//   bun run harness                 build, serve, print the URL
//   bun run harness --no-build      reuse webview/dist as-is
//   bun run harness --mode artifact mount the plan-artifact shell
//   bun run harness --port 4599
//
// In the page, `window.__luno` is the seam:
//   __luno.sent          every message the webview posted to the host
//   __luno.send(msg)     push a host → webview message
//   __luno.clear()       reset the recording
//   __luno.replies       the fake host's reply table, editable at runtime
//   __luno.resetState()  drop the persisted webview state, then reload

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { harnessReplies } from "../webview/src/lib/harness-host.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "webview", "dist");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const port = Number(flag("port", 4599));
const mode = flag("mode", "chat");
const skipBuild = argv.includes("--no-build");

if (!skipBuild) {
  process.stderr.write("building webview…\n");
  execFileSync("bun", ["run", "--cwd", "webview", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
}

if (!fs.existsSync(path.join(DIST, "main.js"))) {
  process.stderr.write(
    `no bundle at ${DIST}. Drop --no-build, or run \`bun run build\` first.\n`
  );
  process.exit(1);
}

const shim = (revisionId) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/main.css">
<title>LUNO harness — ${mode}</title>
<script>
  window.LUNO_MODE = ${JSON.stringify(mode)};
  ${revisionId ? `window.LUNO_REVISION_ID = ${JSON.stringify(revisionId)};` : ""}

  const sent = [];
  const replies = ${JSON.stringify(harnessReplies(Date.now()), null, 2)};

  // A real webview's state outlives a reload and dies with the view, which is
  // sessionStorage exactly. Keeping it on \`window\` made every reload look
  // like a fresh chat, so the timeline, input and theme the app persists could
  // not be verified in here at all.
  const STATE_KEY = "luno.harness.state";
  const readState = () => {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  window.__luno = {
    sent,
    replies,
    send: (msg) => window.postMessage(msg, "*"),
    clear: () => { sent.length = 0; },
    // Messages of one type that the webview has posted — the usual assertion.
    sentOf: (type) => sent.filter((m) => m && m.type === type),
    get state() { return readState(); },
    resetState: () => sessionStorage.removeItem(STATE_KEY)
  };

  // The bundle calls this at module scope, so it has to exist before main.js.
  window.acquireVsCodeApi = () => ({
    postMessage: (msg) => {
      sent.push(msg);
      const reply = replies[msg && msg.type];
      // Answer on a macrotask: the real host is out-of-process, and replying
      // synchronously inside postMessage would re-enter React's render.
      if (reply) setTimeout(() => window.postMessage(reply, "*"), 0);
    },
    getState: readState,
    setState: (s) => sessionStorage.setItem(STATE_KEY, JSON.stringify(s))
  });
</script>
</head>
<body>
<div id="root"></div>
<script src="/main.js"></script>
</body>
</html>`;

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(shim(url.searchParams.get("revision")));
    return;
  }

  // The browser asks unprompted and the 404 lands in the console, where it
  // reads like a page error in every screenshot of the log.
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  // Serve the bundle only. `path.normalize` then a prefix check, so a
  // `..` segment cannot walk out of webview/dist. `isFile` because a stream
  // opened on a directory throws EISDIR asynchronously, which is an unhandled
  // error event — the server would die mid-session and take the page with it.
  const target = path.normalize(path.join(DIST, url.pathname));
  if (
    !target.startsWith(DIST) ||
    !fs.existsSync(target) ||
    !fs.statSync(target).isFile()
  ) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(target)] ?? "application/octet-stream"
  });
  fs.createReadStream(target).pipe(res);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `\nport ${port} is busy — a harness is probably already running there.\n` +
        `Reuse it at http://127.0.0.1:${port}/, or pass --port.\n\n`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(
    `\nharness  http://127.0.0.1:${port}/   mode=${mode}\n` +
      `bundle   ${DIST}\n` +
      `stop     Ctrl+C\n\n`
  );
});
