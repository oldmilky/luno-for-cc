// ─────────────────────────────────────────────────────────────
// The account's quota, asked for directly.
//
// Claude Code used to cache the server's answer in `~/.claude.json` under
// `cachedUsageUtilization`, and `usage-utilization.ts` reads it. Since 2.1.x it
// no longer writes that key, so on a current install the meter has no
// percentage at all and falls back to guessing against a hard-coded plan cap —
// which on a live Max 20× account read "over" where the truth was 22%.
//
// The CLI's own source is `GET /api/oauth/usage`, authorised with the OAuth
// token it stores for the user. It is undocumented and can disappear in any
// release, so every failure here is silent and the caller drops to showing
// absolute token counts with no percentage rather than an error.
//
// Three rules this file exists to keep:
//   · the token goes to api.anthropic.com and nowhere else — never to a log,
//     never across the webview boundary, never written back to disk
//   · we read the credential, never write it. Refreshing an expired token is
//     the CLI's business; a 401 here just means no percentages this hour
//   · the poll behind this runs every 60s, so an uncached fetch would be 60
//     requests an hour against an internal endpoint. Hence the TTL below.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5_000;

/** How long an answer — or a failure — stands before we ask again. */
const TTL_MS = 5 * 60_000;

/**
 * How old an answer may be before it stops being shown at all. A percentage
 * from half an hour ago is worse than no percentage: the 5-hour window it
 * describes may have rolled over since.
 */
const MAX_STALE_MS = 30 * 60_000;

export interface OAuthUsageSnapshot {
  /** The response body, shaped exactly like `cachedUsageUtilization.utilization`. */
  payload: unknown;
  fetchedAt: number;
}

export interface OAuthUsageDeps {
  readToken?: () => Promise<string | null>;
  requestUsage?: (token: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * Why there are no account figures, when there are none.
 *
 * The panel used to say only "not available right now", which reads as a bug
 * whichever of these it is. They call for different actions: one is a login,
 * one is a retry.
 */
export type OAuthUsageOutcome = "ok" | "no-token" | "unreachable" | "never";

export interface OAuthUsageReader {
  /**
   * The account's figures, or null when there are none to show.
   *
   * `force` skips the TTL — it is the Refresh button, and a user who clicks it
   * is entitled to a round trip. It does not skip the failure path: a click
   * against a dead endpoint still returns whatever is left within MAX_STALE.
   */
  read(force?: boolean): Promise<OAuthUsageSnapshot | null>;
  /** How the last attempt went, for the panel to explain itself with. */
  outcome(): OAuthUsageOutcome;
}

function credentialsPath(): string {
  const dir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(dir, ".credentials.json");
}

function tokenFrom(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

async function tokenFromFile(): Promise<string | null> {
  try {
    return tokenFrom(await fs.readFile(credentialsPath(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * macOS keeps the credential in the Keychain rather than in a file.
 *
 * A fixed argv with no shell and no interpolated input — the service name is a
 * constant. `security` prints either the JSON or, when the entry was stored as
 * data, its hex encoding.
 */
async function tokenFromKeychain(): Promise<string | null> {
  const raw = await new Promise<string>((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: REQUEST_TIMEOUT_MS },
      (err, stdout) => resolve(err ? "" : stdout.trim())
    );
  });
  if (!raw) return null;

  const direct = tokenFrom(raw);
  if (direct) return direct;
  if (!/^[0-9a-f]+$/i.test(raw)) return null;
  try {
    return tokenFrom(Buffer.from(raw, "hex").toString("utf8"));
  } catch {
    return null;
  }
}

/** The user's OAuth token, or null when they are on an API key or logged out. */
export async function resolveOAuthToken(): Promise<string | null> {
  if (process.platform === "darwin") {
    const fromKeychain = await tokenFromKeychain();
    if (fromKeychain) return fromKeychain;
  }
  return await tokenFromFile();
}

async function requestUsage(token: string): Promise<unknown> {
  const res = await fetch(ENDPOINT, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  // Status only. The body of a failed call can carry account detail, and this
  // string is the one thing here that could end up somewhere it is read.
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);
  return await res.json();
}

/**
 * A reader with its own cache.
 *
 * Not a module-level singleton so tests can hold several, and so the clock and
 * both I/O ends can be replaced without touching the network or the user's
 * keychain.
 */
export function createOAuthUsageReader(
  deps: OAuthUsageDeps = {}
): OAuthUsageReader {
  const now = deps.now ?? Date.now;
  const getToken = deps.readToken ?? resolveOAuthToken;
  const request = deps.requestUsage ?? requestUsage;

  let last: OAuthUsageSnapshot | null = null;
  let lastOutcome: OAuthUsageOutcome = "never";
  /** When we last *tried*, which is what the TTL bounds — a failure has to
   *  back off exactly as a success does, or a logged-out user generates a
   *  request every minute forever. Negative infinity rather than 0: "never"
   *  has to sit before any clock, and a test clock starts near zero. */
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<OAuthUsageSnapshot | null> | null = null;

  const fresh = (): OAuthUsageSnapshot | null =>
    last && now() - last.fetchedAt < MAX_STALE_MS ? last : null;

  const attempt = async (): Promise<OAuthUsageSnapshot | null> => {
    attemptedAt = now();
    try {
      const token = await getToken();
      if (!token) {
        lastOutcome = "no-token";
        return fresh();
      }
      last = { payload: await request(token), fetchedAt: now() };
      lastOutcome = "ok";
      return last;
    } catch {
      // Keep serving the previous answer while it is still worth serving.
      lastOutcome = "unreachable";
      return fresh();
    } finally {
      inFlight = null;
    }
  };

  return {
    read(force = false) {
      if (!force && now() - attemptedAt < TTL_MS) {
        return Promise.resolve(fresh());
      }
      // The 60s poll and a click can land together; one request answers both.
      inFlight ??= attempt();
      return inFlight;
    },
    outcome: () => lastOutcome
  };
}
