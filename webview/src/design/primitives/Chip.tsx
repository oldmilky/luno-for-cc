import {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
  forwardRef
} from "react";
import { AMBIENT } from "../../design/motion";
import { motion } from "framer-motion";
import s from "./Chip.module.scss";

export type ChipTone =
  "default" | "accent" | "success" | "warn" | "error" | "info" | "danger";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ChipTone;
  active?: boolean;
  interactive?: boolean;
  pulse?: boolean;
  children: ReactNode;
}

// `default` needs no modifier — the base class already carries it.
const TONES: Record<ChipTone, string> = {
  default: "",
  accent: s.accent,
  success: s.success,
  warn: s.warn,
  error: s.error,
  info: s.info,
  danger: s.danger
};

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  {
    tone = "default",
    active,
    interactive,
    pulse,
    children,
    className = "",
    ...rest
  },
  ref
) {
  const cls = [
    s.chip,
    TONES[tone],
    active ? s.active : "",
    interactive ? s.interactive : "",
    className
  ]
    .filter(Boolean)
    .join(" ");

  const content = pulse ? (
    <motion.span
      animate={{ opacity: [0.7, 1, 0.7] }}
      transition={AMBIENT}
      className={s.pulseInner}
    >
      {children}
    </motion.span>
  ) : (
    children
  );

  if (!interactive) {
    // `rest` is forwarded here too. It used to be dropped, and dropping it was
    // silent: four chips across the header and the plan card passed a `title`
    // that simply never reached the DOM, so they had explanatory tooltips that
    // had never once appeared. Anything that hands a chip event handlers — a
    // Tooltip wrapping it, for instance — had the same fate.
    return (
      <span
        ref={ref as never}
        className={cls}
        {...(rest as HTMLAttributes<HTMLSpanElement>)}
      >
        {content}
      </span>
    );
  }

  return (
    <button ref={ref} type="button" className={cls} {...rest}>
      {content}
    </button>
  );
});
