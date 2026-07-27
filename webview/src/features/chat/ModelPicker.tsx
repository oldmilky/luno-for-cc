// ─────────────────────────────────────────────────────────────
// Model picker. Mirrors Claude Code's own model menu — a flat
// "Select a model" list where each row shows the concrete model
// its alias resolves to (e.g. Default → "Opus 4.7 · 1M context"),
// followed by an Effort segmented control and a Thinking toggle.
//
// The catalog comes from the extension via the `models` RPC; the
// resolved versions arrive via `activeModel` messages (the host
// probes each alias against the CLI). Effort + thinking are
// persisted in luno config and applied to the spawned `claude`
// CLI (`--effort` / `--settings alwaysThinkingEnabled`).
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { POPOVER_ABOVE, SWAP } from "../../design/motion";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { send, onMessage } from "../../lib/rpc";
import type { ModelInfo, EffortLevel } from "../../lib/rpc";
import {
  EFFORT_LEVELS,
  ULTRACODE_OPTION,
  findEffort,
  clampEffort
} from "./constants";
import { Tooltip } from "../../design/primitives";
import d from "../../design/primitives/Dropdown.module.scss";
import s from "./ModelPicker.module.scss";

export interface ModelPickerProps {
  models: ReadonlyArray<ModelInfo>;
  value: string;
  /** alias → concrete model id (e.g. `default` → `claude-opus-4-7[1m]`).
   *  Populated as the host resolves each entry; rows fall back to their
   *  static description until their version arrives. */
  resolvedModels?: Record<string, string>;
  onSelect: (id: string) => void;
  effort: EffortLevel;
  /** The sixth choice on the same control: xhigh plus workflow orchestration.
   *  Handed back together with the level because they are one decision. */
  ultracode: boolean;
  onEffort: (level: EffortLevel, ultracode: boolean) => void;
  thinking: boolean;
  onThinking: (on: boolean) => void;
}

export function ModelPicker({
  models,
  value,
  resolvedModels = {},
  onSelect,
  effort,
  ultracode,
  onEffort,
  thinking,
  onThinking
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"models" | "legacy">("models");
  const [legacy, setLegacy] = useState<ReadonlyArray<ModelInfo>>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      onMessage((m) => {
        if (m.type === "legacyModels") setLegacy(m.models);
      }),
    []
  );

  // A conversation reopened on a pinned version needs that version's effort
  // ladder before the panel is ever opened, or the segmented control offers
  // levels the CLI will reject. `probe: false` fetches the catalogue without
  // paying for a CLI spawn per entry.
  const pinned = !models.some((m) => m.value === value);
  useEffect(() => {
    if (pinned) send({ type: "requestLegacyModels", probe: false });
  }, [pinned]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape steps back out of the older-models panel before it closes the
      // whole picker — the same one-level-at-a-time the back arrow gives.
      if (e.key !== "Escape") return;
      setPanel((p) => {
        if (p === "legacy") return "models";
        setOpen(false);
        return p;
      });
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current =
    models.find((m) => m.value === value) ??
    legacy.find((m) => m.value === value) ??
    ({
      value,
      label: shortLabel(value),
      note: "active",
      supportsTools: true,
      group: "alias"
    } satisfies ModelInfo);

  const activeEffort = useMemo(() => findEffort(effort), [effort]);

  // What the selection accepts from `--effort`. An alias carries no ladder
  // because it always resolves to something current; an unknown id is treated
  // the same way rather than guessing a restriction onto it.
  const ladder = current.effort ?? EFFORT_LEVELS.map((e) => e.value);
  const effortRejected = ladder.length === 0;
  // The official client hides ultracode outright on a model without xhigh; we
  // show it disabled instead, so the row does not appear and vanish as the
  // model changes under the same open panel.
  const ultracodeAllowed = ladder.includes(ULTRACODE_OPTION.effort);

  // Concrete version for the active selection (drives the trigger + header).
  const currentResolved = resolvedModels[value]
    ? prettyModel(resolvedModels[value])
    : null;

  const pick = (m: ModelInfo) => {
    onSelect(m.value);
    // Land on a level this model has. Doing it here rather than in an effect
    // keeps the correction attached to the click that caused it.
    if (m.effort && m.effort.length > 0) {
      const next = clampEffort(effort, m.effort);
      // Ultracode *is* xhigh, so a model without xhigh cannot stay in it.
      if (next !== effort) onEffort(next, false);
    }
    setOpen(false);
  };

  const openLegacy = () => {
    setPanel("legacy");
    send({ type: "requestLegacyModels" });
  };

  return (
    <div className={d.picker} ref={ref}>
      <Tooltip
        label={`Model: ${current.label}${
          currentResolved ? ` — ${currentResolved}` : ""
        } · Effort: ${activeEffort.label} · Thinking: ${thinking ? "on" : "off"}`}
      >
        <button
          type="button"
          className={s.trigger}
          onClick={() => {
            setPanel("models");
            setOpen((o) => !o);
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Model"
        >
          <span className={s.triggerName}>{current.label}</span>
          {thinking && <Icon name="sparkle" size={9} />}
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
            {/* Keyed on the panel so the two screens cross-fade in place —
                one surface, no modal opening out of a popover. */}
            <AnimatePresence mode="wait" initial={false}>
              {panel === "models" ? (
                <motion.div key="models" {...SWAP}>
                  <div className={s.head}>
                    <span className={s.title}>Select a model</span>
                    <span className={s.sub}>
                      {currentResolved ? (
                        <>
                          Using{" "}
                          <span className={s.subStrong}>{currentResolved}</span>
                        </>
                      ) : (
                        "Each alias tracks the latest Claude release for your plan."
                      )}
                    </span>
                  </div>

                  <div className={s.scroll}>
                    <div className={s.list}>
                      {models.map((m) => (
                        <ModelRow
                          key={m.value}
                          label={m.label}
                          note={m.note}
                          version={
                            resolvedModels[m.value]
                              ? prettyModel(resolvedModels[m.value])
                              : null
                          }
                          recommended={m.value === "default"}
                          selected={m.value === value}
                          onSelect={() => pick(m)}
                        />
                      ))}
                      <button
                        type="button"
                        className={s.legacyEntry}
                        onClick={openLegacy}
                      >
                        <span className={s.legacyEntryBody}>
                          <span className={s.rowLabel}>Older models</span>
                          <span className={s.rowNote}>
                            Pin a specific version instead of tracking the
                            latest
                          </span>
                        </span>
                        <Icon name="chevronR" size={13} />
                      </button>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="legacy" {...SWAP}>
                  <div className={s.head}>
                    <button
                      type="button"
                      className={s.back}
                      onClick={() => setPanel("models")}
                    >
                      <Icon name="chevronL" size={12} />
                      <span className={s.title}>Older models</span>
                    </button>
                    <span className={s.sub}>
                      A pinned version stays put while the aliases move on. Each
                      is checked against your own CLI.
                    </span>
                  </div>

                  <div className={s.scroll}>
                    <div className={s.list}>
                      {legacy.length === 0 ? (
                        <span className={s.legacyEmpty}>Loading…</span>
                      ) : (
                        legacy.map((m) => (
                          <LegacyRow
                            key={m.value}
                            model={m}
                            selected={m.value === value}
                            onSelect={() => pick(m)}
                          />
                        ))
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className={s.controls}>
              <div className={s.control}>
                <div className={s.controlHead}>
                  <span className={s.controlLabel}>Effort</span>
                  <span className={s.controlValue}>
                    {effortRejected
                      ? "Not supported"
                      : ultracode
                        ? ULTRACODE_OPTION.label
                        : activeEffort.label}
                  </span>
                </div>
                <div
                  className={s.seg}
                  role="radiogroup"
                  aria-label="Reasoning effort"
                >
                  {EFFORT_LEVELS.map((opt, i) => {
                    // Under ultracode the ramp still fills to the level the
                    // turn runs at, but nothing on it is *chosen* — the row
                    // below is. Two active cells would be two answers to one
                    // question.
                    const activeIdx = EFFORT_LEVELS.findIndex(
                      (e) =>
                        e.value ===
                        (ultracode
                          ? ULTRACODE_OPTION.effort
                          : activeEffort.value)
                    );
                    // We push `--effort` on every spawn, so a level this model
                    // never had is a CLI error rather than a quieter answer.
                    const allowed = ladder.includes(opt.value);
                    return (
                      // The cell shows `opt.short` — a letter or two — so the
                      // full level name is genuinely new information, not an echo.
                      <Tooltip
                        key={opt.value}
                        label={
                          allowed
                            ? opt.label
                            : `${current.label} does not accept ${opt.label}`
                        }
                      >
                        <button
                          type="button"
                          role="radio"
                          disabled={!allowed}
                          aria-checked={
                            !ultracode && opt.value === activeEffort.value
                          }
                          aria-label={opt.label}
                          className={`${s.cell}${
                            allowed && i <= activeIdx ? ` ${s.filled}` : ""
                          }${
                            allowed &&
                            !ultracode &&
                            opt.value === activeEffort.value
                              ? ` ${s.active}`
                              : ""
                          }${allowed ? "" : ` ${s.cellOff}`}`}
                          onClick={() => onEffort(opt.value, false)}
                        >
                          <span className={s.cellLabel}>{opt.short}</span>
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
                {/* Its own row, and part of the same radiogroup: one more way
                    to answer "how hard should this turn work", but not a rung
                    on the ramp — it runs at X-high, below Max. */}
                <Tooltip
                  label={
                    ultracodeAllowed
                      ? "Runs every substantive task through a multi-agent workflow. Thorough, and it spends the quota accordingly."
                      : `${current.label} does not accept ${findEffort(ULTRACODE_OPTION.effort).label}`
                  }
                >
                  <button
                    type="button"
                    role="radio"
                    disabled={!ultracodeAllowed}
                    aria-checked={ultracode}
                    aria-label={ULTRACODE_OPTION.label}
                    className={`${s.ultra}${ultracode ? ` ${s.ultraOn}` : ""}${
                      ultracodeAllowed ? "" : ` ${s.cellOff}`
                    }`}
                    onClick={() => onEffort(ULTRACODE_OPTION.effort, true)}
                  >
                    <Icon name="bolt" size={11} />
                    <span className={s.ultraLabel}>
                      {ULTRACODE_OPTION.label}
                    </span>
                    <span className={s.ultraNote}>{ULTRACODE_OPTION.note}</span>
                  </button>
                </Tooltip>
              </div>

              <div className={`${s.control} ${s.controlRow}`}>
                <div className={`${s.controlHead} ${s.controlHeadInline}`}>
                  <span className={s.controlLabel}>Thinking</span>
                  <span className={s.controlNote}>
                    Reason step-by-step before answering
                  </span>
                </div>
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
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModelRow({
  label,
  note,
  version,
  recommended,
  selected,
  onSelect
}: {
  label: string;
  note?: string;
  version?: string | null;
  recommended?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`${s.row}${selected ? ` ${s.selected}` : ""}`}
      onClick={onSelect}
    >
      <span className={s.rowBody}>
        <span className={s.rowHead}>
          <span className={s.rowLabel}>{label}</span>
          {recommended && <span className={s.rowTag}>Recommended</span>}
        </span>
        {version ? (
          <span className={s.rowVersion}>{version}</span>
        ) : (
          <span className={`${s.rowVersion} ${s.rowVersionPending}`}>
            Resolving…
          </span>
        )}
        {note && <span className={s.rowNote}>{note}</span>}
      </span>
      {selected && (
        <span className={s.rowCheck} aria-hidden>
          <Icon name="check" size={15} />
        </span>
      )}
    </button>
  );
}

/**
 * A pinned version, with the case for it and the case against it side by side.
 *
 * The row is only clickable once the probe has confirmed this user's CLI serves
 * the id. Offering an unverified one would move the failure to the first turn,
 * where it arrives as a CLI error the user has no way to connect back to here.
 */
function LegacyRow({
  model,
  selected,
  onSelect
}: {
  model: ModelInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  const gone = model.available === false;
  const checking = model.available === undefined;
  return (
    <Tooltip
      label={
        gone
          ? "Your CLI or plan does not serve this version"
          : `Pin ${model.label} for this chat`
      }
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={gone || checking}
        className={`${s.row} ${s.legacyRow}${selected ? ` ${s.selected}` : ""}${
          gone ? ` ${s.rowGone}` : ""
        }`}
        onClick={onSelect}
      >
        <span className={s.rowBody}>
          <span className={s.rowHead}>
            <span className={s.rowLabel}>{model.label}</span>
            {checking && <span className={s.rowTag}>Checking…</span>}
            {gone && <span className={s.rowTagGone}>Unavailable</span>}
          </span>
          <span className={s.rowNote}>{model.note}</span>
          {model.plus && (
            <span className={s.factPlus}>
              <span className={s.factSign} aria-hidden>
                +
              </span>
              {model.plus}
            </span>
          )}
          {model.minus && (
            <span className={s.factMinus}>
              <span className={s.factSign} aria-hidden>
                −
              </span>
              {model.minus}
            </span>
          )}
        </span>
        {selected && (
          <span className={s.rowCheck} aria-hidden>
            <Icon name="check" size={15} />
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/** `claude-opus-4-7` → `opus-4-7` (used for unknown / freeform ids). */
function shortLabel(m: string): string {
  return m
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
}

/**
 * Format a concrete model id into a friendly version label:
 *   claude-opus-4-7[1m]  → "Opus 4.7 · 1M context"
 *   claude-sonnet-4-6    → "Sonnet 4.6"
 * Falls back to the stripped id for unrecognised shapes.
 */
function prettyModel(id: string): string {
  const has1m = /\[1m\]/i.test(id);
  const stripped = id
    .replace(/^claude-/, "")
    .replace(/\[1m\]/i, "")
    .replace(/-\d{8}$/, "");
  const m = stripped.match(/^([a-z]+)-?(.*)$/i);
  let label = stripped;
  if (m && /[a-z]/i.test(m[1])) {
    const tier = m[1][0].toUpperCase() + m[1].slice(1);
    const ver = m[2].replace(/-/g, ".");
    label = ver ? `${tier} ${ver}` : tier;
  }
  return has1m ? `${label} · 1M context` : label;
}
