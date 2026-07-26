// ─────────────────────────────────────────────────────────────
// Theme picker — the panel's palette switcher.
//
// Reference component for the SCSS-module pattern: styling lives in
// ThemePicker.module.scss and reads design tokens only, so a new
// palette needs no change here beyond its entry in lib/theme.ts.
// ─────────────────────────────────────────────────────────────

import { useRef, useState, useSyncExternalStore } from "react";
import { POPOVER } from "../../design/motion";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { Tooltip, useOutsideClose } from "../../design/primitives";
import {
  THEMES,
  ThemeId,
  getTheme,
  setTheme,
  subscribeTheme
} from "../../lib/theme";
import s from "./ThemePicker.module.scss";

export function useActiveTheme(): ThemeId {
  return useSyncExternalStore(subscribeTheme, getTheme);
}

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = useActiveTheme();
  useOutsideClose(ref, open, () => setOpen(false));

  return (
    <div className={s.root} ref={ref}>
      <Tooltip label="Theme">
        <button
          type="button"
          className={s.trigger}
          onClick={() => setOpen((o) => !o)}
          aria-label="Theme"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <Icon name="palette" size={15} />
        </button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <motion.div className={s.menu} role="listbox" aria-label="Theme" {...POPOVER}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={t.id === active}
              className={s.item}
              onClick={() => {
                setTheme(t.id);
                setOpen(false);
              }}
            >
              {/* Carries the palette it previews — the swatch styles read
                  that palette's own tokens rather than copied values. */}
              <span className={s.swatch} data-theme={t.id} aria-hidden />
              <span className={s.text}>
                <span className={s.label}>{t.label}</span>
                <span className={s.note}>{t.note}</span>
              </span>
              {t.id === active && (
                <span className={s.check}>
                  <Icon name="check" size={12} />
                </span>
              )}
            </button>
          ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
