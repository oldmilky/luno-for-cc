// ─────────────────────────────────────────────────────────────
// Which configuration scope a setting should be written to.
//
// VS Code resolves settings narrowest-wins: a workspace-folder value beats a
// workspace value beats a global one. So writing Global while a narrower value
// exists is a write that succeeds and changes nothing observable — the read
// still returns the narrower value.
//
// That produced a control that looked broken with no error anywhere: a
// `.vscode/settings.json` pinning `luno.effort` and `luno.permissionMode` made
// both pickers un-clickable, because every click wrote Global, re-read the
// workspace value, and echoed the old setting straight back to the UI.
//
// Pure so it can be tested; the caller maps the answer to
// `vscode.ConfigurationTarget`.
// ─────────────────────────────────────────────────────────────

export type SettingScope = "workspaceFolder" | "workspace" | "global";

/** The shape `WorkspaceConfiguration.inspect()` returns, reduced to what matters. */
export interface InspectedSetting {
  workspaceFolderValue?: unknown;
  workspaceValue?: unknown;
}

/**
 * Write where the value already lives, so the write is the value the next read
 * returns. Global only when nothing narrower is set.
 *
 * `undefined` is the test for presence, not falsiness: `false` and `""` are
 * legitimate settings values, and treating them as absent would send the write
 * to the wrong scope for exactly the settings a user had bothered to turn off.
 */
export function scopeForWrite(
  inspected: InspectedSetting | undefined
): SettingScope {
  if (inspected?.workspaceFolderValue !== undefined) return "workspaceFolder";
  if (inspected?.workspaceValue !== undefined) return "workspace";
  return "global";
}
