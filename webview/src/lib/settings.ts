// ─────────────────────────────────────────────────────────────
// The handful of `luno.*` settings the webview acts on itself.
//
// A store rather than a prop: the composer that reads this sits three
// components below the one that would receive the message, and the inline edit
// composer sits somewhere else entirely. Threading a boolean through both
// paths would put the setting in six signatures to be honoured in two.
//
// The host is the source of truth and re-sends on every change, so nothing
// here needs a default beyond the one it starts with.
// ─────────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import { onMessage } from "./rpc";

export interface WebviewSettings {
  useCtrlEnterToSend: boolean;
  /** `luno.startupSuggestions` verbatim; the empty state resolves it. */
  startupSuggestions: ReadonlyArray<string>;
}

let current: WebviewSettings = {
  useCtrlEnterToSend: false,
  startupSuggestions: []
};
const listeners = new Set<() => void>();

/** Start listening. Called once at boot, beside the other message wiring. */
export function subscribeToSettings(): () => void {
  return onMessage((m) => {
    if (m.type !== "settings") return;
    current = {
      useCtrlEnterToSend: m.useCtrlEnterToSend,
      startupSuggestions: m.startupSuggestions
    };
    for (const notify of listeners) notify();
  });
}

export function useWebviewSettings(): WebviewSettings {
  return useSyncExternalStore(subscribe, () => current);
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}
