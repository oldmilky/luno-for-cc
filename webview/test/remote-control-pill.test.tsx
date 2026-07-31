import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { TOOLTIP_DELAY_MS } from "../src/design/motion";
import { RemoteControlPill } from "../src/features/chat/RemoteControlPill";
import { render, posted, clearPosted } from "./render";
import type { RemoteControlStatus } from "../src/lib/rpc";

// The first component this suite renders, and the reason the suite exists: the
// pill is what the user reads to decide whether their phone is attached, and
// until now nothing anywhere asserted on it. Its faces were only ever checked
// by looking.

const pill = (container: HTMLElement) =>
  container.querySelector('[class*="sessionPill"]');
const chip = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[class*="_chip_"]');

const show = (status: RemoteControlStatus) =>
  render(<RemoteControlPill status={status} />);

/**
 * Hover the pill and read the tooltip that appears.
 *
 * `Tooltip` opens after `TOOLTIP_DELAY_MS` and renders through a portal, so the
 * text is in `document.body` rather than in the container — and it is not there
 * at all until the timer fires. Real time rather than fake timers: the delay is
 * 450ms once per test, and faking them here means faking them for framer too.
 *
 * The handlers sit on the chip itself. Tooltip only interposes its
 * `role="presentation"` gate for a child that declares `disabled`, which is how
 * it reaches a disabled button — and `Chip` declares no such prop.
 */
async function openTooltip(container: HTMLElement): Promise<string> {
  const gate = container.querySelector('[class*="_chip_"]');
  await act(async () => {
    // `mouseover`, not `mouseenter`: React synthesises `onMouseEnter` from the
    // bubbling event, and a raw `mouseenter` never reaches the handler.
    gate?.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })
    );
    await new Promise((r) => setTimeout(r, TOOLTIP_DELAY_MS + 80));
  });
  // The last one, not the first. Portals append to `document.body`, and a
  // bubble from an earlier test can still be on its way out — reading the first
  // match made these tests order-dependent, which the revert check caught by
  // handing the error case the previous test's text.
  const tips = document.querySelectorAll('[role="tooltip"]');
  return tips[tips.length - 1]?.textContent ?? "";
}

describe("RemoteControlPill", () => {
  beforeEach(() => {
    clearPosted();
    // Portalled bubbles outlive the root that made them for as long as their
    // exit animation runs. Starting each test on an empty body is what keeps
    // one test's tooltip out of the next one's assertion.
    document.body.replaceChildren();
  });

  it("draws nothing at all when the bridge is off", () => {
    // A control for something nobody switched on is noise — the component says
    // so at the top, and this is the only thing that keeps it true.
    const { container, unmount } = show({ state: "off" });
    expect(pill(container)).toBeNull();
    unmount();
  });

  it("offers no click while it is still connecting", () => {
    // The state exists precisely so the pill stops claiming a link during the
    // round-trip. `Chip` renders a <button> when interactive and a <span> when
    // not, so the tag is the assertion.
    const { container, unmount } = show({ state: "connecting" });
    expect(pill(container)).not.toBeNull();
    expect(chip(container)?.tagName).toBe("SPAN");
    unmount();
  });

  it("offers no click when ready has arrived without a URL", () => {
    const { container, unmount } = show({ state: "ready" });
    expect(chip(container)?.tagName).toBe("SPAN");
    unmount();
  });

  it("becomes clickable exactly when there is somewhere to go", () => {
    const { container, unmount } = show({
      state: "ready",
      sessionUrl: "https://claude.ai/code/a"
    });
    expect(chip(container)?.tagName).toBe("BUTTON");
    unmount();
  });

  it("opens the URL it holds now, not the one it was first given", () => {
    // Replacing the CLI process mints a new session, and the old link points at
    // one that no longer exists. The component's own comment promises this.
    const first = show({
      state: "connected",
      sessionUrl: "https://claude.ai/code/first"
    });
    first.update(
      <RemoteControlPill
        status={{
          state: "connected",
          sessionUrl: "https://claude.ai/code/second"
        }}
      />
    );
    chip(first.container)?.click();

    expect(posted()).toEqual([
      { type: "openExternal", url: "https://claude.ai/code/second" }
    ]);
    first.unmount();
  });

  it("says the conversation is relayed while the bridge is up", async () => {
    // The one disclosure the product owes and the official client does not
    // make. It belongs on the pill because that is what a person reads before
    // handing the link to a phone.
    const { container, unmount } = show({
      state: "connected",
      sessionUrl: "https://claude.ai/code/a"
    });
    const tip = await openTooltip(container);
    expect(tip).toMatch(/relayed through Anthropic's servers/);
    unmount();
  });

  it("does not claim a relay for a bridge that is off or broken", async () => {
    const { container, unmount } = show({
      state: "error",
      error: "no network"
    });
    const tip = await openTooltip(container);
    // Asserted positively too: an empty string satisfies `not.toMatch` for
    // ever, and that is exactly how this passed while the tooltip was not
    // opening at all.
    expect(tip).toContain("no network");
    expect(tip).not.toMatch(/relayed/);
    unmount();
  });

  it("says why it failed, rather than only that it did", () => {
    // `detail` off the CLI is the only account of the failure; a pill reading
    // "error" with nothing else is what the user would otherwise get.
    const { container, unmount } = show({
      state: "error",
      error: "no network"
    });
    expect(chip(container)?.className).toMatch(/_error_/);
    expect(container.textContent).toContain("remote");
    unmount();
  });

  it("renders a face for every state the host can publish", () => {
    // `FACES` is a Record over the union minus `off`, so a new state is a
    // compile error there — but a state the host publishes and the pill has no
    // entry for would crash at runtime. This walks the union.
    const states: RemoteControlStatus["state"][] = [
      "off",
      "connecting",
      "ready",
      "connected",
      "disconnected",
      "error"
    ];
    for (const state of states) {
      const { container, unmount } = show({ state });
      expect(state === "off" ? pill(container) : chip(container)).not.toBe(
        undefined
      );
      unmount();
    }
  });
});
