// A render helper, rather than a testing-library dependency.
//
// React 19 exports `act` itself, and `createRoot` is three lines away — the
// whole of what these tests need is "put this on a page, then read the page".
// One less package in a project that counts its bytes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";

interface Mounted {
  container: HTMLElement;
  /** Re-render with different props, inside `act` so effects settle. */
  update(next: ReactElement): void;
  unmount(): void;
}

export function render(element: ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(element);
  });
  return {
    container,
    update(next) {
      act(() => root.render(next));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    }
  };
}

/** Everything the component sent to the host, in order. */
export function posted(): { type?: string; [k: string]: unknown }[] {
  return (globalThis as { __lunoPosted?: unknown[] }).__lunoPosted as {
    type?: string;
    [k: string]: unknown;
  }[];
}

export function clearPosted(): void {
  posted().length = 0;
}
