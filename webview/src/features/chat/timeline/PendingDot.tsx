// ─────────────────────────────────────────────────────────────
// The mark a composer control wears while its value is not in force.
//
// Effort, the posture prompt and the disabled-skill list reach the CLI only
// through argv, and argv is fixed at spawn — applying one means replacing the
// process, which kills every background agent in it. So while a conversation
// has agents running the change is held, and the control that would otherwise
// be lying about the session says so instead.
// ─────────────────────────────────────────────────────────────

import { Tooltip } from "../../../design/primitives";
import s from "./PendingDot.module.scss";

export function PendingDot() {
  return (
    <Tooltip label="Applies when the running agents finish">
      <span className={s.dot} aria-label="Pending — applies after the run" />
    </Tooltip>
  );
}
