import { ButtonHTMLAttributes, forwardRef } from "react";
import { Icon, IconName } from "../icons";
import { Tooltip } from "./Tooltip";
import s from "./IconButton.module.scss";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  icon: IconName;
  title: string;
  size?: number;
  iconSize?: number;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, title, size = 28, iconSize, active, className = "", ...rest },
  ref
) {
  const cls = [s.button, active ? s.active : "", className]
    .filter(Boolean)
    .join(" ");
  // An icon button has no visible label by definition, so it is the one
  // control that is never self-explanatory — every one of them gets the
  // tooltip, and the `title` prop that used to feed the OS box now feeds ours.
  // `aria-label` stays: the tooltip describes, it does not name.
  return (
    <Tooltip label={title}>
      <button
        ref={ref}
        type="button"
        aria-label={title}
        className={cls}
        style={{ width: size, height: size }}
        {...rest}
      >
        <Icon name={icon} size={iconSize ?? Math.round(size * 0.5)} />
      </button>
    </Tooltip>
  );
});
