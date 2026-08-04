import { describe, it, expect } from "vitest";
import { withPinnedMentions } from "../../webview/src/features/chat/composer/compose-prompt.js";
import type { PinnedFile } from "../../webview/src/features/chat/composer/PinnedContext.js";

// What the composer sends is not what was typed: pins are folded in as
// `@`-mentions on the way out. That rewrite lived in a closure inside a JSX
// prop in `App.tsx`, where nothing could reach it.

const pin = (label: string): PinnedFile =>
  ({ label, path: `/repo/${label}` }) as PinnedFile;

describe("folding pinned files into what gets sent", () => {
  it("sends the text unchanged when nothing is pinned", () => {
    expect(withPinnedMentions("what does this do", [])).toBe(
      "what does this do"
    );
  });

  it("prepends a mention for each pin, above a blank line", () => {
    expect(withPinnedMentions("explain", [pin("a.ts"), pin("b.ts")])).toBe(
      "@a.ts @b.ts\n\nexplain"
    );
  });

  // The pin is the promise that the file is in scope; naming it twice spends
  // context on the same file and reads as a stutter in the prompt.
  it("skips a pin the text already mentions", () => {
    expect(withPinnedMentions("look at @a.ts", [pin("a.ts"), pin("b.ts")])).toBe(
      "@b.ts\n\nlook at @a.ts"
    );
  });

  // The picker capitalises whatever the filesystem handed it; a hand-typed
  // mention rarely matches. Comparing exactly would double every such pin.
  it("matches an existing mention regardless of case", () => {
    expect(withPinnedMentions("see @App.tsx", [pin("app.tsx")])).toBe(
      "see @App.tsx"
    );
  });

  it("adds nothing when every pin is already mentioned", () => {
    const text = "@a.ts and @b.ts";
    expect(withPinnedMentions(text, [pin("a.ts"), pin("b.ts")])).toBe(text);
  });
});
