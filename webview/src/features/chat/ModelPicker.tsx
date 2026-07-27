// ─────────────────────────────────────────────────────────────
// Model picker. Mirrors Claude Code's own model menu — a flat
// "Select a model" list where each row shows the concrete model
// its alias resolves to (e.g. Default → "Opus 5 · 1M context").
//
// Effort and thinking used to live at the foot of this panel and
// now have their own chip beside it: the list is the answer to
// "which model", and a control stack under it left no room to
// read that list in a sidebar.
//
// The catalog comes from the extension via the `models` RPC; the
// resolved versions arrive via `activeModel` messages (the host
// probes each alias against the CLI).
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { POPOVER_ABOVE, SWAP } from "../../design/motion";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { send, onMessage } from "../../lib/rpc";
import type { ModelInfo, EffortLevel } from "../../lib/rpc";
import { ULTRACODE_OPTION, clampEffort } from "./constants";
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
  /** The posture the effort picker owns. Held here only to correct it: a model
   *  that never had the pinned level — or has no X-high for ultracode — would
   *  otherwise fail on the first turn with an error the user cannot read. */
  effort: EffortLevel;
  ultracode: boolean;
  onEffort: (level: EffortLevel, ultracode: boolean) => void;
}

export function ModelPicker({
  models,
  value,
  resolvedModels = {},
  onSelect,
  effort,
  ultracode,
  onEffort
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
      // Ultracode *is* xhigh, so a model without xhigh cannot stay in it — and
      // the level it would fall back to is not xhigh either.
      const keepsUltracode =
        ultracode && m.effort.includes(ULTRACODE_OPTION.effort);
      if (next !== effort || (ultracode && !keepsUltracode)) {
        onEffort(
          keepsUltracode ? ULTRACODE_OPTION.effort : next,
          keepsUltracode
        );
      }
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
        }`}
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
                          <span className={s.rowLabel}>Other models</span>
                          <span className={s.rowNote}>
                            Haiku, Opus without 1M, and pinned older versions
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
                      <span className={s.title}>Other models</span>
                    </button>
                    <span className={s.sub}>
                      Everything not on the front page. A pinned version stays
                      put while the aliases move on; each is checked against
                      your CLI.
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
