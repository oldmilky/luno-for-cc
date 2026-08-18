<!-- Reference read statically 2026-08-17 against claude CLI 2.1.219
     (bin/claude.exe + sdk-tools.d.ts) and anthropic.claude-code-2.1.233-win32-x64
     (webview/index.js). No live probe: nothing was spawned. Anything needing a
     running process is marked as unverified rather than asserted. -->

# Attachments — a paperclip, and documents the model can actually read

**Status:** planned, nothing built. Written 2026-08-17 from a read of the
reference, so a fresh session does not have to re-derive the contract.

The ask: a paperclip beside the composer that takes several files at once —
not only screenshots through Ctrl+V — and reading for PDF and the rest, matching
the CLI and the official extension.

## Measured against the reference — do not re-derive

Every fragment below is a byte offset away from being re-read. Re-measure only
if the reference moves.

### The official extension's "Attach file" is a plain input

`webview/index.js`, verbatim:

```js
onAttachFile: () => {
  let le = document.createElement("input");
  le.type = "file";
  le.multiple = true;
  le.onchange = () => {
    if (le.files && le.files.length > 0) a(le.files);
  };
  le.click();
};
```

No `showOpenDialog`, no host round trip. The webview owns the picker. Multi-
select is one property.

### Files become content blocks on the user message

Also verbatim, with the reference's minified names spelled out:

```js
switch (classify(mime, name)) {
  case "image":
    push({ type: "image",    source: { type: "base64", media_type: mime, data: b64 } });
  case "text":
    push({ type: "document", source: { type: "text", media_type: "text/plain", data: atob(b64) }, title: name });
  case "pdf":
    push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 }, title: name });
  case "unsupported":
    console.error(`Unsupported file type: ${name} (${mime})`);   // dropped, silently to the user
}
…
push({ type: "text", text: prompt });   // the typed prompt goes LAST
```

Three facts worth keeping: attachments are **native content blocks**, not text;
the prompt is **appended after** them; and an unsupported file is **dropped with
nothing said on screen**.

### The classifier, whole

```js
function classify(mime, name) {
  if (IMAGE_MIMES.includes(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (isTextLike(mime, name)) return "text";
  return "unsupported";
}
```

- `IMAGE_MIMES` = `image/jpeg`, `image/png`, `image/gif`, `image/webp`. **Four,
  and no more** — no `image/svg+xml` (svg is text), no `image/bmp`, no `heic`.
- `isTextLike` = `mime.startsWith("text/")`, **or** one of ~40 `application/*`
  MIME types (`json`, `xml`, `javascript`, `typescript`, `yaml`, `x-sh`, `sql`,
  `graphql`, `toml`, …), **or** the extension is in a set of ~150 (`json`, `yaml`,
  `toml`, `ini`, `env`, `js`, `ts`, `tsx`, `py`, `rb`, `go`, `rs`, `java`, `kt`,
  `c`, `cpp`, `cs`, `swift`, `php`, `lua`, `r`, `ex`, `erl`, `clj`, `hs`, `html`,
  `xml`, `svg`, `css`, `scss`, `vue`, `svelte`, `astro`, `sh`, `ps1`, `bat`,
  `csv`, `tsv`, `sql`, `graphql`, `prisma`, `md`, `mdx`, `rst`, `txt`, `tex`, …),
  **or** the whole filename is one of `license`, `readme`, `changelog`,
  `authors`, `contributors`, `copying`.

### PDF is already done, on the CLI side

`sdk-tools.d.ts` — `FileReadOutput` has a `pdf` variant:

```ts
{
  type: "pdf";
  file: {
    filePath: string;
    base64: string;
    originalSize: number;
  }
}
{
  type: "parts";
  file: {
    filePath: string;
    originalSize: number;
    count: number;
    outputDir: string;
  }
}
```

and `Read` takes a `pages` parameter: _"Page range for PDF files (e.g. `1-5`,
`3`, `10-20`). Only applicable to PDF files. Maximum 20 pages per request."_

So a PDF **already in the workspace** needs nothing from us: the model reads it.
The attachment path exists for a PDF that is **not** in the workspace — a file
from Downloads the user drags in.

### Office documents are not supported by the reference at all

`.docx` / `.xlsx` / `.pptx` are absent from every list above, so `classify`
returns `unsupported` and the file is dropped. The CLI binary does carry the
strings `docx`, `xlsx`, `pptx` and `python-docx`, but their surroundings place
them in Cowork (server-side document work) and in prompt text suggesting the
model shell out to `python-docx` — not in `Read`. **Nothing in the local read
path opens an Office file.**

## What LUNO does today, and why

|                     | Today                                                                            | Reference                               |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| Paperclip           | none                                                                             | `<input type="file" multiple>`          |
| Ctrl+V of an image  | yes                                                                              | yes                                     |
| Drag & drop         | blocked outright                                                                 | inserts an `@mention` for project files |
| Where an image goes | written to `<workspace>/.luno/attachments/`, prompt rewritten to a relative path | an `image` block on the message         |
| PDF                 | none                                                                             | a `document` block                      |
| Text files          | none                                                                             | a `document` block with a `title`       |
| Unsupported         | —                                                                                | dropped, console only                   |

The disk detour in [`src/ui/prompt-attachments.ts`](../../src/ui/prompt-attachments.ts)
was forced: LUNO sends the prompt as a **string**, and a multi-MB base64 blob in
it makes the CLI refuse the turn as too long. Writing the file out and passing a
path works — the model reads it — at the cost of needing an open folder,
littering the workspace, and spending a tool call.

**The road to the reference's way is short:** `Message.content` in
[`src/core/types.ts`](../../src/core/types.ts) is **already**
`string | Array<ContentBlock>`. Only the `image` and `document` variants of
`ContentBlock` are missing.

## The decision on Office documents — variant A, parity

**`.docx`, `.xlsx`, `.pptx` are not supported, and the UI says so.**

Not because they are hard, but because the reference does not read them either:
matching it means a user who attaches a Word file is told, once, plainly. The
alternatives were weighed and rejected for this round — unzipping `.docx` in the
host (it is a zip of XML, ~100 lines for Word alone, but Excel and PowerPoint
are a different order of work), and pushing the file at the model to parse
through Bash (works only where Python is installed).

**Where LUNO deliberately does better than the reference:** the reference drops
an unsupported file with a `console.error` nobody sees. We say it on screen. A
file that silently does not arrive is the worst of the three outcomes.

## Phases

### Phase 1 — the transport (host) — **DONE 2026-08-17**

`ContentBlock` gained `image` and `document`, and the provider now carries a
message's content to stdin instead of a flattening of it.

**The assumption this phase existed to test was false, and that was the whole
finding.** `lastUserText` reduced the newest user message to a string on the way
in:

```ts
const text = (m.content as ContentBlock[]).map((b) =>
  b.type === "text" ? b.text : ""
); // every non-text block dropped
```

So an attachment could have been built anywhere in the host and would still
never have reached the CLI — the write succeeded, the turn ran, and the model
simply never saw the file. Nothing downstream could have told the difference.
Had the paperclip been built first, this would have read as "attachments do not
work" with no obvious cause.

What replaced it:

| Was                               | Now                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `lastUserText(messages): string`  | `lastUserContent(messages): string \| ContentBlock[] \| null`                                |
| —                                 | `textOf(content)` — the words only, for argv and the task classifier                         |
| `preamble + userText`             | `withPreamble()` — a text block in front of an array, concatenation for a string             |
| `if (!userText)` refuses the turn | refuses only with no user message at all, so an attachment with nothing typed is a real turn |

Both write paths carry it: the session one through `writeUserMessage`, and the
per-turn fallback through its own `JSON.stringify`.

**Evidence:** six tests in `claude-cli-stream.test.ts`, asserting the JSON line
the provider put on the fake child's stdin. Verified red first by restoring the
flattening on one line — the image message arrived as the bare string
`'what is wrong here?'`, a PDF-only message as `'r'` (an index into `"read it"`),
and an attachment-only turn as `''`. The two that must not move — a plain string
staying a plain string, and the per-turn path — stayed green through the revert.

**Left for the phases above:** nothing in the host builds a block array yet, so
this is capability only. `session.messages` and the timeline still hold strings.

### Phase 2 — the classifier — **DONE 2026-08-17**

`webview/src/features/chat/composer/attachments.ts`, with
`test/webview/attachments.test.ts` beside it in the node project.

**Not `src/core/`, as this plan first said.** The two halves compile separately
and `webview/src` cannot import from `src/` — the picker is in the webview, so
the classifier is too. `startup-suggestions.ts` is the same shape: React-free
webview logic, tested from `test/webview/`.

What it exports:

|                                           |                                                      |
| ----------------------------------------- | ---------------------------------------------------- |
| `classifyAttachment(mediaType, fileName)` | `"image" \| "pdf" \| "text" \| "unsupported"`        |
| `toAttachmentBlock(fileName, dataUrl)`    | the block to send, or `null` when there is none      |
| `parseDataUrl(dataUrl)`                   | the two halves, or `null` for anything malformed     |
| `AttachmentBlock`                         | the wire shape, mirroring `ContentBlock` on the host |

Both lists are the reference's, whole: four image media types, fourteen
`application/*` text types, ~130 extensions, and the six bare filenames
(`license`, `readme`, …).

Two things it does that the reference does not, both deliberate:

- **Text is decoded as UTF-8**, not through `atob` alone. `atob` yields one
  character per byte, which turns every non-ASCII character in a source file
  into mojibake on the way to the model.
- **A malformed data URL answers `null`** instead of throwing. This runs on
  whatever the clipboard produced; a broken one is a file to report, not a
  crash that takes the composer down.

**Evidence:** 23 tests. The Office trio lands on `unsupported`; `image/bmp` and
`image/heic` are refused (a browser decodes both — the list is the API's, not
the renderer's); `image/svg+xml` classifies as **text**, because it is markup and
the model can read the source; `Makefile`, `LICENSE` and `.gitignore` classify
with no extension to read; and a `.rs`/`.tsx` file with an empty `File.type`
still lands on text, which is the common case since the browser names no media
type for most source files.

### Phase 3 — the paperclip — **DONE 2026-08-17**, and Phase 4 with it

**This plan had a hole: it never named the webview → host hop.** Phases 1 and 2
built a transport and a classifier with nothing between them, and a paperclip
that cannot reach the host is decoration. Folded in here rather than left for
later, because there was no point stopping half way:

| Where                  | What                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `rpc.ts`               | `prompt` gained `attachments?: AttachmentBlock[]`, and the type is declared there — the webview owns the outbound union               |
| `ui/messages.ts`       | `readAttachments()` — validated, not cast. Blocks are rebuilt from checked fields; anything malformed is dropped rather than repaired |
| `conversation-host.ts` | `handlePrompt` → `runPromptTurn` → `Orchestrator.turn` all carry them                                                                 |
| `core/session.ts`      | `addUser(text, attachments)` puts blocks in `messages` and the **names** in the timeline event's `meta`                               |

Two decisions inside that, both load-bearing:

- **A message with attachments never steers.** `steer` writes plain text into a
  process mid-turn; an attachment belongs to a turn being opened. So a message
  carrying one starts its own turn instead of joining the running one.
- **The timeline stores names, not data.** A data URI on the timeline is
  megabytes of base64 in the stored session and a wall of characters in the
  chat. `meta.attachments` holds the labels; `messages` holds the blocks.

The picker itself is the reference's: a hidden `<input type="file" multiple>`
clicked from a button beside the microphone, sharing one `addFiles` path with
Ctrl+V and drop.

**Phase 4 came with it.** `refused` was collected the moment the classifier ran,
and eslint refused to let a variable be set and never read — which was the right
pressure: the alternative was a file that appears attached and is not.

**Evidence:** the harness, four files through the picker in one go — an image, a
PDF, a `.ts` with an empty `File.type`, and a `.docx`.

- Three chips with their own icons and sizes: `shot.png 4 B`, `spec.pdf 4 B`,
  `main.ts 20 B`.
- The refusal, on screen: _"report.docx — not supported. Images, PDFs and text
  files can be attached; Word, Excel and PowerPoint cannot."_
- What went out on `prompt`, read off `__luno.sent`: `image`/base64/`image/png`;
  `document`/base64/`application/pdf` titled `spec.pdf`; and
  `document`/**text**/`text/plain` titled `main.ts` carrying
  `export const x = 1;` — decoded, not base64. Text last.

### Phase 5 — drag & drop — **DONE 2026-08-17**

The rule, and it is not the reference's:

| Dropped                         | Becomes                                         |
| ------------------------------- | ----------------------------------------------- |
| An image                        | an attachment, always — even when a path exists |
| Anything with a resolvable path | an `@mention`                                   |
| Anything else                   | an attachment, through the classifier           |

**Why not the reference's.** It runs _both_ on every drop: each file is attached
**and** each path is mentioned. For a workspace file that sends it twice — once
as a whole text block, once as a pointer — and the pointer alone was already
enough. A path means the agent can `Read` it on demand and spend nothing until
it does; an attachment spends the tokens up front. Images are the exception
because dropping a picture is asking someone to look at it, and a path is the
wrong answer even when there is one.

**The measurement found a bug in the rule as first written.** `collectDroppedPaths`
ended with a fallback that took `file.name` when no path was available — so
_every_ drop counted as "has a path", the attach branch was unreachable, and a
dropped PDF became `@manual.pdf`: a mention resolving to whatever the agent
found under that name, or to nothing. The fallback is gone; only a real path
counts.

**Evidence:** four drops in the harness. A PDF with no path → chip
`manual.pdf` (before: nothing). A `.ts` carrying `file:///repo/src/app.ts` → an
`@app.ts` mention and no chip. An image _with_ a path → a chip, the exception
holding. A `.docx` with no path → refused by name, no chip.

The capture-phase `drop`/`dragover` guards in `RichEditor` were left alone and
needed no change: they only `preventDefault`, so the event still reaches the
composer's handler while the browser is stopped from inlining an `<img>`.

### Phase 6 — retire the disk detour — **PART DONE 2026-08-17, DELETION HELD**

Opening it up changed what it is. Three things were tangled under one heading:

**1. The benefit is already banked, by Phase 3.** `extractInlineImages` only
fires on a `![](data:…)` in the prompt _text_, and the composer stopped
producing those the moment attachments became blocks. LUNO no longer writes to
`<workspace>/.luno/attachments/` in ordinary use — not because the code went,
but because nothing reaches it. The littering is over either way.

**2. The read path must stay, permanently.** A chat stored before this carries
`![name](.luno/attachments/…)` on its timeline, and `MsgImage` resolves it
through the `readAttachment` RPC off disk. Deleting that, or the files, breaks
every old chat that has a screenshot in it. Not "later" — it stays.

**3. The gap Phase 3 actually left, now closed.** `Session.addUser` records
attachment names in `meta`, and **nothing read them**: `groupEvents` took `body`
alone. A message sent with a screenshot and no words rendered as an **empty
bubble** — the whole message, invisible. Fixed: the names ride to
`UserMessage` and render as a receipt row under the text.

Not a preview, deliberately. The bytes went to the model as content blocks and
were kept off the timeline on purpose; re-reading megabytes of base64 into every
reopened chat to draw a thumbnail would undo the reason they were kept off it.

**Evidence:** the harness, a stored session replayed. A message with words shows
`shot.png · spec.pdf · main.ts` beneath them; a message that is only a
screenshot shows `image/png` where it used to show nothing at all.

**What is held, and why.** Deleting `prompt-attachments.ts` and its call site is
all that is left, and it is pure dead-code removal with one live edge: a user
who types or pastes a literal `![x](data:image/png;base64,…)` as _text_ still
gets it written out and shrunk, instead of a multi-MB prompt the CLI refuses.
That is the case the module was written for.

Held against the same rule this repo already applies to the unreachable
per-turn path in `carried-forward.md`: **a fallback is deleted after the
replacement has run for real, not before.** Phases 1–5 have not been through a
live CLI once. Delete it after a real session sends a PDF and the model reads
it — the deletion is five minutes then and a regression hunt now.

### Phase 7 — the help panel and the docs — **DONE 2026-08-17**

`?` gained a **Attaching** group — the paperclip and what it takes, and the drop
rule in one line — plus `⌘/Ctrl V` under Writing. The paperclip is a button and
has no chord, so it is listed by its glyph rather than given a keybinding: every
plausible chord (`Ctrl+Shift+A` and friends) is already spoken for somewhere in
VS Code or Cursor, and inventing a conflict to fill a table row is not worth it.

`docs/ATTACHMENTS.md`, indexed from CLAUDE.md's table.

**It does not repeat the lists**, which is a change from what this plan said.
Copying ~130 extensions into Markdown creates a second copy to drift from the
first, and the code already carries them commented — this repo has a
`protocol-contract` test precisely because two hand-kept copies of one list do
not stay in step. What the doc carries instead is what the code cannot: the
three kinds and their block shapes, why the lists are not ours to extend, why
`image/svg+xml` is text and `image/bmp` is refused, the Office decision, the
drop routing rule, the wire order, what the timeline keeps, and that the old
`.luno/attachments/` read path stays.

**Evidence:** the harness, `?` opened and scrolled — the Attaching group renders
between Writing and Navigation with both rows.

## Order, and where to stop

```
1  transport            small · verify the array first
2  classifier           small · no risk
3  paperclip            medium · the visible half
4  refused files        small
5  drag & drop          small
6  retire .luno/        medium · ⚠ behaviour, needs a live run first
7  help + docs          small
```

**Stopping after 5 is a complete outcome**: the paperclip works, several files
at once, images and PDFs and text files reach the model the way the reference
sends them, and an Office file gets an honest answer. Phase 6 is cleanup that
can wait for evidence from real use.

## Decisions already made — do not "fix" these back

- **Four image MIME types, not more.** `image/svg+xml` is text and travels as a
  document; adding `bmp`/`heic` would send the model something the API does not
  accept.
- **The typed prompt goes last**, after the attachment blocks. That is the
  reference's order and the model reads the instruction against material it has
  already seen.
- **Office documents are refused out loud**, not silently, and not parsed.
- **The picker lives in the webview**, not behind a `showOpenDialog` on the host.
  One less protocol hop, and it is what the reference does.

## Rollback

One phase per commit. Phases 1–5 add; nothing existing changes shape until
Phase 6, which is the only one that needs a revert plan of its own.
