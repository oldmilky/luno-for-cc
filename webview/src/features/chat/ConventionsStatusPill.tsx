// ─────────────────────────────────────────────────────────────
// Status pill — visible in the header when a project conventions
// file (CLAUDE.md / AGENTS.md / etc.) is loaded for the workspace.
// Click opens the file in the editor.
// ─────────────────────────────────────────────────────────────

import { Tooltip } from "../../design/primitives";
import { send, ConventionsSource } from "../../lib/rpc";
import bits from "./ChatBits.module.scss";

interface ConventionsStatusPillProps {
  source: ConventionsSource | null;
  path: string | null;
  relativePath: string | null;
}

const LABEL: Record<ConventionsSource, string> = {
  "claude-root": "CLAUDE.md",
  "claude-dotfolder": ".claude/CLAUDE.md",
  agents: "AGENTS.md",
  copilot: "copilot-instructions.md",
  cursor: ".cursorrules",
  cline: ".clinerules"
};

export function ConventionsStatusPill({
  source,
  path,
  relativePath
}: ConventionsStatusPillProps) {
  if (!source || !path) return null;
  const label = LABEL[source];
  const handle = (): void => {
    send({ type: "openConventionsFile", path });
  };
  return (
    <Tooltip
      label={`Project conventions loaded from ${relativePath ?? path}. Click to open.`}
    >
      <button type="button" className={bits.statusPill} onClick={handle}>
        <span aria-hidden>📄</span>
        {label}
      </button>
    </Tooltip>
  );
}
