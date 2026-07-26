// ─────────────────────────────────────────────────────────────
// Image lightbox. Click outside or press Escape to dismiss.
// Renders in place (no portal) — a full-viewport fixed overlay is
// enough, and it keeps the dialog inside the tree that owns it.
//
// Shared by the composer's attachment chips and the image chips in
// user messages; the caller resolves the source (a data URL it
// already has, or one fetched over RPC) and passes `src`, `error`
// or neither for the loading state.
// ─────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { motion } from "framer-motion";
import { BACKDROP, OVERLAY_PANEL } from "../../design/motion";
import { Icon } from "../../design/icons";
import s from "./ImageLightbox.module.scss";

export interface ImageLightboxProps {
  name: string;
  /** Resolved image source; null while it is still being fetched. */
  src?: string | null;
  error?: string | null;
  width?: number;
  height?: number;
  onClose: () => void;
}

export function ImageLightbox({
  name,
  src,
  error,
  width = 0,
  height = 0,
  onClose
}: ImageLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${name}`}
      onClick={onClose}
      className={s.backdrop}
      {...BACKDROP}
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        className={s.panel}
        {...OVERLAY_PANEL}
      >
        <div className={s.bar}>
          <div className={s.meta}>
            <Icon name="file" size={13} />
            <span className={s.name}>{name}</span>
            {width > 0 && (
              <span className={s.dims}>
                {width}×{height}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className={s.close}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
        {src ? (
          <img src={src} alt={name} className={s.image} />
        ) : error ? (
          <div className={`${s.status} ${s.error}`}>
            Could not load image: {error}
          </div>
        ) : (
          <div className={s.status}>Loading…</div>
        )}
      </motion.div>
    </motion.div>
  );
}
