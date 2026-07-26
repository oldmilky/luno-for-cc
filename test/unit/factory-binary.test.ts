import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  chmodSync
} from "node:fs";
import { execFileSync } from "node:child_process";

// resolveClaudeBinary() reads `luno.claudeBinaryPath` from VS Code config.
// A hoisted holder lets each test set what the mocked config returns.
const cfg = vi.hoisted(() => ({ override: "" }));
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, _fallback?: string) => cfg.override
    })
  }
}));

// Auto-discovery consults `os.homedir()` for the native installer's directory.
// Left real by default; the discovery tests point it at a temp dir so this
// machine's actual Claude install cannot influence the result.
const fakeHome = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    default: actual,
    homedir: () => fakeHome.dir || actual.homedir()
  };
});

// node:fs method exports are non-configurable, so vi.spyOn(fs, ...) can't wrap
// them. Mock the module instead, keeping every function real (call-through)
// except making chmodSync/statSync overridable for the failure-path test.
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    statSync: vi.fn(actual.statSync),
    chmodSync: vi.fn(actual.chmodSync)
  };
});

import {
  ensureExecutable,
  bundledClaudeBinary,
  resolveClaudeBinary,
  discoverClaudeBinary
} from "../../src/providers/factory.js";

// Run `fn` as if the process were on `platform`, then restore the real value.
// (process.platform is a getter, so we redefine it rather than assign.)
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true
  });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", orig);
  }
}

let tmpRoot: string;
let counter = 0;

// A throwaway file standing in for the bundled binary, created with a known
// permission mode. Unique per call so the in-module memoisation never masks a
// fresh test.
function fakeBinary(mode: number): string {
  const p = path.join(tmpRoot, `claude-${counter++}.exe`);
  writeFileSync(p, "#!/bin/sh\necho hi\n");
  chmodSync(p, mode);
  return p;
}

const EXEC_BITS = 0o111; // --x--x--x

// Whether this filesystem can actually store the Unix exec bit. NTFS cannot —
// node's chmod there only toggles the read-only attribute, so `mode & 0o111`
// reads back as 0 no matter what was written, and the POSIX assertions below
// would fail against a perfectly correct implementation. Probe the filesystem
// rather than branch on `process.platform`: a FAT volume mounted on Linux
// behaves the same way, and these tests already fake the platform freely.
const FS_HAS_EXEC_BIT = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "luno-execbit-"));
  try {
    const probe = path.join(dir, "probe");
    writeFileSync(probe, "");
    chmodSync(probe, 0o755);
    return (statSync(probe).mode & EXEC_BITS) === EXEC_BITS;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let realPath: string | undefined;
let realAppData: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "luno-bin-"));
  cfg.override = "";
  realPath = process.env.PATH;
  realAppData = process.env.APPDATA;
  // Module-factory mocks are not spies, so restoreAllMocks() does not reset
  // their call history. Call-count assertions need a clean slate per test.
  vi.mocked(fs.chmodSync).mockClear();
  vi.mocked(fs.statSync).mockClear();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  if (realAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = realAppData;
  fakeHome.dir = "";
  vi.restoreAllMocks();
});

/**
 * Cut the process off from every real install location: PATH becomes exactly
 * `dirs`, and both `%APPDATA%` and `$HOME` point inside the throwaway tmp
 * root. Without this the dev machine's own `claude` satisfies discovery and
 * the assertions prove nothing.
 */
function isolate(dirs: string[] = []): void {
  process.env.PATH = dirs.join(path.delimiter);
  process.env.APPDATA = path.join(tmpRoot, "appdata");
  fakeHome.dir = path.join(tmpRoot, "home");
}

/** A directory inside the tmp root, created on demand. */
function tmpDir(...segments: string[]): string {
  const dir = path.join(tmpRoot, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** An empty file at `<dir>/<name>`, parents created. */
function touch(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, "");
  return p;
}

// These assert what the filesystem holds after the fact, so they only mean
// anything where the exec bit is real. The describe below covers the same
// logic through the chmod call itself, and runs everywhere.
describe.skipIf(!FS_HAS_EXEC_BIT)("ensureExecutable — exec bit on disk", () => {
  it("adds the executable bit on Linux when it is missing", () => {
    withPlatform("linux", () => {
      const p = fakeBinary(0o644); // rw-r--r-- — not executable
      ensureExecutable(p);
      expect(statSync(p).mode & EXEC_BITS).toBe(EXEC_BITS);
    });
  });

  it("adds the executable bit on macOS when it is missing", () => {
    withPlatform("darwin", () => {
      const p = fakeBinary(0o644);
      ensureExecutable(p);
      expect(statSync(p).mode & EXEC_BITS).toBe(EXEC_BITS);
    });
  });

  it("leaves an already-executable binary untouched and never throws", () => {
    withPlatform("linux", () => {
      const p = fakeBinary(0o755); // rwxr-xr-x — already runnable
      expect(() => ensureExecutable(p)).not.toThrow();
      expect(statSync(p).mode & 0o777).toBe(0o755);
    });
  });

  it("never modifies the bit on Windows (executability comes from .exe)", () => {
    withPlatform("win32", () => {
      const p = fakeBinary(0o644);
      ensureExecutable(p);
      // Returned early on win32 — the non-executable mode is left as-is.
      expect(statSync(p).mode & EXEC_BITS).toBe(0);
    });
  });

  it("only acts on a given path once per session (memoised)", () => {
    withPlatform("linux", () => {
      const p = fakeBinary(0o644);
      ensureExecutable(p); // first call: makes it executable + memoises p
      expect(statSync(p).mode & EXEC_BITS).toBe(EXEC_BITS);

      // Strip the bit again behind ensureExecutable's back. Because p is now
      // memoised, a second call must short-circuit and NOT restore it.
      chmodSync(p, 0o644);
      ensureExecutable(p);
      expect(statSync(p).mode & EXEC_BITS).toBe(0);
    });
  });
});

// Same decisions, asserted through the chmod call rather than the mode that
// lands on disk — so the logic stays covered on a filesystem that cannot
// represent the bit at all (Windows, where this is developed).
describe("ensureExecutable — decisions, on any filesystem", () => {
  it("asks for exactly the existing mode plus +x", () => {
    withPlatform("linux", () => {
      const p = fakeBinary(0o644);
      // Read the mode as the filesystem actually reports it: on NTFS a file
      // written 0o644 comes back 0o666, and the assertion is about the
      // relationship between what we read and what we request, not the number.
      const before = statSync(p).mode;
      vi.mocked(fs.chmodSync).mockClear();

      ensureExecutable(p);

      expect(fs.chmodSync).toHaveBeenCalledWith(p, before | EXEC_BITS);
    });
  });

  it("does not chmod at all on Windows", () => {
    withPlatform("win32", () => {
      const p = fakeBinary(0o644);
      vi.mocked(fs.chmodSync).mockClear();

      ensureExecutable(p);

      expect(fs.chmodSync).not.toHaveBeenCalled();
    });
  });

  it("does not chmod a binary that already carries the bits", () => {
    withPlatform("linux", () => {
      const p = fakeBinary(0o644);
      // Report it as already-executable regardless of what the filesystem
      // stored, so this case is reachable off POSIX.
      vi.mocked(fs.statSync).mockReturnValueOnce({ mode: 0o755 } as fs.Stats);
      vi.mocked(fs.chmodSync).mockClear();

      ensureExecutable(p);

      expect(fs.chmodSync).not.toHaveBeenCalled();
    });
  });

  it("chmods a given path only once per session (memoised)", () => {
    withPlatform("linux", () => {
      const p = fakeBinary(0o644);
      vi.mocked(fs.chmodSync).mockClear();

      ensureExecutable(p);
      ensureExecutable(p);
      ensureExecutable(p);

      expect(fs.chmodSync).toHaveBeenCalledTimes(1);
    });
  });

  it("does not throw when the binary is absent (caller reports it)", () => {
    withPlatform("linux", () => {
      const missing = path.join(tmpRoot, "nope", "claude.exe");
      expect(() => ensureExecutable(missing)).not.toThrow();
    });
  });

  it("does not memoise an absent path, so a later call still fixes it", () => {
    withPlatform("linux", () => {
      const dir = tmpDir("appears-later");
      const p = path.join(dir, "claude.exe");

      ensureExecutable(p); // nothing on disk yet — must not memoise
      writeFileSync(p, "");
      chmodSync(p, 0o644);
      vi.mocked(fs.chmodSync).mockClear();

      ensureExecutable(p);

      expect(fs.chmodSync).toHaveBeenCalled();
    });
  });

  it("survives a chmod failure (e.g. read-only filesystem) without crashing", () => {
    withPlatform("linux", () => {
      const p = fakeBinary(0o644);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Force the next chmod (the one inside ensureExecutable) to fail.
      vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("EROFS: read-only file system"), {
          code: "EROFS"
        });
      });

      expect(() => ensureExecutable(p)).not.toThrow();
      expect(warn).toHaveBeenCalled();
    });
  });
});

describe("bundledClaudeBinary — path resolution", () => {
  it("resolves to @anthropic-ai/claude-code/bin/claude.exe", () => {
    const b = bundledClaudeBinary();
    expect(
      b.endsWith(path.join("@anthropic-ai", "claude-code", "bin", "claude.exe"))
    ).toBe(true);
  });

  it("uses the same path on macOS, Linux, and Windows (no per-OS filename branch)", () => {
    const seen = new Set<string>();
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      withPlatform(platform, () => seen.add(bundledClaudeBinary()));
    }
    // One identical path across all three platforms — the `.exe` placeholder
    // is intentional and OS-independent.
    expect(seen.size).toBe(1);
  });
});

// The manifest default used to be one machine's absolute npm path, so every
// other machine started broken. Discovery replaces it. Every test here runs
// isolated — see `isolate()` — because the dev machine has a real `claude` on
// PATH that would otherwise answer for the fixtures.
describe("discoverClaudeBinary — PATH and the known install dirs", () => {
  it("finds claude.exe in a PATH directory on Windows", () => {
    withPlatform("win32", () => {
      const dir = tmpDir("on-path");
      const exe = touch(dir, "claude.exe");
      isolate([dir]);

      expect(discoverClaudeBinary()).toBe(exe);
    });
  });

  it("finds a bare `claude` in a PATH directory on Unix", () => {
    withPlatform("linux", () => {
      const dir = tmpDir("on-path");
      const bin = touch(dir, "claude");
      isolate([dir]);

      expect(discoverClaudeBinary()).toBe(bin);
    });
  });

  it("steps past npm's .cmd shim to the .exe it wraps", () => {
    withPlatform("win32", () => {
      // npm's global install: shims in the PATH dir, the real executable one
      // level down. We spawn without a shell and node refuses to exec a .cmd,
      // so resolving to the shim would look fine here and fail on turn one.
      const dir = tmpDir("npm-global");
      touch(dir, "claude.cmd");
      touch(dir, "claude.ps1");
      const exe = touch(
        path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin"),
        "claude.exe"
      );
      isolate([dir]);

      expect(discoverClaudeBinary()).toBe(exe);
    });
  });

  it("does not resolve to a .cmd shim with no .exe behind it", () => {
    withPlatform("win32", () => {
      const dir = tmpDir("shim-only");
      touch(dir, "claude.cmd");
      isolate([dir]);

      expect(discoverClaudeBinary()).toBeNull();
    });
  });

  it("ignores a directory named like the binary", () => {
    withPlatform("linux", () => {
      const dir = tmpDir("decoy");
      fs.mkdirSync(path.join(dir, "claude"));
      isolate([dir]);

      expect(discoverClaudeBinary()).toBeNull();
    });
  });

  it("takes the earliest PATH entry that has one", () => {
    withPlatform("linux", () => {
      const first = tmpDir("first");
      const second = tmpDir("second");
      const winner = touch(first, "claude");
      touch(second, "claude");
      isolate([first, second]);

      expect(discoverClaudeBinary()).toBe(winner);
    });
  });

  it("survives a PATH entry that does not exist", () => {
    withPlatform("linux", () => {
      const real = tmpDir("real");
      const bin = touch(real, "claude");
      isolate([path.join(tmpRoot, "nope"), real]);

      expect(discoverClaudeBinary()).toBe(bin);
    });
  });

  it("strips quotes off a PATH entry", () => {
    withPlatform("win32", () => {
      // Windows PATH entries are sometimes quoted; path.join would keep the
      // quote and every probe under that entry would miss.
      const dir = tmpDir("quoted");
      const exe = touch(dir, "claude.exe");
      isolate([`"${dir}"`]);

      expect(discoverClaudeBinary()).toBe(exe);
    });
  });

  it("falls back to the native installer's dir when PATH has nothing", () => {
    withPlatform("win32", () => {
      isolate([]);
      // ~/.claude/local — where Claude Code's own installer puts it. `isolate`
      // has already pointed the home dir inside tmpRoot.
      const exe = touch(
        path.join(tmpRoot, "home", ".claude", "local"),
        "claude.exe"
      );

      expect(discoverClaudeBinary()).toBe(exe);
    });
  });

  it("falls back to the npm global dir when PATH has nothing", () => {
    withPlatform("win32", () => {
      isolate([]);
      const exe = touch(
        path.join(
          tmpRoot,
          "appdata",
          "npm",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "bin"
        ),
        "claude.exe"
      );

      expect(discoverClaudeBinary()).toBe(exe);
    });
  });

  it("returns null when there is no claude anywhere", () => {
    // Faked as win32 on purpose: the Unix branch also probes /usr/local/bin
    // and /opt/homebrew/bin, which no test can isolate, so a dev machine with
    // a real install there would make this assertion unfalsifiable.
    withPlatform("win32", () => {
      isolate([tmpDir("empty")]);

      expect(discoverClaudeBinary()).toBeNull();
    });
  });

  it("re-probes after the memoised binary disappears (an npm update)", () => {
    withPlatform("win32", () => {
      const first = tmpDir("v1");
      const firstExe = touch(first, "claude.exe");
      isolate([first]);
      expect(discoverClaudeBinary()).toBe(firstExe);

      fs.rmSync(firstExe);
      const second = tmpDir("v2");
      const secondExe = touch(second, "claude.exe");
      isolate([second]);

      expect(discoverClaudeBinary()).toBe(secondExe);
    });
  });
});

describe("resolveClaudeBinary — override, discovery, bundled", () => {
  it("returns the override when it points at an existing file", () => {
    const p = fakeBinary(0o755);
    cfg.override = p;
    expect(resolveClaudeBinary()).toBe(p);
  });

  it("prefers the override over a binary that discovery would have found", () => {
    withPlatform("win32", () => {
      const pinned = touch(tmpDir("pinned"), "claude.exe");
      const onPath = tmpDir("on-path");
      touch(onPath, "claude.exe");
      isolate([onPath]);
      cfg.override = pinned;

      // A user with several installs pins one; discovery must not overrule it.
      expect(resolveClaudeBinary()).toBe(pinned);
    });
  });

  it("discovers a binary when no override is configured", () => {
    withPlatform("win32", () => {
      const dir = tmpDir("on-path");
      const exe = touch(dir, "claude.exe");
      isolate([dir]);
      cfg.override = "";

      expect(resolveClaudeBinary()).toBe(exe);
    });
  });

  it("discovers a binary when the override path does not exist", () => {
    withPlatform("win32", () => {
      const dir = tmpDir("on-path");
      const exe = touch(dir, "claude.exe");
      isolate([dir]);
      cfg.override = path.join(tmpRoot, "does-not-exist", "claude.exe");

      expect(resolveClaudeBinary()).toBe(exe);
    });
  });

  it("falls back to the bundled path when nothing is configured or found", () => {
    withPlatform("win32", () => {
      isolate([tmpDir("empty")]);
      cfg.override = "";

      // Does not exist on a LUNO build — the call sites all check, and the
      // panel turns it into "install Claude Code, or set the path".
      expect(resolveClaudeBinary()).toBe(bundledClaudeBinary());
    });
  });

  it("never chmods a binary it did not ship — neither override nor discovered", () => {
    withPlatform("linux", () => {
      const p = fakeBinary(0o644);
      cfg.override = p;
      vi.mocked(fs.chmodSync).mockClear();

      expect(resolveClaudeBinary()).toBe(p);
      // Reaching into someone's own install and changing its mode is not our
      // call; ensureExecutable is for a binary *we* ship.
      expect(fs.chmodSync).not.toHaveBeenCalled();
    });
  });
});

// End-to-end proof against the actual bundled binary on the host platform.
// Runs on macOS (dev) and Linux (CI); skips on Windows, where the exec bit is
// meaningless. Reproduces the real-world bug — a .vsix install that drops the
// exec bit → exit 126 — and proves ensureExecutable() recovers it.
const REAL_BIN = path.resolve(
  process.cwd(),
  "node_modules/@anthropic-ai/claude-code/bin/claude.exe"
);
const canRunRealBin = process.platform !== "win32" && fs.existsSync(REAL_BIN);

describe("ensureExecutable — end-to-end against the real bundled binary", () => {
  it.skipIf(!canRunRealBin)(
    "restores a stripped exec bit so the real binary runs again",
    () => {
      try {
        // Simulate a freshly installed .vsix that lost the exec bit.
        chmodSync(REAL_BIN, 0o644);
        expect(() =>
          execFileSync(REAL_BIN, ["--version"], {
            stdio: "ignore",
            timeout: 30_000
          })
        ).toThrow(); // OS refuses to exec → spawn EACCES / exit 126

        // The fix: ensureExecutable restores +x...
        ensureExecutable(REAL_BIN);
        expect(statSync(REAL_BIN).mode & EXEC_BITS).toBe(EXEC_BITS);

        // ...and the binary now actually launches and reports its version.
        const out = execFileSync(REAL_BIN, ["--version"], {
          encoding: "utf8",
          timeout: 30_000
        });
        expect(out).toMatch(/\d+\.\d+\.\d+/);
      } finally {
        // Always leave the binary runnable for the rest of the suite / dev.
        chmodSync(REAL_BIN, 0o755);
      }
    }
  );
});
