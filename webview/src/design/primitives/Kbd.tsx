import { ReactNode } from "react";
import s from "./Kbd.module.scss";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}
