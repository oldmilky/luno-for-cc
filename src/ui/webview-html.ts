// ─────────────────────────────────────────────────────────────
// Webview HTML — one builder for both surfaces (the chat sidebar
// and the plan-artifact editor tab), with a dev-server mode.
//
// Production loads the built bundle out of `webview/dist`.
//
// Dev mode (`luno.devServerUrl`, e.g. http://localhost:5173) loads
// the sources straight from Vite instead, so edits to the webview
// hot-reload in place — no rebuild, no repackage, no Reload Window.
// Only the webview reloads that way; changes to extension-host code
// (src/) still need the window reloaded, because that code runs in
// a different process.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  title: string;
  /** Globals set on `window` before the bundle boots (LUNO_MODE, …). */
  globals?: Record<string, string>;
}

/** The configured Vite dev server, or "" when running the built bundle. */
export function devServerUrl(): string {
  return vscode.workspace
    .getConfiguration("luno")
    .get<string>("devServerUrl", "")
    .trim()
    .replace(/\/+$/, "");
}

export function buildWebviewHtml(opts: WebviewHtmlOptions): string {
  const nonce = makeNonce();
  const dev = devServerUrl();
  const globals = renderGlobals(opts.globals, nonce);
  return dev
    ? devHtml(opts, nonce, globals, dev)
    : prodHtml(opts, nonce, globals);
}

function prodHtml(
  opts: WebviewHtmlOptions,
  nonce: string,
  globals: string
): string {
  const { webview, extensionUri, title } = opts;
  const distRoot = vscode.Uri.joinPath(extensionUri, "webview", "dist");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distRoot, "main.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distRoot, "main.css")
  );
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource} https://fonts.gstatic.com`,
    `connect-src https://fonts.googleapis.com https://fonts.gstatic.com`
  ].join("; ");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
<title>${title}</title>
${globals}
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function devHtml(
  opts: WebviewHtmlOptions,
  nonce: string,
  globals: string,
  dev: string
): string {
  const { webview, title } = opts;
  // Vite's HMR channel is a WebSocket on the same origin.
  const ws = dev.replace(/^http/, "ws");
  // Vite serves modules and injects styles at runtime, so both script-src and
  // style-src have to admit the dev origin. `'unsafe-inline'` is already
  // required by the style injection; it is scoped to this dev-only branch.
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline' ${dev} https://fonts.googleapis.com`,
    `script-src 'nonce-${nonce}' ${dev}`,
    `img-src ${webview.cspSource} ${dev} data:`,
    `font-src ${webview.cspSource} ${dev} https://fonts.gstatic.com`,
    `connect-src ${dev} ${ws} https://fonts.googleapis.com https://fonts.gstatic.com`
  ].join("; ");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${title} (dev)</title>
${globals}
<script type="module" nonce="${nonce}">
  // React Fast Refresh preamble. @vitejs/plugin-react normally injects this
  // into index.html; we hand-roll the page, so without it the plugin throws
  // "can't detect preamble" on the first component module.
  import RefreshRuntime from "${dev}/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
</script>
<script type="module" nonce="${nonce}" src="${dev}/@vite/client"></script>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${dev}/src/main.tsx"></script>
</body>
</html>`;
}

function renderGlobals(
  globals: Record<string, string> | undefined,
  nonce: string
): string {
  if (!globals || Object.keys(globals).length === 0) return "";
  const body = Object.entries(globals)
    .map(([k, v]) => `  window.${k} = ${jsString(v)};`)
    .join("\n");
  return `<script nonce="${nonce}">\n${body}\n</script>`;
}

/**
 * Encode a value as a JS string literal that is safe inside a <script> block:
 * JSON first, then escape the characters that could break out of the element
 * or be re-interpreted by the HTML parser.
 */
function jsString(value: string): string {
  // `<`, `>` and `&` could end the <script> element or be re-parsed as
  // markup; U+2028 and U+2029 survive JSON.stringify raw but count as line
  // terminators in JS. One pass over the class, each match rewritten as its
  // \uXXXX escape.
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

export function makeNonce(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let n = "";
  for (let i = 0; i < 32; i++) n += chars[Math.floor(Math.random() * chars.length)];
  return n;
}
