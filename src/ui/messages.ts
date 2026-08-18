// ─────────────────────────────────────────────────────────────
// The webview → host half of the protocol, from the host's side.
//
// The webview owns the full typed union in `webview/src/lib/rpc.ts`,
// but the two halves are separate compilations: nothing carries a
// type across the `postMessage` boundary. What arrives here is
// genuinely `unknown`, so it is validated at the boundary rather
// than asserted through.
//
// What this file adds is the part that was missing: an enumerated
// list of what the host accepts. `HandlerTable` is keyed by it, so
// the compiler now refuses a table with a message type left out —
// where before, an unhandled type fell off the end of a `switch`
// with no `default` and vanished in silence.
//
// The list is a hand-kept mirror of rpc.ts's `Outbound`, and
// `test/unit/protocol-contract.test.ts` fails when the two drift.
// ─────────────────────────────────────────────────────────────

import type { ContentBlock } from "../core/types.js";

/** Every message type the host accepts. Mirror of rpc.ts `Outbound`. */
export type InboundType =
  // chat + turn lifecycle
  | "prompt"
  | "cancel"
  | "newSession"
  | "permissionResponse"
  | "userDialogResponse"
  | "rewindTo"
  | "editAt"
  // auth + setup
  | "refreshAuth"
  | "claudeLogout"
  | "submitToken"
  | "startClaudeSetup"
  | "cancelClaudeSetup"
  | "confirmClaudeSetup"
  | "runTerminalCommand"
  // settings
  | "setModel"
  | "setPermissionMode"
  | "setEffort"
  | "setThinking"
  | "toggleRemoteControl"
  // editor + files
  | "openExternal"
  | "openFile"
  | "readAttachment"
  | "revertFile"
  | "requestFileSearch"
  | "requestTerminals"
  | "requestToolGrants"
  | "revokeToolGrant"
  | "requestPermissionRules"
  | "captureSelection"
  | "voiceStart"
  | "voiceStop"
  | "refreshEditorContext"
  | "chatFocus"
  // models
  | "requestModels"
  | "requestLegacyModels"
  // skills + marketplace
  | "requestSkills"
  | "requestSlashCommands"
  | "setSkillEnabled"
  | "requestMarketplace"
  | "requestSkillDetail"
  | "installMarketplaceSkill"
  | "uninstallMarketplaceSkill"
  | "dismissSkillSuggestion"
  // history
  | "requestHistory"
  | "loadSession"
  | "deleteHistoryEntry"
  | "renameSession"
  // usage
  | "refreshUsage"
  // conventions
  | "dismissConventionsBanner"
  | "openConventionsFile"
  | "generateConventions"
  // plan review
  | "planComment"
  | "planEditComment"
  | "planDeleteComment"
  | "planReplyComment"
  | "planResolveComment"
  | "planReopenComment"
  | "planOpenFileRef"
  | "planAcceptStep"
  | "planModifyStep"
  | "planSkipStep"
  | "planOpenInEditor"
  | "planResubmit"
  | "planAnswer"
  | "planRewindTo"
  | "planProceedRequest"
  | "requestArtifactState"
  // MCP connectors
  | "requestConnectors"
  | "connectorConnect"
  | "connectorCancelConnect"
  | "connectorDisconnect"
  | "connectorAddCustom"
  | "connectorRemoveCustom"
  | "connectorSetupViaClaudeCode"
  | "connectorConnectWithApiKey";

/** A message as it actually arrives: a type, and fields of unknown shape. */
export interface RawMessage {
  type: string;
  [key: string]: unknown;
}

export type Handler = (msg: RawMessage) => void | Promise<void>;

/**
 * The other direction: host → webview.
 *
 * Extracted domains take this rather than the provider, which is what keeps
 * them from reaching back into panel state. The provider's own `post` also
 * mirrors to any open plan-artifact tab, so a domain publishes to every
 * surface without knowing that more than one exists.
 */
export type Post = (msg: unknown) => void;

/**
 * One entry per accepted message. Keyed by `InboundType`, which is what makes
 * a missing handler a compile error rather than a message that quietly does
 * nothing.
 */
export type HandlerTable = Record<InboundType, Handler>;

// ── Field readers ────────────────────────────────────────────
// Each returns `undefined` rather than throwing or coercing: a malformed
// message from a webview we control is a bug to notice, not an exception to
// propagate into the extension host. Callers drop the message and say so.

export function str(msg: RawMessage, key: string): string | undefined {
  return typeof msg[key] === "string" ? (msg[key] as string) : undefined;
}

export function num(msg: RawMessage, key: string): number | undefined {
  return typeof msg[key] === "number" ? (msg[key] as number) : undefined;
}

export function bool(msg: RawMessage, key: string): boolean | undefined {
  return typeof msg[key] === "boolean" ? (msg[key] as boolean) : undefined;
}

export function obj(
  msg: RawMessage,
  key: string
): Record<string, unknown> | undefined {
  const v = msg[key];
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function arr(msg: RawMessage, key: string): unknown[] | undefined {
  return Array.isArray(msg[key]) ? (msg[key] as unknown[]) : undefined;
}

/** A string field constrained to a known set — scopes, modes, behaviours. */
export function oneOf<T extends string>(
  msg: RawMessage,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const v = msg[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

/**
 * Attachments off a `prompt` message, validated rather than cast.
 *
 * Everything on this side of the seam is `unknown`, and these blocks go
 * straight onto the wire to the CLI — a half-formed one is a turn the API
 * refuses with no clue where the bad field came from. So each block is rebuilt
 * from fields that were actually checked, and anything that does not answer the
 * shape is dropped rather than repaired.
 *
 * The media type is not policed here. The webview classified the file against
 * the API's own lists before building the block, and second-guessing that with
 * a shorter list on this side would refuse files the reference sends happily.
 */
export function readAttachments(msg: RawMessage): ContentBlock[] {
  const raw = arr(msg, "attachments");
  if (!raw) return [];
  const out: ContentBlock[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const rawSource = block.source;
    if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource))
      continue;
    const source = rawSource as Record<string, unknown>;
    const mediaType = strOf(source, "media_type");
    const data = strOf(source, "data");
    if (!mediaType || !data) continue;

    if (block.type === "image" && source.type === "base64") {
      out.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data }
      });
      continue;
    }
    if (block.type !== "document") continue;
    const title = strOf(block, "title");
    if (source.type === "base64") {
      out.push({
        type: "document",
        source: { type: "base64", media_type: mediaType, data },
        ...(title && { title })
      });
    } else if (source.type === "text") {
      out.push({
        type: "document",
        source: { type: "text", media_type: "text/plain", data },
        ...(title && { title })
      });
    }
  }
  return out;
}

/** `str`, for a nested object rather than a whole message. The readers above
 *  take a `RawMessage` because that is what arrives; a `source` inside one has
 *  the same shape without the `type` those insist on. */
function strOf(o: Record<string, unknown>, key: string): string | undefined {
  return typeof o[key] === "string" ? (o[key] as string) : undefined;
}
