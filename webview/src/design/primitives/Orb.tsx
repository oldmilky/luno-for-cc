// ─────────────────────────────────────────────────────────────
// Animated brand orb — conic-gradient ring + counter-rotating
// inner glow. Used in the empty state and the auth hero.
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import s from "./Orb.module.scss";

export interface OrbProps {
  size?: number;
  /** Adds an outer halo glow behind the orb. */
  halo?: boolean;
}

export function Orb({ size = 72, halo = true }: OrbProps) {
  return (
    <div className={s.orb} style={{ width: size, height: size }}>
      {halo && <div className={s.halo} aria-hidden />}
      <motion.div
        className={s.ring}
        animate={{ rotate: 360 }}
        transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
      />
      <div className={s.core} />
      <motion.div
        className={s.inner}
        animate={{ rotate: -360 }}
        transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
      />
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <motion.span
      className={s.spinner}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
      animate={{ rotate: 360 }}
      transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}
    >
      <span className={s.spinnerCore} aria-hidden />
    </motion.span>
  );
}
