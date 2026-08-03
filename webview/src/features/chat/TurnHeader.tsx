// ─────────────────────────────────────────────────────────────
// TurnHeader — small "Worked for Xm Ys" banner shown above each
// assistant turn. Antigravity-style. Click to collapse the entire
// turn body.
// ─────────────────────────────────────────────────────────────

import { Icon } from "../../design/icons";
import { formatDuration } from "../../lib/format";
import s from "./Turn.module.scss";

interface TurnHeaderProps {
  workedMs?: number;
  collapsed: boolean;
  onToggle: () => void;
}

export function TurnHeader({ workedMs, collapsed, onToggle }: TurnHeaderProps) {
  const live = workedMs === undefined;
  const label = live ? "Working…" : `Worked for ${formatDuration(workedMs!)}`;
  return (
    <button type="button" className={s.turnHeader} onClick={onToggle}>
      {live && <span className={s.liveDot} aria-hidden />}
      <span>{label}</span>
      <span className={s.chev}>
        <Icon name={collapsed ? "chevronR" : "chevronD"} size={10} />
      </span>
    </button>
  );
}
