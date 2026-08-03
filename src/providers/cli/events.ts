// ─────────────────────────────────────────────────────────────
// The CLI's stream-json wire format, and its translation into `StreamDelta`.
//
// `CliEvent` describes someone else's protocol: every field is optional
// because the CLI is free to add and drop them between versions, and a parser
// that insists otherwise breaks on an upgrade rather than on a bug.
//
// `makeProcessor` is the whole translation and holds the per-turn state a
// single event cannot carry — partial text, which tool_use ids have been seen,
// which echo is still owed. `mapEvent` is the stateless one-shot wrapper the
// tests use.
//
// Pure: no process, no timers, no I/O. What arrives here has already been read
// off a pipe by the provider.
// ─────────────────────────────────────────────────────────────

import type {
  RemoteControlStatus,
  StreamDelta,
  SubagentPhase,
  SubagentUpdate,
  WorkflowProgressEntry
} from "../../core/types.js";
import type { JsonRpcMessage } from "../../core/ide-tools.js";
import { autoModeDenialReason } from "../../core/permission-policy.js";
import { log as logInfo } from "../../services/logger.js";

interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * The `usage` block on a `system`/`task_*` event.
 *
 * Deliberately not `CliUsage`: the CLI reuses the field name for a completely
 * different measurement — how much the *subagent* spent, not the main turn's
 * token counts. The two are intersected on `CliEvent.usage` because both are
 * all-optional, so reading either shape needs no cast and neither can silently
 * pick up the other's numbers.
 */
export interface CliTaskUsage {
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

/** `system`/`task_*` subtype → the phase the rest of the app speaks in. */
const TASK_PHASES: Record<string, SubagentPhase> = {
  task_started: "started",
  task_progress: "progress",
  task_updated: "updated",
  task_notification: "notification"
};

export interface CliEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  /**
   * Set to the dispatching `Agent` tool_use id on everything a subagent
   * produces; `null` on the main agent's own traffic.
   *
   * The one field in this protocol that changes what an event *means* rather
   * than adding to it, which is why it is read before anything else.
   */
  parent_tool_use_id?: string | null;
  /** Resolved model id on the `system`/`init` event (alias → concrete id). */
  model?: string;
  /** The permission mode the CLI actually took, on `system`/`init`. Not always
   *  the one argv asked for: a refused `auto` downgrades here in silence. */
  permissionMode?: string;
  /** Every slash command the CLI knows, reported on `system`/`init`. */
  /** On a `result` — what opened the turn it ends. `task-notification` marks
   *  the turn the CLI opens by itself to report a finished background task,
   *  which is not a turn any surface here asked for. */
  origin?: { kind?: string };
  slash_commands?: string[];
  /** The same list, republished on `system`/`commands_changed` when it changes
   *  mid-session. Named differently on the wire from `slash_commands`. */
  commands?: string[];
  /** Set on a replayed `user` event the CLI injected itself rather than took
   *  from a person — command output played back into the conversation. Not a
   *  prompt, and opening a turn for one is a turn nobody asked for. */
  isSynthetic?: boolean;
  /** Set on a `user` event the CLI is playing back rather than receiving:
   *  either the prompt we just wrote to stdin, or one typed on a connected
   *  phone. Only present with `--replay-user-messages`. */
  isReplay?: boolean;
  /** Message id. The CLI mints one, or keeps the one the client supplied and
   *  returns it on the replay — which is how our own prompt is recognised
   *  coming back. */
  uuid?: string;
  message?: {
    /** Resolved model id on each `assistant` message — the model that
     *  actually produced this turn's output. */
    model?: string;
    /** A replayed `user` message carries the prompt as a bare string —
     *  measured on 2.1.219 — where everything else uses blocks. */
    content?:
      | string
      | Array<
          | { type: "text"; text: string }
          | {
              type: "tool_use";
              id: string;
              name: string;
              input: Record<string, unknown>;
            }
          | {
              type: "tool_result";
              tool_use_id: string;
              content: unknown;
              is_error?: boolean;
            }
        >;
    usage?: CliUsage;
  };
  event?: {
    type: string;
    content_block?: {
      type: string;
      id?: string;
      name?: string;
      text?: string;
    };
    delta?: {
      type: string;
      text?: string;
      partial_json?: string;
      /** Some CLI versions attach final usage on the message_delta event. */
      usage?: CliUsage;
    };
    index?: number;
  };
  /** End-of-turn result event — has the canonical post-turn usage + cost. On a
   *  `task_*` event this same field carries {@link CliTaskUsage} instead. */
  usage?: CliUsage & CliTaskUsage;
  total_cost_usd?: number;
  error?: string;
  result?: string;
  /**
   * Present on `system`/`compact_boundary`.
   *
   * Both spellings are read because both exist: the wire format observed on
   * 2.1.219 is snake_case, while the CLI carries its own reader for a
   * camelCase shape. Taking one on faith would silently drop the numbers —
   * the event would still arrive and the marker would still render, just with
   * nothing in it, which is the least detectable kind of wrong.
   */
  compact_metadata?: {
    trigger?: string;
    pre_tokens?: number;
    post_tokens?: number;
  };
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
  };
  /** Present on the end-of-turn `result` event: per-model totals, including
   *  the context window the model actually ran with. */
  modelUsage?: Record<string, { contextWindow?: number }>;
  /** Present on `rate_limit_event`. `resetsAt` is unix *seconds*, unlike
   *  every other timestamp in this protocol. */
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
    isUsingOverage?: boolean;
  };
  /**
   * `system`/`task_*` fields — one subagent's lifecycle.
   *
   * Spread flat across the event rather than nested, and unevenly: `task_id` is
   * the only one every phase carries. `task_updated` in particular has neither
   * `tool_use_id` nor a top-level `status` — its status lives in `patch`, which
   * is why reading only the top level would leave every task looking unfinished.
   */
  task_id?: string;
  tool_use_id?: string;
  subagent_type?: string;
  task_type?: string;
  /** `meta.name` from the workflow script, on a `local_workflow` task. */
  workflow_name?: string;
  /** Per-phase and per-agent state of a running workflow, on `task_progress`.
   *  The CLI has already computed everything a progress view needs. */
  workflow_progress?: WorkflowProgressEntry[];
  /** Every background task currently registered, on `background_tasks_changed`.
   *  An empty array is the CLI stating that nothing is running. */
  tasks?: Array<{
    task_id?: string;
    task_type?: string;
    description?: string;
  }>;
  description?: string;
  prompt?: string;
  status?: string;
  last_tool_name?: string;
  summary?: string;
  output_file?: string;
  patch?: { status?: string; end_time?: number };

  /** Control-protocol fields — present on `control_request` events the CLI
   *  emits when `--permission-prompt-tool stdio` is active. */
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    display_name?: string;
    tool_use_id?: string;
    description?: string;
    input?: Record<string, unknown>;
    permission_suggestions?: Array<Record<string, unknown>>;
    /** The CLI's own marker for "this call is a dialog, not a gate" — true for
     *  any tool whose `requiresUserInteraction()` says so. It carries the
     *  whole class `AskUserQuestion` belongs to, so reading it means the next
     *  tool of that shape needs no change here. */
    requires_user_interaction?: boolean;
    /** The CLI telling us not to offer a standing grant for this call. */
    suppress_always_allow_rule?: boolean;
    /** Why the CLI wants a human. Measured on 2.1.219: `"rule"` when a
     *  `permissions.ask` entry matched, `"other"` for the plain "this command
     *  requires approval" of `default` mode. Logged rather than rendered —
     *  under the CLI's `auto` every card is an escalation, and this is the only
     *  field that says which kind. */
    decision_reason_type?: string;
    /** Set when the call comes from a subagent rather than the main turn. */
    agent_id?: string;
    /** `request_user_dialog` only — which dialog, and what it needs to say. */
    dialog_kind?: string;
    payload?: Record<string, unknown>;
    /** `mcp_message` only — which in-process server the JSON-RPC below is
     *  addressed to, and the message itself. */
    server_name?: string;
    message?: JsonRpcMessage;
  };
  /** The CLI's answer to a control request we sent. */
  response?: {
    subtype?: string;
    request_id?: string;
    error?: string;
    response?: Record<string, unknown>;
  };
  /** Carried on `system`/`bridge_state` — the Remote Control bridge reporting
   *  on itself. */
  state?: string;
  /** Why the bridge failed, on `bridge_state` with `state: "error"`. */
  detail?: string;
}

type Processor = (ev: CliEvent) => StreamDelta[];

/**
 * The prompt inside a replayed `user` event, or null if the event is not one.
 *
 * `--replay-user-messages` plays back every user message the session accepts,
 * from whichever surface sent it — which is the only way a prompt typed on a
 * phone reaches us at all. Two things it must not match: the `user` events that
 * carry a `tool_result` back to the model (the same event type, every turn), and
 * anything a subagent produced, which is stamped with its dispatching tool id
 * and is not the conversation talking.
 *
 * The prompt arrives as a bare string rather than a block list — measured on
 * 2.1.219 — but the block form is accepted too, since an attachment sent from
 * the phone has nowhere else to go.
 */
export function replayedPrompt(ev: CliEvent): string | null {
  if (ev.type !== "user" || ev.parent_tool_use_id) return null;
  // `--replay-user-messages` is what this reads, and the CLI marks what it
  // replays. Without the check any `user` record the CLI injects for its own
  // bookkeeping was taken for a prompt someone typed. Measured: real prompts
  // carry the flag in both recordings under `test/fixtures/`.
  if (ev.isReplay !== true) return null;
  // The CLI stamps its own injected messages `isSynthetic` and its consumers
  // gate on it — a `<local-command-stdout>` frame, say, from a slash command
  // refused over the bridge. Read from the CLI's schema rather than measured
  // here, so it is written as a guard and nothing depends on it firing: the
  // only alternative defence is the one hard-coded English string in
  // `CLI_CONTROL_MARKERS`, which stops matching the day the wording changes.
  if (ev.isSynthetic === true) return null;
  const content = ev.message?.content;
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b.type === "tool_result")) return null;
  const text = content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  return text || null;
}

/**
 * Markers the CLI writes into the conversation as `user` records that no one
 * typed. They are its own bookkeeping and must never open a turn.
 *
 * Observed rather than designed: with Remote Control on, a Stop put
 * `[Request interrupted by user]` on the timeline **as the user's own message**
 * three times in one session, each stamped to the same second as an
 * `aborting turn` log line — and each opened a turn against the CLI, so the
 * model answered a control marker as if it were a prompt. The string is the
 * CLI's (it occurs in `claude.exe`, nowhere in this repo).
 *
 * A string match, and deliberately so: the wire shape of that record was not
 * captured — an interrupt sent after generation ends does not produce it — so
 * there is no field here worth gating on yet. Widen this to the field once
 * someone catches one mid-generation.
 */
const CLI_CONTROL_MARKERS = new Set(["[Request interrupted by user]"]);

/** Whether this replayed prompt is the CLI talking to itself. */
export function isCliControlMarker(prompt: string): boolean {
  return CLI_CONTROL_MARKERS.has(prompt.trim());
}

/**
 * Whether this replayed prompt is the echo of one we wrote ourselves.
 *
 * The replay flag does not distinguish the two surfaces — our own stdin writes
 * come back exactly like a phone's do. The discriminator is the id we put on
 * the message before sending it: the CLI preserves a client-supplied `uuid` and
 * returns it on the replay (measured against 2.1.219), which is how the
 * official extension tells its own messages apart. Matching on the text instead
 * would swallow a phone sending the same words we just did.
 *
 * Consumed rather than merely tested, so nothing accumulates for a session that
 * runs all day.
 */
export function takeEcho(
  pending: Set<string>,
  uuid: string | undefined
): boolean {
  if (!uuid) return false;
  return pending.delete(uuid);
}

/**
 * What a `bridge_state` event makes of the status we hold, or null when it
 * changes nothing.
 *
 * `detail` carries why the bridge failed and is the only account of it — a pill
 * reading "error" with no reason is what the user would otherwise get. The
 * official extension reads the same field.
 */
export function bridgeStatus(
  ev: CliEvent,
  current: RemoteControlStatus
): RemoteControlStatus | null {
  // `failed` is the word the CLI actually sends: the string pool beside
  // `[bridge:sdk] State change:` in 2.1.219 interns `failed · connected ·
  // ready`, and `disconnected` appears nowhere in it — that one is the official
  // extension's own vocabulary for "off". Both are read, because dropping
  // `failed` is dropping the only terminal state a live bridge can reach.
  const state = ev.state === "failed" ? "error" : ev.state;
  const known =
    state === "ready" ||
    state === "connected" ||
    state === "disconnected" ||
    state === "error";
  if (!known || state === current.state) return null;
  if (state === "error") {
    return { ...current, state, error: ev.detail ?? "Bridge error" };
  }
  // A recovered bridge must not keep describing the failure it recovered from.
  const { error: _gone, ...rest } = current;
  return { ...rest, state };
}

export function makeProcessor(
  setResume?: (id: string) => void,
  onSlashCommands?: (names: string[]) => void
): Processor {
  let sawPartialText = false;
  /** Whether this turn has already put text on the wire. Guards the paragraph
   *  break below so the first message does not open with blank lines. */
  let emittedText = false;
  const startedToolIds = new Set<string>();
  let currentBlockType: "text" | "tool_use" | "other" | null = null;
  // The CLI reports the *resolved* model (aliases like `opus` expand to a
  // concrete id). Emit it once per change so the UI can show what's actually
  // running rather than the alias the user picked.
  let reportedModel: string | null = null;
  /**
   * How much context the most recent *request* occupied, and the window it ran
   * in.
   *
   * Kept per stream because the `result` event cannot answer the first
   * question: its `usage` is the turn's running total, summed over every
   * request in it. Measured on a two-request turn — 33,453 then 34,372 — the
   * result reported 67,825, which is neither request and grows without bound
   * as a turn goes on. A twenty-request turn read 173% of a 1M window.
   */
  let lastRequestContext: number | undefined;
  let lastContextWindow: number | undefined;
  const emitModel = (model: string | undefined, out: StreamDelta[]) => {
    if (model && model !== reportedModel) {
      reportedModel = model;
      out.push({ type: "model", model });
    }
  };

  return (ev) => {
    const out: StreamDelta[] = [];

    // Everything a subagent produces is stamped with the `Agent` tool_use id
    // that dispatched it, and none of it is the conversation talking. Verified
    // on 2.1.220: a subagent's `assistant` event carries a real `tool_use`
    // block, so without this its nested Grep is emitted as a `tool_use_start`
    // and renders on the main timeline as a tool the top-level model ran. Its
    // `tool_result` would likewise be fed back into the main message history.
    // The subagent is reported through `task_*` instead — the only channel
    // that says which agent the work belongs to.
    if (ev.parent_tool_use_id) return out;

    if (ev.type === "system" && ev.subtype && ev.subtype in TASK_PHASES) {
      const update = taskUpdate(ev, TASK_PHASES[ev.subtype]);
      if (update) out.push({ type: "task", task: update });
      return out;
    }

    // The CLI folded earlier messages into a summary to make room. Silent
    // until now: a long chat simply stopped remembering its own beginning,
    // which reads as the product losing the user's work.
    if (ev.type === "system" && ev.subtype === "compact_boundary") {
      const meta = ev.compact_metadata ?? ev.compactMetadata;
      const postTokens =
        (meta as { post_tokens?: number } | undefined)?.post_tokens ??
        (meta as { postTokens?: number } | undefined)?.postTokens;
      out.push({
        type: "compact",
        compaction: {
          trigger: meta?.trigger,
          preTokens:
            (meta as { pre_tokens?: number } | undefined)?.pre_tokens ??
            (meta as { preTokens?: number } | undefined)?.preTokens,
          postTokens
        }
      });
      // The context just shrank, and the next request is what would otherwise
      // report it — until then the row would keep showing a window that is no
      // longer full, at exactly the moment the user is watching it. The CLI
      // says how much survived; Anthropic's extension zeroes the count here,
      // which is the same move with less information.
      lastRequestContext = typeof postTokens === "number" ? postTokens : 0;
      if (lastContextWindow !== undefined) {
        out.push({
          type: "usage",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: lastRequestContext,
            contextWindow: lastContextWindow
          }
        });
      }
      return out;
    }

    if (ev.type === "system" && ev.subtype === "init") {
      if (ev.session_id) setResume?.(ev.session_id);
      // The CLI's own answer to "what can be typed after a slash" — built-ins,
      // plugins and the user's `.claude/commands` alike. It arrives only on a
      // turn, so the composer caches it rather than asking.
      if (ev.slash_commands?.length) onSlashCommands?.(ev.slash_commands);
      emitModel(ev.model, out);
      return out;
    }

    // The command list is not fixed for the life of a session: installing a
    // plugin or writing a new `.claude/commands` file makes the CLI republish
    // it here rather than on a fresh `init`. Cached from `init` alone, a
    // command added mid-session never appeared in the popover.
    if (ev.type === "system" && ev.subtype === "commands_changed") {
      if (ev.commands?.length) onSlashCommands?.(ev.commands);
      return out;
    }

    if (ev.type === "stream_event" && ev.event) {
      const inner = ev.event;
      // A second assistant message in the same turn — the model picking the
      // conversation back up after a backgrounded agent answered. Its text is
      // appended to the same buffer, and with no tool call in between to flush
      // it the two run together: "…I'll summarise." + "The first one is back —"
      // rendered as one sentence with no break. Nothing downstream can tell
      // where a message ended, so the break is made here, where it is visible.
      if (inner.type === "message_start" && emittedText) {
        out.push({ type: "text", text: "\n\n" });
        return out;
      }
      if (inner.type === "content_block_start" && inner.content_block) {
        if (inner.content_block.type === "text") {
          currentBlockType = "text";
        } else if (inner.content_block.type === "tool_use") {
          currentBlockType = "tool_use";
          const id = inner.content_block.id ?? "";
          const name = inner.content_block.name ?? "tool";
          if (id) startedToolIds.add(id);
          out.push({ type: "tool_use_start", tool: { id, name } });
        } else {
          currentBlockType = "other";
        }
        return out;
      }
      if (inner.type === "content_block_delta" && inner.delta) {
        if (
          currentBlockType === "text" &&
          inner.delta.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          sawPartialText = true;
          emittedText = true;
          out.push({ type: "text", text: inner.delta.text });
        } else if (
          currentBlockType === "tool_use" &&
          inner.delta.type === "input_json_delta" &&
          typeof inner.delta.partial_json === "string"
        ) {
          out.push({
            type: "tool_use_input",
            partialInput: inner.delta.partial_json
          });
        }
        return out;
      }
      if (inner.type === "content_block_stop") {
        if (currentBlockType === "tool_use") {
          out.push({ type: "tool_use_end" });
        }
        currentBlockType = null;
        return out;
      }
      return out;
    }

    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      emitModel(ev.message.model, out);
      for (const block of ev.message.content) {
        if (block.type === "text") {
          if (!sawPartialText) {
            // Same boundary as `message_start` above, for the build that sends
            // whole messages rather than partials.
            if (emittedText) out.push({ type: "text", text: "\n\n" });
            emittedText = true;
            out.push({ type: "text", text: block.text });
          }
        } else if (block.type === "tool_use") {
          if (!startedToolIds.has(block.id)) {
            startedToolIds.add(block.id);
            out.push({
              type: "tool_use_start",
              tool: { id: block.id, name: block.name }
            });
            out.push({
              type: "tool_use_input",
              partialInput: JSON.stringify(block.input ?? {})
            });
            out.push({ type: "tool_use_end" });
          }
        }
      }
      sawPartialText = false;
      // Some CLI versions ship per-assistant-message usage. Forward it so the
      // meter shows live counts as the turn streams (the final result event
      // sends a corrected total later).
      //
      // This is also the only place the context occupancy can be read: one
      // assistant message is one request, so its own input + cache figures are
      // what that request put in front of the model. The window is not on this
      // event, so a live update only happens once a `result` in this stream has
      // named it.
      const u = ev.message.usage;
      if (u) {
        lastRequestContext = contextSize(u);
        const delta = makeUsageDelta(u, ev.session_id);
        if (delta.usage && lastContextWindow !== undefined) {
          delta.usage.contextTokens = lastRequestContext;
          delta.usage.contextWindow = lastContextWindow;
        }
        out.push(delta);
      }
      return out;
    }

    // Only the block form: a `user` event whose content is a bare string is a
    // replayed prompt, and the session reader has already taken it.
    if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((c: unknown) => {
                      const cc = c as { type?: string; text?: string };
                      return cc.type === "text" && cc.text ? cc.text : "";
                    })
                    .join("\n")
                : JSON.stringify(block.content);
          const refused = block.is_error ? autoModeDenialReason(content) : null;
          if (refused) logInfo(`[luno] auto mode denied a call: ${refused}`);
          out.push({
            type: "tool_result",
            toolUseId: block.tool_use_id,
            resultContent: content,
            resultIsError: !!block.is_error,
            ...(refused ? { autoModeDenial: refused } : {})
          });
        }
      }
      return out;
    }

    if (ev.type === "result") {
      // The end-of-turn `result` event carries the canonical totals — emit a
      // usage delta with cost if reported so the meter can switch from
      // estimate to authoritative.
      if (ev.usage) {
        const u = makeUsageDelta(ev.usage, ev.session_id);
        if (u.usage && typeof ev.total_cost_usd === "number") {
          u.usage.costUsd = ev.total_cost_usd;
        }
        if (u.usage) {
          // Not `contextSize(ev.usage)`: this event's usage is the turn's sum
          // across every request, so a long turn reports several times the
          // window it ran in. The last request's own figure is the answer, and
          // when the CLI shipped no per-message usage there is none — the row
          // then holds its previous value rather than showing a total as an
          // occupancy.
          lastContextWindow =
            contextWindowOf(ev.modelUsage, reportedModel) ?? lastContextWindow;
          u.usage.contextTokens = lastRequestContext;
          u.usage.contextWindow = lastContextWindow;
        }
        out.push(u);
      }
      if (ev.subtype === "error" || ev.subtype === "error_max_turns") {
        out.push({
          type: "error",
          error:
            ev.result ||
            (ev.subtype === "error_max_turns"
              ? "Claude CLI hit max turns. Try a simpler prompt or increase turns."
              : ev.subtype)
        });
      }
      return out;
    }

    // The only authoritative quota signal on this path. The CLI holds the HTTP
    // exchange and never passes the `anthropic-ratelimit-*` headers through,
    // so without this event the reset time can only be guessed from message
    // timestamps on disk — and that guess is wrong by hours whenever a window
    // boundary falls inside the range being scanned.
    if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
      const info = ev.rate_limit_info;
      if (typeof info.resetsAt === "number" && info.rateLimitType) {
        out.push({
          type: "rate_limit",
          rateLimit: {
            bucket: info.rateLimitType,
            resetsAt: info.resetsAt * 1000,
            status: info.status ?? "allowed",
            usingOverage: info.isUsingOverage,
            observedAt: Date.now()
          }
        });
      }
      return out;
    }

    if (ev.type === "error") {
      out.push({
        type: "error",
        error: ev.error || "Claude CLI reported an error."
      });
    }

    return out;
  };
}

export function mapEvent(
  ev: CliEvent,
  setResume?: (id: string) => void
): StreamDelta[] {
  return makeProcessor(setResume)(ev);
}

/**
 * One `system`/`task_*` event, flattened into the shape the rest of the app
 * reads. Pure translation — which of these reach the timeline and which stay
 * live is the host's decision, not this function's.
 *
 * Returns null for an event with no `task_id`: without it there is nothing to
 * correlate the update with, and a card that can never be closed is worse than
 * one that never opened.
 */
/**
 * Notices the CLI writes to stderr and then carries on from.
 *
 * The workspace-trust one is printed at startup, so it sits in the buffer for
 * the whole run and became the stated cause of every later failure it had
 * nothing to do with — including a turn that had already answered in full.
 */
const STDERR_ADVISORIES: ReadonlyArray<RegExp> = [
  /permissions\.allow entries/i,
  /has not been trusted/i,
  /hasTrustDialogAccepted/i
];

/**
 * What to tell the user when the CLI exits non-zero — often nothing.
 *
 * An exit that lands after the turn's own `result` is not that turn failing:
 * the answer is on screen, and marking the chat red contradicts what the user
 * is reading. Those go to the log instead, where a real diagnosis can find
 * them.
 */
/** The lines of stderr worth reading back. The advisories the CLI prints on
 *  runs that went fine are not among them. */
export function usefulStderr(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line && !STDERR_ADVISORIES.some((advice) => advice.test(line))
    );
}

export function exitFailure(
  stderr: string,
  code: number | null,
  answered: boolean
): string | null {
  const lines = usefulStderr(stderr);
  if (answered) {
    logInfo(
      `[luno] claude exited ${code ?? "?"} after answering` +
        (lines.length ? `: ${lines.join(" ")}` : "")
    );
    return null;
  }
  return lines.join("\n") || `claude exited with code ${code ?? "?"}`;
}

function taskUpdate(ev: CliEvent, phase: SubagentPhase): SubagentUpdate | null {
  if (!ev.task_id) return null;
  const u = ev.usage;
  return {
    phase,
    taskId: ev.task_id,
    toolUseId: ev.tool_use_id,
    taskType: ev.task_type,
    workflowName: ev.workflow_name,
    subagentType: ev.subagent_type,
    // Same wire field, two different meanings — see `SubagentTask.activity`.
    description: phase === "progress" ? undefined : ev.description,
    activity: phase === "progress" ? ev.description : undefined,
    prompt: ev.prompt,
    // `task_updated` hides its status one level down; the others report it flat.
    status: ev.patch?.status ?? ev.status,
    durationMs: u?.duration_ms,
    toolUses: u?.tool_uses,
    totalTokens: u?.total_tokens,
    lastToolName: ev.last_tool_name,
    // Phase-gated for the same reason `description` is, and the contract says
    // so: `notification` is the only phase whose `summary` is an answer. On
    // `task_progress` the CLI echoes the *task's own description* there —
    // measured in `test/fixtures/workflow-stream.jsonl`, where four progress
    // records repeat "probe run for a stream audit" and the first is stamped
    // `duration_ms: 22`. Copied through, that string reached the card as a
    // finished answer 22ms after launch, under the heading "Answered".
    summary: phase === "notification" ? ev.summary : undefined,
    outputFile: ev.output_file,
    // Passed through on its own merit, never gated on `task_type`: measured on
    // 2.1.219, the CLI sends `task_type` on `task_started` and on no other
    // phase, so a gate here discards `workflow_progress` on every event that
    // actually carries it. Which kind of task this is belongs to the host,
    // which has the dispatch merged in — see `onSubagentUpdate`.
    workflowProgress: ev.workflow_progress
  };
}

function makeUsageDelta(u: CliUsage, sessionId?: string): StreamDelta {
  return {
    type: "usage",
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens:
        u.cache_read_input_tokens !== undefined
          ? u.cache_read_input_tokens
          : undefined,
      cacheCreatedTokens:
        u.cache_creation_input_tokens !== undefined
          ? u.cache_creation_input_tokens
          : undefined,
      sessionId
    }
  };
}

/**
 * How much context the request that just ran occupied.
 *
 * Cached tokens count: they are part of the prompt the model read, and leaving
 * them out reports a nearly-full window as nearly empty — cache reads are most
 * of a long conversation. This is the same sum the CLI uses internally to
 * decide when to compact.
 */
export function contextSize(u: CliUsage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    // The reply counts too: it is already written, and the next request carries
    // it as history. Anthropic's own extension sums the same four fields —
    // `updateUsage` in its webview bundle, 2.1.220.
    (u.output_tokens ?? 0)
  );
}

/**
 * The window the model actually ran with.
 *
 * Read from the CLI's per-model totals rather than assumed from the model name:
 * the same alias resolves to a different window depending on the `[1m]` variant
 * and the account, and guessing 200k for a million-token run would put the
 * meter at 5× the truth.
 */
export function contextWindowOf(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
  mainLoopModel?: string | null
): number | undefined {
  if (!modelUsage) return undefined;
  // The model that ran the main loop, when the CLI named it — that is the
  // conversation's own window, and it is what Anthropic's extension reads
  // (`modelUsage[currentMainLoopModel]`).
  const named = mainLoopModel
    ? modelUsage[mainLoopModel]?.contextWindow
    : undefined;
  if (typeof named === "number" && named > 0) return named;

  // Otherwise the largest of them. Several models can appear in one turn (a
  // haiku side-call alongside the main model), and a side-call's smaller
  // window would understate the room left.
  let largest: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    const w = entry?.contextWindow;
    if (
      typeof w === "number" &&
      w > 0 &&
      (largest === undefined || w > largest)
    ) {
      largest = w;
    }
  }
  return largest;
}
