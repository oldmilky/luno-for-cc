import { describe, it, expect } from "vitest";
import { render } from "./render";
import { DictationStrip } from "../src/features/chat/DictationStrip";

describe("the dictation strip", () => {
  it("says it is listening before a word comes back", () => {
    const { container } = render(
      <DictationStrip listening committed="" interim="" level={0} />
    );
    expect(container.textContent).toContain("Listening");
  });

  it("shows the committed sentence and the tail that is still arriving", () => {
    const { container } = render(
      <DictationStrip
        listening
        committed="a permission gate"
        interim="and a work"
        level={0.5}
      />
    );
    expect(container.textContent).toBe("a permission gate and a work");
  });

  it("keeps the uncertain tail in its own element, so it can be dimmed", () => {
    // The two halves are one sentence at two levels of certainty. A single
    // text node would have to be styled as one.
    const { container } = render(
      <DictationStrip listening committed="said" interim="saying" level={0.5} />
    );
    const nested = container.querySelector("span > span");
    expect(nested?.textContent).toBe("saying");
  });

  it("replaces the whole strip with the reason when there is one", () => {
    // An error beside a live meter would say "still listening" and "it
    // failed" at the same time.
    const { container } = render(
      <DictationStrip
        listening={false}
        committed="ignored"
        interim=""
        error="No microphone backend was found."
        level={0}
      />
    );
    expect(container.textContent).toContain("No microphone backend");
    expect(container.textContent).not.toContain("ignored");
  });

  it("announces itself to a screen reader without stealing focus", () => {
    const { container } = render(
      <DictationStrip listening committed="" interim="" level={0} />
    );
    const strip = container.querySelector('[role="status"]');
    expect(strip?.getAttribute("aria-live")).toBe("polite");
  });

  it("draws a bar per level and hides them from the reading order", () => {
    const { container } = render(
      <DictationStrip listening committed="" interim="" level={0.8} />
    );
    const meter = container.querySelector('[aria-hidden="true"]');
    expect(meter?.children).toHaveLength(5);
  });
});
