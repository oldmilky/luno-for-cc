// Runs before every component test module.
//
// `lib/rpc.ts` calls `acquireVsCodeApi()` at import time — a global the editor
// injects and jsdom has never heard of — so the stub has to exist before the
// first import, which is what a setup file is for. Everything a component sends
// lands in `posted`, so a test can assert on the wire instead of on a spy it
// had to thread through props.

const posted: unknown[] = [];

Object.assign(globalThis, {
  // Without this `act` does not actually flush — React says so on stderr and
  // then carries on, so effects settle whenever they like and a test that
  // depends on one passes or fails by timing.
  IS_REACT_ACT_ENVIRONMENT: true,
  acquireVsCodeApi: () => ({
    postMessage: (msg: unknown) => posted.push(msg),
    getState: () => undefined,
    setState: () => {}
  }),
  __lunoPosted: posted
});

// framer honours `prefers-reduced-motion` through this, and jsdom ships no
// implementation at all. Answering "no preference" keeps components on the
// animated path — the one the product actually renders.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}

for (const name of ["ResizeObserver", "IntersectionObserver"] as const) {
  if (!(name in globalThis)) {
    Object.assign(globalThis, {
      [name]: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    });
  }
}
