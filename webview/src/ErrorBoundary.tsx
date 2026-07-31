// ─────────────────────────────────────────────────────────────
// The last thing standing between a render throw and a blank panel.
//
// A webview has no crash screen of its own: React unmounts the tree
// and what is left is the background colour. From the outside that
// is indistinguishable from a dead extension host, a failed load, or
// a bug in the panel — which is exactly the hour that gets lost to
// it. So: catch, and say what happened, with the stack on screen and
// in the console where the devtools can be pointed at it.
//
// Deliberately dependency-free — no tokens module, no motion, no
// icons. Whatever broke may well be one of those.
// ─────────────────────────────────────────────────────────────

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged as well as rendered: the rendered copy is what the user can
    // read back, the console copy is what survives a second failure.
    console.error("[luno] webview crashed:", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  private reload = () => window.location.reload();

  private copy = () => {
    const { error, componentStack } = this.state;
    void navigator.clipboard?.writeText(
      `${error?.name}: ${error?.message}\n\n${error?.stack ?? ""}\n\n${componentStack}`
    );
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          padding: "16px",
          height: "100%",
          overflow: "auto",
          color: "var(--t1, #e6e6e6)",
          background: "var(--s0, #111)",
          fontFamily: "var(--font-sans, system-ui, sans-serif)",
          fontSize: "12.5px",
          lineHeight: 1.5
        }}
      >
        <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>
          The panel hit an error and stopped drawing
        </div>
        <div style={{ color: "var(--t3, #999)", marginBottom: "12px" }}>
          The conversation itself is safe — it lives in the extension, not here.
          Reloading redraws it.
        </div>

        <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
          <button type="button" onClick={this.reload} style={BUTTON}>
            Reload panel
          </button>
          <button type="button" onClick={this.copy} style={BUTTON}>
            Copy details
          </button>
        </div>

        <pre
          style={{
            margin: 0,
            padding: "10px",
            borderRadius: "6px",
            background: "var(--s1, #1a1a1a)",
            color: "var(--t2, #ccc)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: "11.5px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word"
          }}
        >
          {error.name}: {error.message}
          {error.stack ? `\n\n${error.stack}` : ""}
          {componentStack ? `\n\nComponent stack:${componentStack}` : ""}
        </pre>
      </div>
    );
  }
}

const BUTTON: React.CSSProperties = {
  padding: "5px 10px",
  border: "1px solid var(--b2, #333)",
  borderRadius: "6px",
  background: "var(--s2, #222)",
  color: "var(--t1, #e6e6e6)",
  fontFamily: "inherit",
  fontSize: "12px",
  cursor: "pointer"
};
