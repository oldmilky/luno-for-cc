// ─────────────────────────────────────────────────────────────
// Interactive Question Card. Renders one card per
// AskUserQuestion tool_use; supports radio (single-select),
// multi-select (checkboxes), and a free-text "Other" input.
// On submit we both record the answer in the timeline and feed
// it back to the model as the next user turn.
//
// Once answered the card switches to a read-only summary so
// rewinding back to this point preserves what was chosen.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { EXPAND } from "../../design/motion";
import { send } from "../../lib/rpc";
import type { PlanAnswerMeta, PlanQuestionMeta } from "./types";
import s from "./QuestionCard.module.scss";
import pbtn from "./PlanButton.module.scss";

interface Props {
  question: PlanQuestionMeta & { eventId: string; ts: number };
  answer?: PlanAnswerMeta & { eventId: string; ts: number };
  /** Disable inputs (locked once a newer revision lands or after answer). */
  locked: boolean;
}

export function QuestionCard({ question, answer, locked }: Props) {
  const [draft, setDraft] = useState<Array<{ choice: string; note?: string }>>(
    () => question.questions.map(() => ({ choice: "" }))
  );

  const isAnswered = !!answer;
  const disabled = isAnswered || locked;
  const allFilled = draft.every((d) => d.choice.trim() !== "");

  const submit = () => {
    if (!allFilled || disabled) return;
    send({
      type: "planAnswer",
      questionId: question.questionId,
      toolUseId: question.toolUseId,
      answers: draft
    });
  };

  return (
    <div className={`${s.card}${isAnswered ? ` ${s.answered}` : ""}`}>
      <div className={s.head}>
        <Icon name="bolt" size={12} />
        <span className={s.title}>
          {isAnswered ? "Answered" : "Needs your input"}
        </span>
      </div>
      <ol className={s.list}>
        {question.questions.map((q, i) => {
          const recorded = answer?.answers[i];
          const value = isAnswered ? recorded?.choice ?? "" : draft[i].choice;
          const noteValue = isAnswered ? recorded?.note ?? "" : draft[i].note ?? "";
          return (
            <li key={i} className={s.item}>
              <div className={s.prompt}>{q.question}</div>
              <div className={s.options}>
                {q.options.map((opt) => (
                  <label
                    key={opt.label}
                    className={`${s.option}${value === opt.label ? ` ${s.optionSelected}` : ""}`}
                  >
                    <input
                      type="radio"
                      name={`q-${question.questionId}-${i}`}
                      value={opt.label}
                      checked={value === opt.label}
                      disabled={disabled}
                      onChange={() =>
                        setDraft((cur) => cur.map((d, idx) => (idx === i ? { ...d, choice: opt.label } : d)))
                      }
                    />
                    <span className={s.optionBody}>
                      <span className={s.optionLabel}>{opt.label}</span>
                      {opt.description && (
                        <span className={s.optionDesc}>{opt.description}</span>
                      )}
                    </span>
                  </label>
                ))}
                <label
                  className={`${s.option}${value === "__other" ? ` ${s.optionSelected}` : ""}`}
                >
                  <input
                    type="radio"
                    name={`q-${question.questionId}-${i}`}
                    value="__other"
                    checked={value === "__other"}
                    disabled={disabled}
                    onChange={() =>
                      setDraft((cur) => cur.map((d, idx) => (idx === i ? { ...d, choice: "__other" } : d)))
                    }
                  />
                  <span className={s.optionBody}>
                    <span className={s.optionLabel}>Other</span>
                    <input
                      type="text"
                      className={s.other}
                      placeholder="Describe in your own words…"
                      disabled={disabled || value !== "__other"}
                      value={noteValue}
                      onChange={(e) =>
                        setDraft((cur) =>
                          cur.map((d, idx) => (idx === i ? { ...d, note: e.target.value } : d))
                        )
                      }
                    />
                  </span>
                </label>
              </div>
            </li>
          );
        })}
      </ol>
      {/* Submitting swaps the button out for the recorded-answer note in the
          same slot. `wait` so the card does not briefly stretch to hold both;
          `initial={false}` so a card that was already answered when the plan
          reopened does not replay the swap. */}
      <AnimatePresence initial={false} mode="wait">
        {isAnswered ? (
          <motion.div key="summary" className={s.summary} {...EXPAND}>
            Answer recorded — the agent has continued.
          </motion.div>
        ) : (
          <motion.div key="actions" className={s.actions} {...EXPAND}>
            <button
              type="button"
              className={`${pbtn.btn} ${pbtn.primary}`}
              onClick={submit}
              disabled={!allFilled || disabled}
            >
              Submit answer
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
