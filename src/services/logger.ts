// ─────────────────────────────────────────────────────────────
// Where Luno says what it is doing.
//
// Everything used to go to `console`, which in a packaged extension means the
// Extension Host devtools — somewhere a user has no reason to know about and
// cannot be walked through over a bug report.
//
// This module imports no vscode API on purpose. It is called from the provider
// and core layers, which are unit-tested with no editor around; importing
// vscode here made every one of those tests fail on a missing mock. The output
// channel is attached from the extension entry point through `setLogSink`, and
// until something attaches one the console write is the whole story.
// ─────────────────────────────────────────────────────────────

export type LogSink = (line: string) => void;

let sink: LogSink | undefined;

/** Attach somewhere for log lines to also go — the output channel, in the
 *  running extension. Passing undefined detaches. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

export function log(message: string, ...rest: unknown[]): void {
  write("info", message, rest);
}

export function warn(message: string, ...rest: unknown[]): void {
  write("warn", message, rest);
}

export function error(message: string, ...rest: unknown[]): void {
  write("error", message, rest);
}

function write(level: string, message: string, rest: unknown[]): void {
  const detail = rest.length > 0 ? ` ${rest.map(render).join(" ")}` : "";
  const line = `${stamp()} [${level}] ${message}${detail}`;

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  try {
    sink?.(line);
  } catch {
    // A disposed channel must never be the reason an operation fails.
  }
}

/** Local time, no date: a log read during a session is read within a day of
 *  being written, and the date is noise on every line. */
function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function render(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
