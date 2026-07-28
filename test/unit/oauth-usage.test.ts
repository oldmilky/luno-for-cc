import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createOAuthUsageReader,
  resolveOAuthToken
} from "../../src/services/oauth-usage.js";
import { parseUtilization } from "../../src/services/usage-utilization.js";

// Captured from a real 200 against the endpoint, trimmed to the fields we read
// plus enough of the rest to prove we ignore it. This is the payload the CLI
// used to cache verbatim, which is why one parser serves both paths.
const LIVE_PAYLOAD = {
  five_hour: { utilization: 22, resets_at: "2026-07-28T14:29:59.317017+00:00" },
  seven_day: { utilization: 4, resets_at: "2026-08-04T09:59:59.317039+00:00" },
  seven_day_opus: null,
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 22,
      severity: "normal",
      resets_at: "2026-07-28T14:29:59.317017+00:00",
      scope: null,
      is_active: true
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 4,
      severity: "normal",
      resets_at: "2026-08-04T09:59:59.317039+00:00",
      scope: null,
      is_active: false
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      severity: "normal",
      // Null on a scoped limit the account has not touched. It used to become
      // 0, which the panel then rendered as "resets shortly".
      resets_at: null,
      scope: { model: { id: null, display_name: "Fable" } },
      is_active: false
    }
  ],
  spend: { used: { amount_minor: 0, currency: "USD" }, percent: 0 }
};

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "luno-oauth-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeCredentials = (value: unknown): void => {
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify(value),
    "utf8"
  );
};

describe("finding the OAuth token", () => {
  it("reads it from the config directory the CLI was pointed at", async () => {
    writeCredentials({ claudeAiOauth: { accessToken: "sk-ant-oat-xyz" } });
    expect(await resolveOAuthToken()).toBe("sk-ant-oat-xyz");
  });

  it("answers null rather than throwing when there is no credential", async () => {
    expect(await resolveOAuthToken()).toBeNull();

    writeCredentials({ somethingElse: true });
    expect(await resolveOAuthToken()).toBeNull();

    fs.writeFileSync(path.join(dir, ".credentials.json"), "{not json", "utf8");
    expect(await resolveOAuthToken()).toBeNull();
  });
});

describe("asking the account for its quota", () => {
  const readerWith = (
    requestUsage: (token: string) => Promise<unknown>,
    clock: { value: number }
  ) =>
    createOAuthUsageReader({
      readToken: async () => "token",
      requestUsage,
      now: () => clock.value
    });

  it("returns what the endpoint said", async () => {
    const clock = { value: 1_000 };
    const reader = readerWith(async () => LIVE_PAYLOAD, clock);

    const got = await reader.read();
    expect(got?.payload).toBe(LIVE_PAYLOAD);
    expect(got?.fetchedAt).toBe(1_000);
  });

  it("asks once per TTL, however often it is read", async () => {
    const clock = { value: 0 };
    let calls = 0;
    const reader = readerWith(async () => {
      calls += 1;
      return LIVE_PAYLOAD;
    }, clock);

    await reader.read();
    clock.value += 60_000;
    await reader.read();
    clock.value += 60_000;
    await reader.read();
    expect(calls).toBe(1);

    // Past five minutes it is allowed to ask again.
    clock.value += 4 * 60_000;
    await reader.read();
    expect(calls).toBe(2);
  });

  it("goes to the network anyway when the user presses Refresh", async () => {
    const clock = { value: 0 };
    let calls = 0;
    const reader = readerWith(async () => {
      calls += 1;
      return LIVE_PAYLOAD;
    }, clock);

    await reader.read();
    await reader.read(true);
    expect(calls).toBe(2);
  });

  it("keeps serving the last answer when the endpoint breaks", async () => {
    const clock = { value: 0 };
    let fail = false;
    const reader = readerWith(async () => {
      if (fail) throw new Error("usage endpoint returned 500");
      return LIVE_PAYLOAD;
    }, clock);

    await reader.read();
    fail = true;

    clock.value += 6 * 60_000;
    expect((await reader.read())?.payload).toBe(LIVE_PAYLOAD);

    // Half an hour on, the window it describes may have rolled over. Better
    // nothing than a percentage of the wrong window.
    clock.value += 30 * 60_000;
    expect(await reader.read()).toBeNull();
  });

  it("does not call the endpoint at all without a token", async () => {
    let calls = 0;
    const reader = createOAuthUsageReader({
      readToken: async () => null,
      requestUsage: async () => {
        calls += 1;
        return LIVE_PAYLOAD;
      },
      now: () => 0
    });

    expect(await reader.read()).toBeNull();
    expect(calls).toBe(0);
  });

  it("backs off after a failure instead of retrying every poll", async () => {
    const clock = { value: 0 };
    let calls = 0;
    const reader = readerWith(async () => {
      calls += 1;
      throw new Error("usage endpoint returned 401");
    }, clock);

    await reader.read();
    clock.value += 60_000;
    await reader.read();
    expect(calls).toBe(1);
  });
});

describe("reading the live payload", () => {
  it("produces the same rows as the cached copy did", () => {
    const got = parseUtilization(LIVE_PAYLOAD, 1_700, "default_claude_max_20x");

    expect(got?.limits.map((l) => [l.kind, l.percent])).toEqual([
      ["session", 22],
      ["weekly_all", 4],
      ["weekly_scoped", 0]
    ]);
    expect(got?.plan).toBe("max20");
    expect(got?.fetchedAt).toBe(1_700);
  });

  it("names the scoped model and leaves a missing reset at zero", () => {
    const got = parseUtilization(LIVE_PAYLOAD, 1_700, undefined);
    const scoped = got?.limits.find((l) => l.kind === "weekly_scoped");

    expect(scoped?.scopeLabel).toBe("Fable");
    expect(scoped?.resetsAt).toBe(0);
  });

  it("answers null for a body with nothing in it", () => {
    expect(parseUtilization({}, 1, undefined)).toBeNull();
    expect(parseUtilization(null, 1, undefined)).toBeNull();
  });
});
