// ─────────────────────────────────────────────────────────────
// Effort picker — its own toolbar chip, left of the model one.
//
// It used to be a segmented ramp inside the model panel, which cost
// that panel the room to show its own list and could not express
// ultracode: that runs at X-high, one step *below* Max, so a sixth
// cell at the end of the ramp claimed something untrue. A list of
// rows says it plainly — one more row, with its own note.
//
// Thinking rides along at the foot. It is the same question the
// panel already answers: how hard should this turn work.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { POPOVER_ABOVE } from "../../design/motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { onMessage } from "../../lib/rpc";
import type { EffortLevel, ModelInfo } from "../../lib/rpc";
import { EFFORT_LEVELS, ULTRACODE_OPTION, findEffort } from "./constants";
import d from "../../design/primitives/Dropdown.module.scss";
import { PendingDot } from "./PendingDot";
import s from "./EffortPicker.module.scss";

interface EffortPickerProps {
  /** The pinned model and the catalogue, only to answer one question: which
   *  levels does it accept. We push `--effort` on every spawn, so offering one
   *  the model never had is a CLI error the user cannot read. */
  model: string;
  models: ReadonlyArray<ModelInfo>;
  effort: EffortLevel;
  /** The value is chosen but not in force — see PendingDot. */
  pending?: boolean;
  ultracode: boolean;
  /** Both halves of one choice — see the `setEffort` message. */
  onEffort: (level: EffortLevel, ultracode: boolean) => void;
  thinking: boolean;
  onThinking: (on: boolean) => void;
}

export function EffortPicker({
  model,
  models,
  effort,
  pending = false,
  ultracode,
  onEffort,
  thinking,
  onThinking
}: EffortPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // Listened for, never requested: the model picker is what asks for this list
  // (and pays for the probe sweep). We only want it if it happens to be here,
  // because a pinned version is where the ladders actually differ.
  const [legacy, setLegacy] = useState<ReadonlyArray<ModelInfo>>([]);
  useEffect(
    () =>
      onMessage((m) => {
        if (m.type === "legacyModels") setLegacy(m.models);
      }),
    []
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = useMemo(() => findEffort(effort), [effort]);
  const ladder = useMemo(() => {
    const found =
      models.find((m) => m.value === model) ??
      legacy.find((m) => m.value === model);
    // Unknown model, or an alias: aliases always resolve to something current,
    // so every level stands until a pinned version says otherwise.
    return found?.effort ?? EFFORT_LEVELS.map((e) => e.value);
  }, [model, models, legacy]);
  const rejected = ladder.length === 0;
  const ultracodeAllowed = ladder.includes(ULTRACODE_OPTION.effort);
  const triggerLabel = ultracode ? ULTRACODE_OPTION.label : active.short;

  const choose = (level: EffortLevel, ultra: boolean) => {
    onEffort(level, ultra);
    setOpen(false);
  };

  return (
    <div className={d.picker} ref={ref}>
      <Tooltip
        label={`Effort: ${
          ultracode ? ULTRACODE_OPTION.label : active.label
        } · Thinking: ${thinking ? "on" : "off"}`}
      >
        <button
          type="button"
          className={`${s.trigger}${ultracode ? ` ${s.triggerUltra}` : ""}`}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Reasoning effort"
        >
          <Icon name={ultracode ? "bolt" : "zap"} size={9} />
          <span className={s.triggerName}>{triggerLabel}</span>
          {pending && <PendingDot />}
          <Icon name="chevronD" size={9} />
        </button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <motion.div
            className={`${d.menu} ${d.right} ${d.above} ${s.menu}`}
            {...POPOVER_ABOVE}
            role="listbox"
          >
            <div className={s.head}>
              <span className={s.title}>How hard to work</span>
              <span className={s.sub}>
                {rejected
                  ? "This model does not take an effort level."
                  : "Higher levels think longer and spend more of the quota."}
              </span>
            </div>

            <div className={s.scroll}>
              <div className={s.list}>
                {EFFORT_LEVELS.map((opt) => {
                  const allowed = ladder.includes(opt.value);
                  const selected = !ultracode && opt.value === active.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={!allowed}
                      className={`${s.row}${selected ? ` ${s.selected}` : ""}${
                        allowed ? "" : ` ${s.off}`
                      }`}
                      onClick={() => choose(opt.value, false)}
                    >
                      <span className={s.rowBody}>
                        <span className={s.rowHead}>
                          <span className={s.rowLabel}>{opt.label}</span>
                        </span>
                        <span className={s.rowNote}>{opt.note}</span>
                      </span>
                      {selected && (
                        <Icon name="check" size={13} className={s.rowCheck} />
                      )}
                    </button>
                  );
                })}

                <div className={s.divider} aria-hidden />

                <Tooltip
                  label={
                    ultracodeAllowed
                      ? "Runs every substantive task through a multi-agent workflow"
                      : "This model has no X-high, which ultracode needs"
                  }
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={ultracode}
                    disabled={!ultracodeAllowed}
                    className={`${s.row}${ultracode ? ` ${s.selected}` : ""}${
                      ultracodeAllowed ? "" : ` ${s.off}`
                    }`}
                    onClick={() => choose(ULTRACODE_OPTION.effort, true)}
                  >
                    <span className={s.rowBody}>
                      <span className={s.rowHead}>
                        <Icon name="bolt" size={11} />
                        <span className={s.rowLabel}>
                          {ULTRACODE_OPTION.label}
                        </span>
                      </span>
                      <span className={s.rowNote}>{ULTRACODE_OPTION.note}</span>
                    </span>
                    {ultracode && (
                      <Icon name="check" size={13} className={s.rowCheck} />
                    )}
                  </button>
                </Tooltip>
              </div>
            </div>

            <div className={s.foot}>
              <span className={s.footBody}>
                <span className={s.footLabel}>Thinking</span>
                <span className={s.footNote}>
                  Reason step-by-step before answering
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={thinking}
                aria-label="Extended thinking"
                className={`${s.switch}${thinking ? ` ${s.on}` : ""}`}
                onClick={() => onThinking(!thinking)}
              >
                <span className={s.knob} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
