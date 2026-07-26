import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { ENTER_CARD } from "../../design/motion";
import bits from "./ChatBits.module.scss";

interface ErrorBannerProps {
  text: string;
  onDismiss: () => void;
}

export function ErrorBanner({ text, onDismiss }: ErrorBannerProps) {
  const isRateLimit = /429|rate.?limit/i.test(text);
  const isAuth = /401|403|auth rejected|login/i.test(text);
  const title = isRateLimit
    ? "Rate limited"
    : isAuth
      ? "Authentication failed"
      : "Error";
  const icon = isRateLimit ? "clock" : isAuth ? "lock" : "danger";

  return (
    <motion.div {...ENTER_CARD} className={bits.error} role="alert">
      <div className={bits.errorHead}>
        <span className={bits.errorGlyph} aria-hidden>
          <Icon name={icon} size={13} />
        </span>
        <span className={bits.errorTitle}>{title}</span>
        <button
          type="button"
          className={bits.errorClose}
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <div className={bits.errorBody}>{text}</div>
      {isAuth && (
        <div className={bits.errorHint}>
          Re-authenticate in a terminal: <code>claude login</code>
        </div>
      )}
    </motion.div>
  );
}
