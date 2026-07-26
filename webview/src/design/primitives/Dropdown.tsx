import { ReactNode, useRef, useState } from "react";
import { POPOVER, POPOVER_ABOVE } from "../motion";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, IconName } from "../icons";
import { useOutsideClose } from "./useOutsideClose";
import s from "./Dropdown.module.scss";

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  note?: string;
  icon?: IconName;
  danger?: boolean;
}

export interface DropdownProps<T extends string = string> {
  options: ReadonlyArray<DropdownOption<T>>;
  value: T;
  onSelect: (v: T) => void;
  align?: "left" | "center" | "right";
  /** What renders inside the trigger (the chip/button content). */
  trigger: (state: {
    open: boolean;
    option: DropdownOption<T> | undefined;
  }) => ReactNode;
  triggerClassName?: string;
  /** Position the menu above the trigger instead of below. */
  placement?: "below" | "above";
  ariaLabel?: string;
}

export function Dropdown<T extends string = string>({
  options,
  value,
  onSelect,
  align = "center",
  trigger,
  triggerClassName = "",
  placement = "below",
  ariaLabel
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));

  const current = options.find((o) => o.value === value);

  return (
    <div className={s.picker} ref={ref}>
      <button
        type="button"
        className={triggerClassName}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {trigger({ open, option: current })}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="listbox"
            className={`${s.menu} ${s[align]} ${s[placement]}`}
            {...(placement === "above" ? POPOVER_ABOVE : POPOVER)}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                className={[
                  s.item,
                  opt.value === value ? s.active : "",
                  opt.danger ? s.danger : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  onSelect(opt.value);
                  setOpen(false);
                }}
              >
                {opt.icon && (
                  <span className={s.icon}>
                    <Icon name={opt.icon} size={13} />
                  </span>
                )}
                <span className={s.main}>{opt.label}</span>
                {opt.note && <span className={s.note}>{opt.note}</span>}
                {opt.value === value && (
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
