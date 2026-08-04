// ─────────────────────────────────────────────────────────────
// The Remote Control toggle — standing the bridge up, and taking it down.
//
// Only the toggle lives here. The bridge itself is the provider's: it is the
// same process the conversation streams through, and its lifecycle is a
// session-mode concern rather than a UI one.
//
// The provider arrives through the narrow interface below rather than as a
// `ClaudeCliProvider`, which is what keeps this module out of the CLI half. Two
// methods is all the toggle has ever needed.
// ─────────────────────────────────────────────────────────────

import type { RemoteControlStatus } from "../../core/types.js";

/** The two provider methods the toggle uses, and nothing else. */
export interface RemoteControlProvider {
  enableRemoteControl(name?: string): Promise<RemoteControlStatus>;
  disableRemoteControl(): Promise<void>;
}

/** What toggling the bridge needs from the conversation it belongs to. */
export interface RemoteControlTarget {
  /** The process already running, if there is one. Turning the bridge off must
   *  not start one — there would be nothing to disable. */
  liveProvider: () => RemoteControlProvider | null | undefined;
  /** Turning it on must have a process to bridge, so this one may spawn. */
  ensureProvider: () => Promise<RemoteControlProvider>;
  publish: (status: RemoteControlStatus) => void;
  /** Names the session on the phone. Empty is passed as absent. */
  title?: string;
}

/**
 * Turn Remote Control on or off, reporting every state it passes through.
 *
 * Enabling reaches the Anthropic API and the reply can be up to 30s away, so
 * the intermediate `connecting` is not decoration: a control that does nothing
 * visible for two seconds reads as broken. It is deliberately not `ready` —
 * that state is a bridge standing up and waiting, and it offers a link which
 * at this point does not exist yet.
 */
export async function toggleRemoteControl(
  enabled: boolean,
  target: RemoteControlTarget
): Promise<void> {
  if (!enabled) {
    await target.liveProvider()?.disableRemoteControl();
    target.publish({ state: "off" });
    return;
  }
  target.publish({ state: "connecting" });
  try {
    const provider = await target.ensureProvider();
    target.publish(
      await provider.enableRemoteControl(target.title || undefined)
    );
  } catch (err) {
    target.publish({
      state: "error",
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
