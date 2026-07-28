import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readUsageUtilization,
  planFromTier
} from "../../src/services/usage-utilization.js";

// The shape here is copied from a real `~/.claude.json` on a Max 20× account,
// trimmed to the fields we read. It is the file that proved the meter wrong:
// the panel said "over" and 42% while these numbers said 11% and 29%.
const REAL_SHAPE = {
  oauthAccount: {
    organizationRateLimitTier: "default_claude_max_20x",
    userRateLimitTier: null
  },
  cachedUsageUtilization: {
    fetchedAtMs: 1785177953179,
    utilization: {
      five_hour: { utilization: 11, resets_at: "2026-07-27T22:10:00.113057Z" },
      seven_day: { utilization: 29, resets_at: "2026-08-02T22:00:00.113078Z" },
      seven_day_opus: null,
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 11,
          severity: "normal",
          resets_at: "2026-07-27T22:10:00.113057Z",
          scope: null,
          is_active: false
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 29,
          severity: "normal",
          resets_at: "2026-08-02T22:00:00.113078Z",
          scope: null,
          is_active: true
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 0,
          severity: "normal",
          resets_at: "2026-08-02T22:00:00.113342Z",
          scope: { model: { id: null, display_name: "Fable" } },
          is_active: false
        }
      ]
    }
  }
};

let dir: string;
const write = (value: unknown): string => {
  const p = path.join(dir, "claude.json");
  fs.writeFileSync(p, JSON.stringify(value));
  return p;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "luno-util-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reading the account's own figures", () => {
  it("takes the percentages the server reported", async () => {
    const got = await readUsageUtilization(write(REAL_SHAPE));

    expect(got?.limits.map((l) => [l.kind, l.percent])).toEqual([
      ["session", 11],
      ["weekly_all", 29],
      ["weekly_scoped", 0]
    ]);
    expect(got?.fetchedAt).toBe(1785177953179);
  });

  it("names the model a scoped weekly limit belongs to", async () => {
    const got = await readUsageUtilization(write(REAL_SHAPE));
    const scoped = got?.limits.find((l) => l.kind === "weekly_scoped");

    // Hard-coding this row to Sonnet is what the old panel did; on this account
    // the scoped limit is Fable's.
    expect(scoped?.scopeLabel).toBe("Fable");
  });

  it("turns reset timestamps into epoch ms", async () => {
    const got = await readUsageUtilization(write(REAL_SHAPE));
    const session = got?.limits.find((l) => l.kind === "session");

    expect(session?.resetsAt).toBe(Date.parse("2026-07-27T22:10:00.113057Z"));
  });

  it("reads the plan off the account's tier", async () => {
    const got = await readUsageUtilization(write(REAL_SHAPE));
    expect(got?.plan).toBe("max20");
  });

  it("prefers the user's own tier over the organisation's", async () => {
    const got = await readUsageUtilization(
      write({
        ...REAL_SHAPE,
        oauthAccount: {
          organizationRateLimitTier: "default_claude_max_20x",
          userRateLimitTier: "default_claude_pro"
        }
      })
    );
    expect(got?.plan).toBe("pro");
  });

  it("answers null when the file has nothing to say", async () => {
    expect(await readUsageUtilization(write({ foo: 1 }))).toBeNull();
    expect(
      await readUsageUtilization(path.join(dir, "absent.json"))
    ).toBeNull();
  });

  it("survives a file that is not JSON at all", async () => {
    const p = path.join(dir, "broken.json");
    fs.writeFileSync(p, "{not json");
    expect(await readUsageUtilization(p)).toBeNull();
  });

  it("leaves an unrecognised tier unmapped rather than guessing", () => {
    // A tier we cannot place must not silently pick a plan — the user's own
    // choice stands instead.
    expect(planFromTier("something_new_2027")).toBeNull();
    expect(planFromTier(undefined)).toBeNull();
    expect(planFromTier("default_claude_max_5x")).toBe("max5");
    expect(planFromTier("enterprise_seat")).toBe("team");
  });
});
