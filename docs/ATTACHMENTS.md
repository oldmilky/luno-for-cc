# LUNO for CC — Attachments

_What a file becomes when it goes into a message. Source of truth is
`webview/src/features/chat/composer/attachments.ts`; this file explains it and
records the decisions the code cannot._

## Three kinds, and a fourth answer

A picked file is classified once, by media type and name together, into one of
four outcomes:

| Kind          | What is sent                                                             |
| ------------- | ------------------------------------------------------------------------ |
| `image`       | an `image` block, base64, keeping its own media type                     |
| `pdf`         | a `document` block, base64, `application/pdf`, titled with the file name |
| `text`        | a `document` block, **decoded**, `text/plain`, titled with the file name |
| `unsupported` | nothing — the panel names the file and says why                          |

The lists behind that live in `attachments.ts` and are not repeated here: four
image media types, fourteen `application/*` types that are text in all but
their label, roughly 130 extensions, and six bare filenames (`license`,
`readme`, `changelog`, `authors`, `contributors`, `copying`).

**They are not ours to extend.** They were ported from the reference client
(`anthropic.claude-code`, read statically in August 2026) because the API's
acceptance is what they describe. A media type outside them is a request the
server refuses, not a matter of taste — which is why `image/bmp` and
`image/heic` are refused although every browser decodes both.

Two consequences worth knowing before reading the code as a bug:

- **`image/svg+xml` is `text`, not `image`.** It is markup, and the model reads
  the source — more useful than a picture of it.
- **A file with an empty `File.type` is still classified.** The browser names a
  media type only for what it can render, so most source files arrive without
  one and the extension is the only thing left to read.

## Office documents are refused, deliberately

`.docx`, `.xlsx` and `.pptx` classify as `unsupported`, and the panel says so
by name.

This is parity, not an omission. The CLI's `Read` tool does not open them —
its `FileReadOutput` has variants for images, notebooks and PDFs and nothing
else — and neither does the reference client, whose own classifier drops them.

Where LUNO deliberately does better: the reference discards an unsupported file
with a `console.error` nobody sees. A file that appears attached and is not is
the worst outcome available, so ours is reported on screen.

## Three ways in, one path

The paperclip beside the microphone, `Ctrl+V`, and drag & drop all end in the
same `addFiles`. The picker is a hidden `<input type="file" multiple>` clicked
from the button — the webview can open the OS dialog itself, and routing it
through the extension host would be a protocol hop for nothing.

**A drop is routed rather than always attached:**

| Dropped                         | Becomes                                         |
| ------------------------------- | ----------------------------------------------- |
| an image                        | an attachment, always — even when a path exists |
| anything with a resolvable path | an `@mention`                                   |
| anything else                   | an attachment                                   |

A path means the agent can `Read` the file on demand and spends nothing until
it does; an attachment spends the tokens up front. Images are the exception
because dropping a picture is asking someone to look at it. The reference does
both to every drop — attach _and_ mention — which sends a workspace file twice.

## On the wire

Attachments cross the seam on the `prompt` message as `attachments`, are
re-validated host-side by `readAttachments` in `src/ui/messages.ts` — rebuilt
from checked fields, never cast — and reach the CLI as the user message's
`content` array, in this order:

```
[ …attachment blocks…, { type: "text", text: "what the user typed" } ]
```

The typed words go **last**, after what they are about. That is the reference's
order and it reads correctly: the instruction follows its subject.

A message carrying an attachment always opens its own turn. Steering writes
plain text into a process mid-turn and has nowhere to put a block.

## What the timeline keeps

Names, not bytes. `Session.addUser` puts the blocks in `messages` — what the
model reads — and the file names in the timeline event's `meta.attachments`,
which the bubble renders as a receipt row.

A data URI on the timeline would be megabytes of base64 in the stored session
and re-read into every reopened chat. The receipt is what makes an
attachment-only message visible at all: without it, a screenshot sent with no
words rendered as an empty bubble.

## The older shape, still readable

Before attachments were blocks, a pasted image was written to
`<workspace>/.luno/attachments/` and the prompt was rewritten to a relative
path. Chats stored then still carry `![name](.luno/attachments/…)` on their
timeline, and `MsgImage` resolves those through the `readAttachment` RPC off
disk.

**That read path stays.** Removing it, or the files it points at, breaks every
old chat that has a screenshot in it.
