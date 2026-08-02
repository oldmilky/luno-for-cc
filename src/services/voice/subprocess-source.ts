// ─────────────────────────────────────────────────────────────
// The microphone, through a recorder that writes PCM to stdout.
//
// One implementation for two cases, because they differ only in which program
// is spawned: the recorder this extension ships, and `rec`/`arecord` where a
// user already had them. Both produce the same stream, so nothing above this
// file learns which one answered.
// ─────────────────────────────────────────────────────────────

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AudioSource } from "../../core/voice/audio-source.js";
import {
  BORROWED_CANDIDATES,
  CAPTURE_COMMANDS,
  audioSlotFor,
  chooseCapture,
  recorderFileName,
  type CaptureBackend
} from "../../core/voice/backends.js";

const LOOKUP_TIMEOUT_MS = 2_000;

function onPath(command: string): Promise<boolean> {
  const which = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(which, [command], { timeout: LOOKUP_TIMEOUT_MS }, (err) =>
      resolve(!err)
    );
  });
}

/** Absolute path to the shipped recorder for this machine, or null. */
export function bundledRecorderPath(extensionPath: string): string | null {
  const slot = audioSlotFor(process.platform, process.arch);
  if (!slot) return null;
  return path.join(
    extensionPath,
    "resources",
    "audio",
    slot,
    recorderFileName(process.platform)
  );
}

export interface CaptureCommand {
  backend: CaptureBackend;
  command: string;
  args: readonly string[];
}

/** What this machine can record with, asked in preference order. */
export async function findCaptureCommand(
  extensionPath: string
): Promise<CaptureCommand | null> {
  const bundled = bundledRecorderPath(extensionPath);
  const present = bundled
    ? await fs
        .access(bundled)
        .then(() => true)
        .catch(() => false)
    : false;

  const borrowed: ("rec" | "arecord")[] = [];
  if (!present)
    for (const candidate of BORROWED_CANDIDATES)
      if (await onPath(candidate)) borrowed.push(candidate);

  const backend = chooseCapture({ bundled: present, borrowed });
  if (!backend) return null;
  if (backend === "bundled")
    return { backend, command: bundled as string, args: [] };
  return { backend, command: backend, args: CAPTURE_COMMANDS[backend] };
}

export class SubprocessAudioSource implements AudioSource {
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(private readonly capture: CaptureCommand) {}

  start(onChunk: (pcm: Uint8Array) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      // stderr is piped and read: our own recorder explains a refused device
      // there in a sentence meant for the user, and a pipe nobody drains
      // would eventually stall the process that wrote to it.
      const child = spawn(this.capture.command, [...this.capture.args], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.child = child;
      let complaint = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        if (!this.stopped) onChunk(new Uint8Array(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        complaint += chunk.toString();
      });
      child.on("error", (err) => {
        this.child = null;
        reject(err);
      });
      child.on("exit", (code) => {
        this.child = null;
        // Stopping kills it, so an exit we asked for is never a failure.
        if (this.stopped || !code) return resolve();
        reject(new Error(complaint.trim() || "The recorder stopped."));
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }
}
