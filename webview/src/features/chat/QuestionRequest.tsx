// ─────────────────────────────────────────────────────────────
// QuestionRequest — the body of the permission card when the tool
// asking is `AskUserQuestion`.
//
// Editing only. The answer object and every rule about its shape
// live in `question-answers.ts`; this file renders the choices and
// hands the drafts up. Reads the raw `can_use_tool` input rather
// than the parsed plan types — `preview` exists on the wire and
// PlanQuestionOption drops it.
// ─────────────────────────────────────────────────────────────

import { useState, type ReactNode } from "react";
import { MarkdownBody } from "./timeline/markdown";
import {
  OTHER,
  emptyDrafts,
  isAnswered,
  type QuestionDraft,
  type WireQuestion
} from "./timeline/question-answers";
import s from "./QuestionRequest.module.scss";

interface Props {
  questions: WireQuestion[];
  /** Fires on every change with the drafts as they now stand. The card owns
   *  what to do with them; this component owns only the editing. */
  onChange: (drafts: QuestionDraft[]) => void;
}

export function QuestionRequest({ questions, onChange }: Props) {
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    emptyDrafts(questions)
  );
  const [active, setActive] = useState(0);

  const current = questions[active];
  const draft = drafts[active] ?? { picked: [], otherText: "" };

  const apply = (next: QuestionDraft[]) => {
    setDrafts(next);
    onChange(next);
  };

  const patch = (change: Partial<QuestionDraft>) =>
    apply(drafts.map((d, i) => (i === active ? { ...d, ...change } : d)));

  const toggle = (label: string) => {
    if (current?.multiSelect) {
      const has = draft.picked.includes(label);
      patch({
        picked: has
          ? draft.picked.filter((l) => l !== label)
          : [...draft.picked, label]
      });
      return;
    }
    patch({ picked: [label] });
  };

  if (!current) return null;

  // Previews are single-select only — the reference client's own restriction,
  // and a side-by-side pane has no meaning with several options chosen.
  const preview =
    !current.multiSelect && draft.picked.length === 1
      ? current.options.find((o) => o.label === draft.picked[0])?.preview
      : undefined;
  const hasPreviews =
    !current.multiSelect && current.options.some((o) => o.preview);

  return (
    <div className={s.wrap}>
      {questions.length > 1 && (
        <div className={s.tabs} role="tablist">
          {questions.map((q, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={`${s.tab}${i === active ? ` ${s.tabActive}` : ""}${
                isAnswered(drafts[i]) ? ` ${s.tabAnswered}` : ""
              }`}
            >
              {q.header || `Q${i + 1}`}
            </button>
          ))}
        </div>
      )}

      <div className={s.question}>{current.question}</div>

      <div className={hasPreviews ? s.split : undefined}>
        <div
          className={s.options}
          role={current.multiSelect ? "group" : "radiogroup"}
        >
          {current.options.map((opt) => (
            <Choice
              key={opt.label}
              name={`q-${active}`}
              multi={current.multiSelect === true}
              checked={draft.picked.includes(opt.label)}
              label={opt.label}
              description={opt.description}
              onSelect={() => toggle(opt.label)}
            />
          ))}
          {/* Always offered: the tool's contract says the user can answer in
              their own words, and the model is told not to add an "Other"
              option of its own. */}
          <Choice
            name={`q-${active}`}
            multi={current.multiSelect === true}
            checked={draft.picked.includes(OTHER)}
            label="Other"
            onSelect={() => toggle(OTHER)}
          >
            <input
              type="text"
              className={s.otherInput}
              placeholder="Answer in your own words…"
              value={draft.otherText}
              disabled={!draft.picked.includes(OTHER)}
              onChange={(e) => patch({ otherText: e.target.value })}
              // The card submits on Enter and denies on Escape; neither should
              // fire from the middle of a sentence being typed here.
              onKeyDown={(e) => e.stopPropagation()}
            />
          </Choice>
        </div>

        {hasPreviews && (
          <div className={s.preview}>
            {preview ? (
              <div className="md">
                <MarkdownBody text={preview} />
              </div>
            ) : (
              <span className={s.previewEmpty}>
                Pick an option to preview it
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ChoiceProps {
  name: string;
  multi: boolean;
  checked: boolean;
  label: string;
  description?: string;
  onSelect: () => void;
  children?: ReactNode;
}

function Choice({
  name,
  multi,
  checked,
  label,
  description,
  onSelect,
  children
}: ChoiceProps) {
  return (
    <label className={`${s.option}${checked ? ` ${s.optionOn}` : ""}`}>
      {/* The native control is kept — it carries the semantics, the keyboard
          and the screen-reader announcement — but drawn by the box beside it.
          `accent-color` alone left a square checkbox and a square focus ring
          around a round radio, neither of which is ours. */}
      <input
        type={multi ? "checkbox" : "radio"}
        name={multi ? undefined : name}
        checked={checked}
        onChange={onSelect}
        className={s.control}
      />
      <span className={multi ? s.box : `${s.box} ${s.boxRound}`} aria-hidden />
      <span className={s.optionBody}>
        <span className={s.optionLabel}>{label}</span>
        {description && <span className={s.optionDesc}>{description}</span>}
        {children}
      </span>
    </label>
  );
}
