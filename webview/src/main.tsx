// ─────────────────────────────────────────────────────────────
// Webview entry. The same compiled bundle is loaded into both
// the chat sidebar (WebviewView) and the plan artifact editor
// tab (WebviewPanel). The extension host writes
// `window.LUNO_MODE` into the panel's HTML at creation
// time so we can mount the right shell here without bouncing a
// "what mode am I in?" RPC round-trip first.
// ─────────────────────────────────────────────────────────────

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { App } from "./App";
import { ArtifactApp } from "./ArtifactApp";
import { ErrorBoundary } from "./ErrorBoundary";
import { initTheme } from "./lib/theme";
import "./themes/index.scss";
import "./theme.css";

declare global {
  interface Window {
    LUNO_MODE?: "chat" | "artifact";
    LUNO_REVISION_ID?: string;
  }
}

const mode = window.LUNO_MODE ?? "chat";

// Stamp the stored palette before the first render so the panel never
// flashes the default theme on reload.
initTheme();

const root = createRoot(document.getElementById("root")!);

// `reducedMotion="user"` reads the OS setting and strips transform, layout and
// scale animations app-wide while keeping opacity — so a dismissal still reads
// as a dismissal, it just stops moving. The CSS side has always honoured
// `prefers-reduced-motion`; framer did not, which meant the setting silently
// turned off half the app's motion and left the other half running. One place,
// because both shells mount through this entry.
//
// The boundary wraps everything: a throw anywhere under here would otherwise
// unmount the tree and leave a webview with nothing in it — indistinguishable,
// from the outside, from a dead extension host.
root.render(
  <StrictMode>
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        {mode === "artifact" && window.LUNO_REVISION_ID ? (
          <ArtifactApp revisionId={window.LUNO_REVISION_ID} />
        ) : (
          <App />
        )}
      </MotionConfig>
    </ErrorBoundary>
  </StrictMode>
);
