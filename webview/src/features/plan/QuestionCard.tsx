// ─────────────────────────────────────────────────────────────
// Question Card — the record of an AskUserQuestion inside a plan
// revision: what was asked, and what was chosen.
//
// Read-only. Answering happens on the permission card in the chat
// stream, because the answers reach the model as the `updatedInput`
// of the tool's own permission response and nothing else delivers
// them. This card used to submit, which opened a second turn
// against a tool call the CLI had already resolved with "The user
// did not answer the questions."
// ─────────────────────────────────────────────────────────────

import { Icon } from "../../design/icons";
import type { PlanAnswerMeta, PlanQuestionMeta } from "./types";
import s from "./QuestionCard.module.scss";

interface Props {
  question: PlanQuestionMeta & { eventId: string; ts: number };
  answer?: PlanAnswerMeta & { eventId: string; ts: number };
}

export function QuestionCard({ question, answer }: Props) {
  const isAnswered = !!answer;

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
          // The sentinel the old submitting card stored for "Other". Sessions
          // saved before the answer moved to the permission response still
          // carry it, and rendering it raw would show the user `__other`.
          const chosen =
            recorded?.choice === "__other"
              ? (recorded.note ?? "Other")
              : (recorded?.choice ?? "");
          return (
            <li key={i} className={s.item}>
              <div className={s.prompt}>{q.question}</div>
              <div className={s.options}>
                {q.options.map((opt) => (
                  <span
                    key={opt.label}
                    className={`${s.option}${chosen === opt.label ? ` ${s.optionSelected}` : ""}`}
                  >
                    <span className={s.optionBody}>
                      <span className={s.optionLabel}>{opt.label}</span>
                      {opt.description && (
                        <span className={s.optionDesc}>{opt.description}</span>
                      )}
                    </span>
                  </span>
                ))}
                {/* An answer the user typed rather than picked has no option
                    to highlight, so it gets a row of its own. */}
                {chosen !== "" &&
                  !q.options.some((opt) => opt.label === chosen) && (
                    <span className={`${s.option} ${s.optionSelected}`}>
                      <span className={s.optionBody}>
                        <span className={s.optionLabel}>{chosen}</span>
                      </span>
                    </span>
                  )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className={s.summary}>
        {isAnswered
          ? "Answer recorded — the agent has continued."
          : "Answer this on the card in the chat."}
      </div>
    </div>
  );
}
