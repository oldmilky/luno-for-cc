// ─────────────────────────────────────────────────────────────
// Markdown renderer — react-markdown + remark-gfm for correct,
// spec-compliant parsing (GitHub-flavored: tables, task lists,
// strikethrough, autolinks, nested lists, footnotes) and
// highlight.js for real syntax highlighting in fenced code blocks.
//
// Every element is mapped onto the existing `md-*` theme classes so
// the copper visual system stays consistent — this just makes the
// parsing correct and the code blocks beautiful. The output is a
// single <Markdown> element that drops straight into the caller's
// `.md` container (AssistantMessage, narrative blocks, thoughts, …).
// ─────────────────────────────────────────────────────────────

import { ReactNode, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import { Icon } from "../../design/icons";

interface RenderOptions {
  /**
   * Keep the source heading levels (`#` → h1, `##` → h2, …) instead of
   * collapsing them toward h3. Chat bubbles collapse so a stray top-level
   * `#` can't dominate the stream; documents (e.g. the plan body) want the
   * real hierarchy so sections read as sections. Off by default.
   */
  preserveHeadings?: boolean;
}

export function renderMarkdown(src: string, opts?: RenderOptions): ReactNode {
  const components = opts?.preserveHeadings ? DOC_COMPONENTS : COMPONENTS;
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
      {src}
    </Markdown>
  );
}

// ── Code block (syntax-highlighted) ──────────────────────────
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const { html, label } = useMemo(() => {
    const normalized = lang.toLowerCase();
    if (normalized && hljs.getLanguage(normalized)) {
      try {
        return {
          html: hljs.highlight(code, {
            language: normalized,
            ignoreIllegals: true
          }).value,
          label: normalized
        };
      } catch {
        /* fall through to auto-detect */
      }
    }
    try {
      const auto = hljs.highlightAuto(code);
      return { html: auto.value, label: normalized || auto.language || "text" };
    } catch {
      return { html: escapeHtml(code), label: normalized || "text" };
    }
  }, [code, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="md-code-wrap">
      <div className="md-code-bar">
        <span className="md-code-lang">{label}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          <Icon name={copied ? "check" : "copy"} size={11} />
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="md-code hljs">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

// ── Component map ─────────────────────────────────────────────
// Headings collapse toward h3 so a top-level `#` doesn't blow up the
// chat — matches the previous renderer's hierarchy. Structural nodes
// carry their `md-*` classes explicitly; strong/em/blockquote/hr/del
// inherit from the `.md` container's element styles.
const COMPONENTS: Components = {
  h1: (p) => <h3 className="md-h" {...rest(p)} />,
  h2: (p) => <h4 className="md-h" {...rest(p)} />,
  h3: (p) => <h5 className="md-h" {...rest(p)} />,
  h4: (p) => <h6 className="md-h" {...rest(p)} />,
  h5: (p) => <h6 className="md-h" {...rest(p)} />,
  h6: (p) => <h6 className="md-h" {...rest(p)} />,
  p: (p) => <p className="md-p" {...rest(p)} />,
  ul: (p) => <ul className="md-ul" {...rest(p)} />,
  ol: (p) => <ol className="md-ol" {...rest(p)} />,
  a: ({ children, href, ...p }) => (
    <a href={href} target="_blank" rel="noreferrer" {...rest(p)}>
      {children}
    </a>
  ),
  // react-markdown renders fenced blocks as <pre><code>. We strip the
  // <pre> wrapper (CodeBlock provides its own) and build the highlighted
  // block from the <code> node below.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...p }) => {
    const match = /language-(\w+)/.exec(className || "");
    const raw = nodeToText(children);
    if (match || raw.includes("\n")) {
      return (
        <CodeBlock lang={match?.[1] ?? ""} code={raw.replace(/\n$/, "")} />
      );
    }
    return (
      <code className="md-ic" {...rest(p)}>
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table className="md-table">{children}</table>
    </div>
  )
};

// Document variant — preserves the source heading hierarchy (`#` → h1,
// `##` → h2, `###` → h3) so callers like the plan body can style sections
// distinctly. Inherits every non-heading mapping from COMPONENTS.
const DOC_COMPONENTS: Components = {
  ...COMPONENTS,
  h1: (p) => <h1 className="md-h" {...rest(p)} />,
  h2: (p) => <h2 className="md-h" {...rest(p)} />,
  h3: (p) => <h3 className="md-h" {...rest(p)} />,
  h4: (p) => <h4 className="md-h" {...rest(p)} />,
  h5: (p) => <h5 className="md-h" {...rest(p)} />,
  h6: (p) => <h6 className="md-h" {...rest(p)} />
};

// Strip react-markdown's internal `node` prop before spreading onto DOM
// elements (React warns about unknown `node` attributes otherwise).
function rest<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const { node: _node, ...r } = props;
  return r;
}

function nodeToText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeToText(
      (node as { props?: { children?: ReactNode } }).props?.children
    );
  }
  return "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
