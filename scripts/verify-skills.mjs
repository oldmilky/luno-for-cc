#!/usr/bin/env node
// Check the vendored skills against `skills-lock.json`, or rewrite the lock
// from what is on disk.
//
//   bun run skills:verify     fail if a vendored SKILL.md drifted
//   bun run skills:verify --write   record the current contents as the lock
//
// The hash covers the vendored `SKILL.md` with line endings normalised to LF —
// this repo checks out CRLF, and a lock that disagrees with itself on every
// Windows clone is a lock everybody learns to ignore.
//
// What it proves: nobody edited a vendored skill in place. What it does NOT
// prove: that the file still matches upstream. Re-vendoring is a deliberate
// act — pull the new copy, read the diff, then `--write`.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = path.join(ROOT, "skills-lock.json");
const write = process.argv.includes("--write");

const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));

const hashOf = (file) =>
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");

let drifted = 0;
let missing = 0;

for (const [name, entry] of Object.entries(lock.skills)) {
  const file = path.join(ROOT, ".claude", "skills", name, "SKILL.md");
  if (!fs.existsSync(file)) {
    console.log(`  missing   ${name}`);
    missing++;
    continue;
  }
  const actual = hashOf(file);
  if (write) {
    entry.computedHash = actual;
    console.log(`  recorded  ${name}  ${actual.slice(0, 12)}`);
    continue;
  }
  if (actual === entry.computedHash) {
    console.log(`  ok        ${name}`);
  } else {
    console.log(`  DRIFTED   ${name}`);
    console.log(`            lock ${entry.computedHash.slice(0, 16)}`);
    console.log(`            disk ${actual.slice(0, 16)}`);
    drifted++;
  }
}

if (write) {
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  console.log(`\n  wrote ${path.relative(ROOT, LOCK)}`);
  process.exit(0);
}

console.log(
  `\n  ${Object.keys(lock.skills).length - drifted - missing} ok, ` +
    `${drifted} drifted, ${missing} missing`
);
process.exit(drifted + missing > 0 ? 1 : 0);
