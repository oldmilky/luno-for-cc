// ─────────────────────────────────────────────────────────────
// The inline message editor — a user bubble turned editable in place.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import type { PermissionMode, ModelInfo, SkillInfo } from "../../lib/rpc";
import { Composer } from "./Composer";
import s from "./ChatScreen.module.scss";

// ── Inline message editor ───────────────────────────────────
//
// Replaces a user bubble in the timeline when the user clicks Edit.
// Wraps Composer in inline mode; local state owns the draft so the bottom
// composer's input is unaffected. RichEditor parses the original markdown
// (including code-pill blocks) on mount, so pills + the @ menu work
// identically to the main composer.
export function InlineMessageEditor({
  initialText,
  busy,
  model,
  permissionMode,
  models,
  skills,
  onCancel,
  onSubmit
}: {
  initialText: string;
  busy: boolean;
  model: string;
  permissionMode: PermissionMode;
  models: ReadonlyArray<ModelInfo>;
  skills: ReadonlyArray<SkillInfo>;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initialText);
  return (
    <div className={s.editing}>
      <div className={s.editingAvatar}>Y</div>
      <div className={s.editingBody}>
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={onSubmit}
          onCancel={onCancel}
          busy={busy}

          model={model}
          permissionMode={permissionMode}
          models={models}
          skills={skills}
          focusKey={0}
          pendingInsert={null}
          onInserted={() => {}}
          inline
          onDiscard={onCancel}
        />
      </div>
    </div>
  );
}
