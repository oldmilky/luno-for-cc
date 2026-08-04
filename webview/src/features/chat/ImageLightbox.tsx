// ─────────────────────────────────────────────────────────────
// Image lightbox. Click outside or press Escape to dismiss.
//
// It used to say a full-viewport fixed overlay was enough without a portal.
// It is not: measured, an identical `position: fixed; inset: 0` under an
// ancestor carrying a transform collapses to 917x0 and leaves the screen. It
// goes through `Overlay` now, which portals.
//
// Shared by the composer's attachment chips and the image chips in
// user messages; the caller resolves the source (a data URL it
// already has, or one fetched over RPC) and passes `src`, `error`
// or neither for the loading state.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { Overlay } from "../../design/primitives";
import { Icon } from "../../design/icons";
import s from "./ImageLightbox.module.scss";

export interface ImageLightboxProps {
  open: boolean;
  name: string;
  /** Resolved image source; null while it is still being fetched. */
  src?: string | null;
  error?: string | null;
  width?: number;
  height?: number;
  onClose: () => void;
}

export function ImageLightbox({
  open,
  name,
  src,
  error,
  width = 0,
  height = 0,
  onClose
}: ImageLightboxProps) {
  // Held so the dismissal animates over the image rather than over an empty
  // frame: the caller clears its preview state the moment it closes. Compared
  // by VALUE, never by identity — a caller that builds this bundle inline would
  // otherwise set state on every render and never settle.
  const [shown, setShown] = useState({ name, src, error, width, height });
  if (
    open &&
    (shown.name !== name ||
      shown.src !== src ||
      shown.error !== error ||
      shown.width !== width ||
      shown.height !== height)
  ) {
    setShown({ name, src, error, width, height });
  }

  return (
    <Overlay
      open={open}
      onClose={onClose}
      label={`Preview of ${shown.name}`}
      className={s.panel}
      backdropClassName={s.backdrop}
    >
      <div className={s.bar}>
        <div className={s.meta}>
          <Icon name="file" size={13} />
          <span className={s.name}>{shown.name}</span>
          {shown.width > 0 && (
            <span className={s.dims}>
              {shown.width}×{shown.height}
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
      {shown.src ? (
        <img src={shown.src} alt={shown.name} className={s.image} />
      ) : shown.error ? (
        <div className={`${s.status} ${s.error}`}>
          Could not load image: {shown.error}
        </div>
      ) : (
        <div className={s.status}>Loading…</div>
      )}
    </Overlay>
  );
}
