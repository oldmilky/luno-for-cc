// ─────────────────────────────────────────────────────────────
// AnsweredQuestion — the transcript row for an AskUserQuestion.
//
// Deliberately quiet. The decision matters, but by the time this
// renders it is already made and the turn has moved on; it reads
// as a record beside the compaction and remote-approval rows, not
// as a card competing with the plan.
// ─────────────────────────────────────────────────────────────

import { Icon } from "../../../design/icons";
import { answerText, type AskedQuestionView } from "./question-log";
import s from "./AnsweredQuestion.module.scss";

export function AnsweredQuestion({ view }: { view: AskedQuestionView }) {
  if (view.questions.length === 0) return null;
  return (
    <div className={s.row}>
      <span className={s.icon} aria-hidden>
        <Icon name="bolt" size={11} />
      </span>
      <div className={s.body}>
        {view.questions.map((q, i) => {
          const chosen = answerText(view.answers[i]);
          return (
            <div key={i} className={s.line}>
              <span className={s.prompt}>{q.header || q.question}</span>
              {chosen ? (
                <span className={s.answer}>{chosen}</span>
              ) : (
                <span className={s.unanswered}>not answered</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
