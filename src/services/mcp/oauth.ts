// ─────────────────────────────────────────────────────────────
// OAuth 2.1 client for remote MCP servers.
//
// Implements the same authorization dance claude.ai performs when
// a user clicks "Connect" on a remote MCP server:
//
//   1. Hit the server URL once. If the response is 401 with a
//      WWW-Authenticate header that points at a Protected
//      Resource Metadata document (RFC 9728), follow it.
//   2. Fetch the authorization-server metadata from
//      `.well-known/oauth-authorization-server` or
//      `.well-known/openid-configuration`.
//   3. If the server advertises a `registration_endpoint`,
//      perform Dynamic Client Registration (RFC 7591) to mint a
//      fresh client_id (and possibly client_secret) for *this*
//      install of Luno.
//   4. Generate a PKCE pair, open the user's browser at the
//      `authorization_endpoint`, and wait for the redirect on a
//      short-lived loopback HTTP server bound to 127.0.0.1.
//   5. Exchange the returned code for tokens at the
//      `token_endpoint` and hand them back to the caller.
//
// Token storage and the actual MCP connection live in
// sibling modules (storage.ts, client.ts). This file only
// produces an `OAuthResult` shape and is otherwise stateless.
// ─────────────────────────────────────────────────────────────

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as vscode from "vscode";

export interface OAuthDiscovery {
  /** Issuer URL (RFC 8414 / OIDC). */
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Optional — only present if the AS advertises RFC 7591 DCR. */
  registrationEndpoint?: string;
  /** Scopes the AS supports — passed verbatim back in the auth request. */
  scopesSupported?: string[];
}

export interface OAuthResult {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (best-effort estimate). */
  expiresAt?: number;
  /** The client_id this Luno install registered with the AS. */
  clientId: string;
  clientSecret?: string;
  /** The discovered token endpoint, cached so refresh can re-hit it. */
  tokenEndpoint: string;
  issuer?: string;
}

export interface BeginAuthOptions {
  /** The MCP server URL the user is trying to connect to. */
  serverUrl: string;
  /** Vendor-supplied client_id if the user pasted one (skips DCR). */
  preRegisteredClientId?: string;
  /** Vendor-supplied client_secret if the user pasted one. */
  preRegisteredClientSecret?: string;
  /** Scope hint — falls back to "openid offline_access" then to []. */
  scope?: string;
  /** Display name used in DCR + browser tabs. */
  appName?: string;
  /** Per-attempt timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Aborts the flow — closes the loopback server and throws OAuthCancelled. */
  signal?: AbortSignal;
}

/** Sentinel thrown when the flow is cancelled via `signal.abort()`. */
export class OAuthCancelled extends Error {
  constructor(message = "Connection cancelled.") {
    super(message);
    this.name = "OAuthCancelled";
  }
}

// ── Public entry point ──────────────────────────────────────

/**
 * Run the full discover→register→authorize→exchange flow.
 *
 * Throws if any step fails; callers should surface the error to the user
 * verbatim — the messages are intentionally specific (which step, which
 * URL) so users can self-diagnose misconfigured servers.
 */
export async function performOAuth(
  opts: BeginAuthOptions
): Promise<OAuthResult> {
  const appName = opts.appName ?? "Luno (VS Code)";
  if (opts.signal?.aborted) throw new OAuthCancelled();
  const discovery = await discoverAuthServer(opts.serverUrl);
  if (opts.signal?.aborted) throw new OAuthCancelled();

  // Step A — make sure we have a client_id. Either reuse the pasted one
  //          or run Dynamic Client Registration against the AS.
  let clientId = opts.preRegisteredClientId;
  let clientSecret = opts.preRegisteredClientSecret;
  if (!clientId) {
    if (!discovery.registrationEndpoint) {
      throw new Error(
        `Server doesn't advertise Dynamic Client Registration. Pre-register an OAuth client at the vendor and paste the client_id (and client_secret if any) into "Add custom connector → Advanced".`
      );
    }
    const registered = await registerClient(
      discovery.registrationEndpoint,
      appName,
      /* tempRedirectUri (replaced below) */ "http://127.0.0.1:1/callback"
    );
    clientId = registered.clientId;
    clientSecret = registered.clientSecret;
  }

  // Step B — bind a loopback server. The OS assigns a port; we use that
  //          port in the redirect URI we hand to the AS.
  const { port, waitForCode, close } = await startLoopback();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    // Step C — PKCE pair. Always required for OAuth 2.1.
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = randomString(32);

    // Many ASes require the same redirect_uri at registration and
    // authorization time. If we just registered, re-register with the
    // real port now that we know it. (Some ASes silently accept any
    // 127.0.0.1 URI; some don't. Re-registering is the safe path.)
    if (!opts.preRegisteredClientId && discovery.registrationEndpoint) {
      const re = await registerClient(
        discovery.registrationEndpoint,
        appName,
        redirectUri
      );
      clientId = re.clientId;
      clientSecret = re.clientSecret;
    }

    // Step D — build the authorize URL.
    const authUrl = new URL(discovery.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId!);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    const scope = pickScope(opts.scope, discovery.scopesSupported);
    if (scope) authUrl.searchParams.set("scope", scope);

    // Open the URL in the user's default browser.
    await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

    // Step E — wait for the AS to redirect back to our loopback.
    const code = await waitForCode(
      state,
      opts.timeoutMs ?? 5 * 60_000,
      opts.signal
    );

    // Step F — exchange code → tokens.
    const tokens = await exchangeCode({
      tokenEndpoint: discovery.tokenEndpoint,
      code,
      codeVerifier,
      clientId: clientId!,
      clientSecret,
      redirectUri
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : undefined,
      clientId: clientId!,
      clientSecret,
      tokenEndpoint: discovery.tokenEndpoint,
      issuer: discovery.issuer
    };
  } finally {
    close();
  }
}

/**
 * Refresh an access token using a stored refresh token. Throws on
 * failure (caller should propagate the error so the UI can prompt the
 * user to re-authorize).
 */
export async function refreshAccessToken(opts: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token refresh failed (HTTP ${res.status}): ${text || res.statusText}`
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined
  };
}

// ── Discovery ───────────────────────────────────────────────

async function discoverAuthServer(serverUrl: string): Promise<OAuthDiscovery> {
  // First hit the server unauthenticated. RFC 9728 says it should answer
  // 401 with a WWW-Authenticate header that points at the protected-
  // resource metadata document. We try that, then fall back to deriving
  // a sensible default.
  let resourceMeta: { authorization_servers?: string[] } | undefined;
  try {
    const res = await fetch(serverUrl, { method: "GET" });
    const auth = res.headers.get("www-authenticate");
    const m = auth?.match(/resource_metadata="?([^",]+)"?/i);
    if (m) {
      const r = await fetch(m[1]);
      if (r.ok)
        resourceMeta = (await r.json()) as { authorization_servers?: string[] };
    }
  } catch {
    // ignore — fall through to origin-relative discovery
  }

  const issuerCandidates = resourceMeta?.authorization_servers ?? [
    originOf(serverUrl)
  ];

  for (const issuer of issuerCandidates) {
    const meta = await fetchAuthServerMetadata(issuer).catch(() => null);
    if (meta) return meta;
  }

  throw new Error(
    `Could not discover OAuth metadata for ${serverUrl}. The server didn't expose ` +
      `/.well-known/oauth-authorization-server or /.well-known/openid-configuration.`
  );
}

async function fetchAuthServerMetadata(
  issuer: string
): Promise<OAuthDiscovery> {
  const base = issuer.replace(/\/+$/, "");
  const urls = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u);
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;
      if (typeof json.authorization_endpoint !== "string") continue;
      if (typeof json.token_endpoint !== "string") continue;
      return {
        issuer: typeof json.issuer === "string" ? json.issuer : issuer,
        authorizationEndpoint: json.authorization_endpoint,
        tokenEndpoint: json.token_endpoint,
        registrationEndpoint:
          typeof json.registration_endpoint === "string"
            ? json.registration_endpoint
            : undefined,
        scopesSupported: Array.isArray(json.scopes_supported)
          ? (json.scopes_supported as string[])
          : undefined
      };
    } catch {
      // try next candidate
    }
  }
  throw new Error("no auth-server metadata at " + issuer);
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

// ── Dynamic Client Registration ─────────────────────────────

async function registerClient(
  registrationEndpoint: string,
  appName: string,
  redirectUri: string
): Promise<{ clientId: string; clientSecret?: string }> {
  const body = {
    client_name: appName,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native"
  };
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 401/403 here means the vendor gates client registration to pre-approved
    // partners (Figma does this) — no third-party tool can self-register. Give
    // an actionable message instead of a bare "Forbidden".
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `This server doesn't allow automatic OAuth registration (HTTP ${res.status}) — it ` +
          `only accepts a pre-approved client. Authenticate it through Claude Code (run ` +
          `\`claude\`, then \`/mcp\`), or paste a vendor-issued client_id/secret under ` +
          `"Add custom → Advanced".`
      );
    }
    throw new Error(
      `Dynamic Client Registration failed (HTTP ${res.status}): ${text || res.statusText}`
    );
  }
  const json = (await res.json()) as {
    client_id: string;
    client_secret?: string;
  };
  if (!json.client_id) {
    throw new Error("Registration response missing client_id");
  }
  return { clientId: json.client_id, clientSecret: json.client_secret };
}

// ── PKCE ────────────────────────────────────────────────────

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return { codeVerifier: verifier, codeChallenge: challenge };
}

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function randomString(bytes: number): string {
  return base64Url(crypto.randomBytes(bytes));
}

// ── Loopback HTTP server ────────────────────────────────────

async function startLoopback(): Promise<{
  port: number;
  waitForCode: (
    expectedState: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<string>;
  close: () => void;
}> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Port 0 → let the OS pick a free ephemeral port.
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr !== "object") {
    server.close();
    throw new Error("Failed to bind loopback server");
  }
  const port = addr.port;

  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const errorDesc = url.searchParams.get("error_description");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (error) {
      res.end(htmlMessage(`Authorization failed: ${error}`, errorDesc ?? ""));
      rejectCode?.(new Error(errorDesc ?? error));
      return;
    }
    if (!code) {
      res.end(
        htmlMessage("Missing authorization code", "Try connecting again.")
      );
      rejectCode?.(new Error("Missing authorization code"));
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    res.end(
      htmlMessage("Connected!", "You can close this tab and return to VS Code.")
    );
    resolveCode?.(`${code}::${state}`);
  });

  return {
    port,
    waitForCode(expectedState, timeoutMs, signal) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Authorization timed out"));
        }, timeoutMs);
        // Hook the AbortSignal so cancellation from the UI tears down the
        // loopback wait synchronously. Without this the user-facing
        // "Cancel" button would only update local state — the host would
        // still sit on a live listener for the full 5-minute timeout.
        const onAbort = () => {
          cleanup();
          reject(new OAuthCancelled());
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        resolveCode = (combined) => {
          cleanup();
          const [code, state] = combined.split("::");
          if (state !== expectedState) {
            reject(new Error("OAuth state mismatch — refusing the response."));
            return;
          }
          resolve(code);
        };
        rejectCode = (err) => {
          cleanup();
          reject(err);
        };
      });
    },
    close() {
      server.close();
      // closeAllConnections() forcibly drops any half-open sockets so the
      // process can exit / next call can rebind the port. Node 18+.
      const maybeServer = server as unknown as {
        closeAllConnections?: () => void;
      };
      maybeServer.closeAllConnections?.();
    }
  };
}

function htmlMessage(title: string, sub: string): string {
  // Minimal inline HTML — the browser tab just needs a confirmation.
  return `<!doctype html><html><body style="font-family:system-ui;background:#0b0b0e;color:#f5f5f7;padding:48px;text-align:center"><h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(
    title
  )}</h1><p style="color:#aaa;font-size:14px;margin:0">${escapeHtml(sub)}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}

// ── Code exchange ───────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function exchangeCode(opts: {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token exchange failed (HTTP ${res.status}): ${text || res.statusText}`
    );
  }
  return (await res.json()) as TokenResponse;
}

// ── Scope helper ────────────────────────────────────────────

function pickScope(
  requested: string | undefined,
  supported: string[] | undefined
): string | undefined {
  if (requested) return requested;
  if (supported && supported.length) {
    // Prefer offline_access so we actually get a refresh_token back.
    const offline = supported.find((s) => s === "offline_access");
    if (offline) return offline;
    return supported.join(" ");
  }
  return undefined;
}
