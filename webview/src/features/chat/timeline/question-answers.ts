// ─────────────────────────────────────────────────────────────
// The wire shape of an AskUserQuestion, and the answer object the
// card sends back.
//
// `AskUserQuestion` computes nothing: the CLI hands the tool input
// back as its own result, so the user's choices reach the model
// only by replacing that input. Everything here exists to build
// that replacement, and to build it in the CLI's shape rather than
// ours — answers are keyed by the question TEXT, comma-joined for
// multi-select, with the free-text choice substituted in place of
// its label.
//
// Pure and React-free so it can be unit-tested directly.
// ─────────────────────────────────────────────────────────────

export interface WireOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface WireQuestion {
  question: string;
  header?: string;
  options: WireOption[];
  multiSelect?: boolean;
}

export interface QuestionDraft {
  /** Option labels, plus `OTHER` while the free-text choice is selected. */
  picked: string[];
  otherText: string;
}

/** Marks the free-text choice while it is only a selection. Replaced by what
 *  the user typed before anything leaves this module — the CLI knows only
 *  labels, so this sentinel must never reach the wire. Leading space so it
 *  cannot collide with a real option label. */
export const OTHER = " other";

/**
 * The questions on a `can_use_tool` payload, or `null` when the input is not
 * the shape this card renders. Defensive on purpose: the payload crosses the
 * webview boundary as `Record<string, unknown>`, and a malformed one should
 * fall back to the generic permission card rather than throw inside a prompt
 * the turn is blocked on.
 */
export function readQuestions(
  input: Record<string, unknown> | undefined
): WireQuestion[] | null {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return null;
  const out: WireQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || !q.question.trim()) continue;
    const options: WireOption[] = (Array.isArray(q.options) ? q.options : [])
      .map((o) => {
        const opt = (o ?? {}) as Record<string, unknown>;
        return {
          label: typeof opt.label === "string" ? opt.label : "",
          description:
            typeof opt.description === "string" ? opt.description : undefined,
          preview: typeof opt.preview === "string" ? opt.preview : undefined
        };
      })
      .filter((o) => o.label !== "");
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      options,
      multiSelect: q.multiSelect === true
    });
  }
  return out.length > 0 ? out : null;
}

export function emptyDrafts(questions: WireQuestion[]): QuestionDraft[] {
  return questions.map(() => ({ picked: [], otherText: "" }));
}

/** One answer string per question, keyed by the question text. A question
 *  with nothing chosen is absent rather than empty — the CLI reads a missing
 *  key as "not answered", and an empty string would read as an answer. */
export function buildAnswers(
  questions: WireQuestion[],
  drafts: QuestionDraft[]
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const d = drafts[i];
    if (!d) return;
    const labels = d.picked
      .map((l) => (l === OTHER ? d.otherText.trim() : l))
      .filter((l) => l !== "");
    if (labels.length > 0) answers[q.question] = labels.join(", ");
  });
  return answers;
}

export function buildUpdatedInput(
  input: Record<string, unknown>,
  questions: WireQuestion[],
  drafts: QuestionDraft[]
): Record<string, unknown> {
  // `questions` comes from the payload, not from our parse: the CLI matches
  // its result against what it sent, and `readQuestions` drops fields it does
  // not render. Spreading the original keeps `metadata` and anything added to
  // the schema later travelling untouched.
  return { ...input, answers: buildAnswers(questions, drafts) };
}

/** Every question answered — the gate on Submit, matching the reference
 *  client, which disables its primary button until the same is true. */
export function allAnswered(
  questions: WireQuestion[],
  drafts: QuestionDraft[]
): boolean {
  const answers = buildAnswers(questions, drafts);
  return questions.every((q) => (answers[q.question] ?? "").trim() !== "");
}

/** Whether this question has something chosen — drives the answered dot on
 *  its tab. Cheaper than building every answer just to look at one. */
export function isAnswered(draft: QuestionDraft | undefined): boolean {
  if (!draft) return false;
  return draft.picked.some(
    (l) => (l === OTHER ? draft.otherText.trim() : l) !== ""
  );
}
