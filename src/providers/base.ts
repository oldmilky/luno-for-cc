import { Message, PermissionBehavior, StreamDelta } from "../core/types.js";

export interface ProviderRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: Message[];
  /** Kept as a typed slot for forward-compat. The CLI doesn't consume it. */
  tools: unknown[];
}

export interface ChatProvider {
  readonly id: string;
  stream(req: ProviderRequest): AsyncIterable<StreamDelta>;
  /**
   * Hard-stop the in-flight turn by terminating the underlying process.
   * Needed because a turn paused on a permission prompt emits no deltas, so
   * a flag-based cancel alone never trips. Optional — not every provider runs
   * a killable child.
   */
  cancel?(): void;
  /**
   * Answer a pending tool-permission prompt (a `permission_request` delta the
   * provider emitted earlier this turn). Optional — only providers that speak
   * the CLI's interactive control protocol implement it.
   *
   * @param restOfTurn when allowing, also stop prompting for similar tool
   *   calls for the remainder of this turn (uses the CLI's own "accept edits"
   *   suggestion when one was offered).
   */
  respondToPermission?(
    requestId: string,
    behavior: PermissionBehavior,
    opts?: { restOfTurn?: boolean }
  ): void;
}
