// ─────────────────────────────────────────────────────────────
// Banner — shown after 3 turns in a workspace with no conventions
// file detected. Three actions: Generate (opens command), Not now
// (hides for this session), or Don't ask again (workspace-scoped).
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import { ENTER_CARD } from "../../design/motion";
import { send } from "../../lib/rpc";
import bits from "./ChatBits.module.scss";

interface ConventionsBannerProps {
  onHideForSession: () => void;
}

export function ConventionsBanner({
  onHideForSession
}: ConventionsBannerProps) {
  return (
    <motion.div {...ENTER_CARD} className={bits.banner} role="status">
      <div className={bits.bannerBody}>
        <strong>Luno works better with project conventions.</strong>
        <span>
          {" "}
          Generate a CLAUDE.md so the model knows your project's structure,
          style, and canonical examples.
        </span>
      </div>
      <div className={bits.bannerActions}>
        <button
          type="button"
          className={bits.bannerPrimary}
          onClick={() => {
            send({ type: "generateConventions" });
            onHideForSession();
          }}
        >
          Generate
        </button>
        <button
          type="button"
          className={bits.bannerGhost}
          onClick={onHideForSession}
        >
          Not now
        </button>
        <button
          type="button"
          className={bits.bannerGhost}
          onClick={() => {
            send({ type: "dismissConventionsBanner" });
            onHideForSession();
          }}
        >
          Don't ask for this workspace
        </button>
      </div>
    </motion.div>
  );
}
