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

import { ReactNode, memo, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import { Icon } from "../../../design/icons";
import { send } from "../../../lib/rpc";
import { resolveMarkdownHref } from "./markdown-links";

// Hoisted so react-markdown sees one stable plugin list and keeps its
// processor instead of rebuilding it per render.
const REMARK_PLUGINS = [remarkGfm];

interface MarkdownBodyProps {
  text: string;
  /**
   * Keep the source heading levels (`#` → h1, `##` → h2, …) instead of
   * collapsing them toward h3. Chat bubbles collapse so a stray top-level
   * `#` can't dominate the stream; documents (e.g. the plan body) want the
   * real hierarchy so sections read as sections. Off by default.
   */
  preserveHeadings?: boolean;
}

/**
 * Every piece of rendered markdown in the app. Memoised on purpose, and it has
 * to stay that way: react-markdown parses in its render body, so an unmemoised
 * call re-parses the message on every parent render — and the parent re-renders
 * on every streamed token. Measured at 40 messages / ~27 kB of transcript, that
 * was 26 ms of work per token against 8 ms for the same burst on an empty chat.
 */
export const MarkdownBody = memo(function MarkdownBody({
  text,
  preserveHeadings
}: MarkdownBodyProps) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      components={preserveHeadings ? DOC_COMPONENTS : COMPONENTS}
      skipHtml
    >
      {text}
    </Markdown>
  );
});

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
          {copied ? "Copied" : "Copy"}
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
  h1: (p) => <h3 {...tagged(p, "md-h")} />,
  h2: (p) => <h4 {...tagged(p, "md-h")} />,
  h3: (p) => <h5 {...tagged(p, "md-h")} />,
  h4: (p) => <h6 {...tagged(p, "md-h")} />,
  h5: (p) => <h6 {...tagged(p, "md-h")} />,
  h6: (p) => <h6 {...tagged(p, "md-h")} />,
  p: (p) => <p {...tagged(p, "md-p")} />,
  ul: (p) => <ul {...tagged(p, "md-ul")} />,
  ol: (p) => <ol {...tagged(p, "md-ol")} />,
  a: ({ children, href, ...p }) => (
    <MarkdownLink href={href} {...rest(p)}>
      {children}
    </MarkdownLink>
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
  h1: (p) => <h1 {...tagged(p, "md-h")} />,
  h2: (p) => <h2 {...tagged(p, "md-h")} />,
  h3: (p) => <h3 {...tagged(p, "md-h")} />,
  h4: (p) => <h4 {...tagged(p, "md-h")} />,
  h5: (p) => <h5 {...tagged(p, "md-h")} />,
  h6: (p) => <h6 {...tagged(p, "md-h")} />
};

/**
 * Props for a mapped element, with our theme class merged into whatever the
 * pipeline already put there. Merged rather than assigned because remark-gfm
 * classes its own nodes — `contains-task-list` on a checklist's `<ul>` — and a
 * spread that lands after `className=` silently drops the `md-*` class, which
 * costs the element every rule in theme.css and stays green in the build.
 */
function tagged<T extends { node?: unknown; className?: string }>(
  props: T,
  themeClass: string
) {
  const { className, ...r } = rest(props);
  return {
    ...r,
    className: className ? `${themeClass} ${className}` : themeClass
  };
}

/**
 * A link the host has to follow on our behalf.
 *
 * `target="_blank"` is inert inside a webview — the click lands, the browser
 * never opens, and nothing says so. A path into the workspace is worth more
 * than an outbound URL here: it opens the file at the line, in the
 * conversation's own worktree.
 */
function MarkdownLink({
  href,
  children,
  ...p
}: {
  href?: string;
  children: ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const target = resolveMarkdownHref(href);
  if (target.kind === "inert") {
    return (
      <a href={href} {...p}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      {...p}
      onClick={(e) => {
        e.preventDefault();
        if (target.kind === "external") {
          send({ type: "openExternal", url: target.url });
          return;
        }
        send({
          type: "openFile",
          path: target.path,
          startLine: target.startLine,
          endLine: target.endLine
        });
      }}
    >
      {children}
    </a>
  );
}

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
