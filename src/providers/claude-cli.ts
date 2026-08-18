import { log as logInfo } from "../services/logger.js";
import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { ChatProvider, ProviderRequest } from "./base.js";
import { grantFor, grantLabel } from "../core/tool-grants.js";
import { pendingSettings, type ClaudeCliOpts } from "./cli/options.js";
import {
  createToolStallWatchdog,
  WEB_TOOL_STALL_MS,
  type ToolStallWatchdog
} from "./cli/watchdog.js";
import {
  bridgeStatus,
  exitFailure,
  isCliControlMarker,
  makeProcessor,
  replayedPrompt,
  takeEcho,
  usefulStderr,
  type CliEvent
} from "./cli/events.js";
import {
  argvDiff,
  buildArgs,
  effortFlag,
  mapPermissionMode,
  respawnFingerprint,
  turnPreamble
} from "./cli/args.js";
import {
  decidePermission,
  denialMessage,
  INTERACTIVE_TOOLS,
  isDestructiveRequest,
  isNetworkRequest,
  STAYED_IN_PLAN_MODE
} from "../core/permission-policy.js";
import {
  ContentBlock,
  DialogKind,
  Message,
  PermissionBehavior,
  PermissionMode,
  PermissionRequestPayload,
  PermissionSuggestion,
  RemoteControlStatus,
  SUPPORTED_DIALOG_KINDS,
  isTerminalTaskStatus,
  StreamDelta,
  TaskType,
  UserDialogPayload
} from "../core/types.js";
import { handleIdeMcpMessage } from "../core/ide-tools.js";
import { askUserQuestionTimeoutMs } from "../services/claude-settings.js";

/**
 * How long the CLI may produce nothing at all — not one stdout line, not one
 * stderr byte — before it is treated as wedged and SIGKILLed.
 *
 * Measured from the last sign of life, never from spawn. As a deadline from
 * spawn this killed turns that were working perfectly: a `/audit` driving a
 * fleet of background agents died at exactly 10 minutes, mid-message, with no
 * error, no partial result and nothing in the transcript to say why. A long
 * build, a long test run and a subagent fleet are all silent-looking to a
 * wall clock and none of them are wedged. Real wedging is silence, so that is
 * what is measured.
 */
const SILENCE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How often the turn re-checks whether background work is still outstanding.
 *
 * A `run_in_background` agent keeps working past the end of the turn: timed
 * against 2.1.220, one reported `completed` with its full answer 5.6s after
 * `result` arrived. Ending the turn there — which is what closing stdin does —
 * exits the child and kills the agent mid-step, so its card could only ever
 * read "interrupted".
 *
 * This used to be a deadline: quiet for 90s and the turn ended. That reading of
 * quiet was wrong. `task_progress` fires *around* a nested tool call, never
 * during one — measured, the parent's stdout said nothing for the full 47.1s a
 * workflow agent spent inside a single `sleep 50`, and 33.2s was the worst gap
 * in a second run. So the deadline was really a cap on how long any one nested
 * tool call a workflow makes may take, which is not a thing this file can know.
 * `armGrace` now holds the turn while the CLI reports work outstanding, and
 * this is only how long it waits between looks.
 */
const BACKGROUND_TASK_GRACE_MS = 90 * 1000;

/**
 * How long the turn waits for the model to report on a task that just finished.
 *
 * A background task does not simply end. The CLI queues a synthetic
 * `<task-notification>` prompt naming it and opens a **fresh turn** to answer
 * it — that turn is where "Workflow completed. Result: …" comes from, and it is
 * the only sentence saying what the run produced. Measured on 2.1.219 across
 * two runs: the follow-up `system/init` landed ~1s after the launching turn's
 * `result`, and its own `result` 6s after that.
 *
 * Ending at the launching turn's `result` — which is what happens when the task
 * finished before it, as a short workflow always does — throws that turn away
 * unread. Every line the follow-up produces re-arms this budget, so it is paid
 * in full only when the CLI never follows up at all.
 */
const TASK_REPORT_GRACE_MS = 15 * 1000;

/** A CLI process that outlives the turn, plus the state needed to decide
 *  whether the next turn can reuse it or has to replace it. */
interface CliSession {
  child: ChildProcess;
  /** argv it was spawned with, compared through respawnFingerprint(). */
  args: string[];
  stderr: string;
  /** Where deltas go right now: the streaming turn, or nothing (out-of-turn). */
  sink: ((d: StreamDelta) => void) | null;
  processor: (ev: CliEvent) => StreamDelta[];
  exited: boolean;
  /** Last values pushed over the control channel, so a turn that changes
   *  neither sends nothing. */
  model: string | undefined;
  permissionMode: PermissionMode;
  /** True from the moment a turn is written until its `result` lands. An
   *  interrupted turn still emits one, later — writing the next turn before it
   *  arrives makes that stale `result` end the new turn instead. */
  busy: boolean;
  /** Resolvers waiting for `busy` to clear. */
  idleWaiters: Array<() => void>;
  /** Message ids we put on our own prompts, still waiting for the CLI to play
   *  them back. It echoes ours alongside the phone's, and this is what tells
   *  them apart — see takeEcho(). */
  pendingEchoes: Set<string>;
  /** The turn preamble this session has already been told, so an unchanged one
   *  is not repeated on every message — see `writeUserMessage`. */
  preamble?: string;
  /** The task-type playbook this process was spawned with. Held for the life of
   *  the session: it rides on `--append-system-prompt`, which cannot be changed
   *  on a running CLI, and reclassifying per turn replaced the process. */
  taskType?: TaskType;
  /** The posture this process was actually spawned with, against which a later
   *  turn's wishes are compared. Only for naming what is outstanding while a
   *  replacement is deferred — see `pendingSettings`. */
  spawnedWith: ClaudeCliOpts;
}

/** How long the next turn waits for an interrupted one to report its `result`
 *  before going ahead anyway. Long enough for an interrupt to land, short
 *  enough that a wedged CLI doesn't look like a frozen panel. */
const TURN_DRAIN_TIMEOUT_MS = 10_000;

/** An outbound control request waiting for its answer. */
interface PendingControl {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long a control request waits for its response. Enabling Remote Control
 *  is a round-trip to the Anthropic API, so this is generous — but bounded, or
 *  a lost response leaves the caller awaiting forever. */
const CONTROL_TIMEOUT_MS = 30_000;

export class ClaudeCliProvider implements ChatProvider {
  readonly id = "claude-cli";
  private child: ChildProcess | null = null;
  /** The long-lived process in session mode; null in the per-turn path. */
  private session: CliSession | null = null;
  /** Control requests *we* sent, awaiting their response. */
  private pendingControls = new Map<string, PendingControl>();
  /** What the user asked for. Deliberately outlives any one process: replacing
   *  the CLI drops the bridge (measured), so the next one has to re-establish
   *  it rather than come up silently disconnected. */
  private remoteControl: RemoteControlStatus = { state: "off" };
  private remoteControlName: string | undefined;
  /** What the user asked for, as opposed to what the bridge is currently
   *  doing. A dropped connection is still "wanted", which is what makes a
   *  replaced process bring the bridge back instead of coming up silent. */
  private remoteControlWanted = false;
  /** The enable request currently in flight. Shared rather than duplicated:
   *  spawning a session with the bridge already wanted fires one, and a caller
   *  asking to enable at the same moment must join it instead of sending a
   *  second — two requests mean two remote sessions for one conversation. */
  private remoteControlInFlight: Promise<RemoteControlStatus> | null = null;
  /** In-flight `can_use_tool` prompts keyed by control-request id. Holds the
   *  proposed input + suggestions so respondToPermission() can echo the input
   *  back on "allow" and honor the CLI's "accept this session" suggestion. */
  private pendingPermissions = new Map<string, PermissionRequestPayload>();
  /** In-flight `request_user_dialog`s, by control-request id. Its own map, so
   *  a cancel that clears a permission cannot take a dialog with it. */
  private pendingDialogs = new Map<string, UserDialogPayload>();
  /** Set while a turn is streaming: ends the stream immediately (so cancel
   *  doesn't have to wait for the child's exit event, which can lag when the
   *  turn is paused on a permission prompt or the CLI has MCP subprocesses). */
  private abortCurrent: (() => void) | null = null;
  /** Set true when the user picks "Allow this turn" on an edit. We then
   *  auto-approve reversible edit tools for the rest of THIS turn ourselves —
   *  WITHOUT switching the CLI to acceptEdits, which would also auto-run every
   *  Bash command (incl. `rm`) and silently disable the destructive gate. */
  private autoAllowEdits = false;
  /**
   * The permission mode the running CLI reported at `system/init` — the mode it
   * actually took, which is not always the one we asked for.
   *
   * `auto` can be refused: the account's rollout, the model, or a
   * `disableAutoMode` policy each turn it off, and measured against 2.1.219 the
   * CLI then downgrades **in silence** — no error, no warning, and `init`
   * carrying `permissionMode: "default"` instead. This field is the only place
   * that difference is visible, and `nativeAutoLive()` is what reads it.
   *
   * Cleared on every spawn: a mode belongs to the process that announced it.
   */
  private cliPermissionMode: string | undefined;

  constructor(private opts: ClaudeCliOpts) {}

  /**
   * True when the CLI is running its own classifier for this conversation, so
   * a `can_use_tool` arriving here is something it declined to judge rather
   * than the first look anyone has had at the call.
   *
   * Unknown counts as live. Before `init` lands there is nothing to read, and
   * the two ways of being wrong are not symmetric: guessing "the CLI decides"
   * costs an approval card for something that would have passed, guessing the
   * other way auto-approves a call the classifier escalated on purpose.
   */
  private nativeAutoLive(): boolean {
    if ((this.opts.permissionMode ?? "default") !== "auto") return false;
    return (
      this.cliPermissionMode === undefined || this.cliPermissionMode === "auto"
    );
  }

  /** Record what `system/init` says the mode is. Read off the raw line rather
   *  than through the processor because only the permission path wants it. */
  private noteEffectiveMode(ev: CliEvent): void {
    if (ev.type !== "system" || ev.subtype !== "init") return;
    if (typeof ev.permissionMode !== "string") return;
    this.cliPermissionMode = ev.permissionMode;
    const asked = mapPermissionMode(this.opts.permissionMode ?? "default");
    if (ev.permissionMode !== asked) {
      logInfo(
        `[luno] the CLI took permission mode ${ev.permissionMode}, not ${asked} — falling back to Luno's own policy`
      );
    }
  }

  cancel() {
    // End the async stream *now* — don't wait for the SIGTERM→exit round-trip.
    // While a turn is paused on a permission prompt no deltas are flowing, so
    // the consumer's cancel check only re-runs once we push something.
    this.abortCurrent?.();
    // A turn this panel did not start has no `abortCurrent` to do it, and the
    // interrupt below is not documented to withdraw a `can_use_tool` the CLI is
    // already blocked on. Left unanswered it blocks forever with no card left
    // on screen to answer it.
    this.denyPendingPermissions("Cancelled by the user.");
    this.cancelPendingDialogs();
    // In session mode the process is the session: killing it would end the
    // conversation and drop any Remote Control bridge, when all the user asked
    // for was to stop this turn. Interrupt over the control channel instead.
    if (this.session && !this.session.exited) {
      void this.interruptReturningQueued();
      return;
    }
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      setTimeout(() => this.child?.kill("SIGKILL"), 2000);
    }
  }

  /**
   * Deny every approval still outstanding, so the CLI stops waiting on a
   * question nobody can answer any more.
   *
   * Called from all three cancel paths. A prompt left hanging blocks the tool
   * call it guards for as long as the process lives, and the card carrying it
   * is gone from the panel the moment the turn ends.
   */
  private denyPendingPermissions(message: string): void {
    for (const id of this.pendingPermissions.keys()) {
      this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: id,
          response: { behavior: "deny", message }
        }
      });
    }
    this.pendingPermissions.clear();
  }

  /**
   * Answer a pending permission prompt. Writes the matching `control_response`
   * back to the CLI over stdin so the blocked tool call can proceed (allow) or
   * be rejected (deny). No-op if the turn already ended.
   *
   * `opts.updatedInput` replaces the input the CLI proposed. For most tools
   * there is nothing to replace and it is omitted; for `AskUserQuestion` it is
   * the entire point, since that tool's result is the input it was handed back.
   *
   * `opts.reason` is what the user typed instead of just refusing. It changes
   * the denial's wording rather than being appended to it — see
   * {@link denialMessage}.
   */
  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    opts?: {
      restOfTurn?: boolean;
      updatedInput?: Record<string, unknown>;
      reason?: string;
    }
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    // No matching pending prompt → this is a duplicate or stale answer (the
    // turn moved on, or the user double-clicked). Ignore it: responding again
    // is at best a no-op and at worst sends an empty `updatedInput`, which
    // would make an "allow" silently run the tool with no arguments.
    if (!pending) {
      logInfo(
        `[luno] permission response for unknown id ${requestId} — ignored`
      );
      return;
    }
    this.pendingPermissions.delete(requestId);
    let delivered: boolean;
    if (behavior === "allow") {
      const edited = opts?.updatedInput;
      // An edited call is a different call, and the approval the user just gave
      // was for the one on the card. Re-classify before it goes anywhere: `ls`
      // turned into `rm -rf /` inside an already-open card must not inherit the
      // decision that was made about `ls`. The card comes back carrying the new
      // reading, and a deliberate second Allow sends it — which is exactly the
      // gate a destructive call is supposed to pass through.
      if (edited && this.raiseEditedAgain(requestId, pending, edited)) return;
      delivered = this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          // The CLI requires the (possibly edited) input echoed back. A caller
          // that edited it says so; everyone else gets the original proposal.
          response: {
            behavior: "allow",
            updatedInput: edited ?? pending.input ?? {}
          }
        }
      });
      // "Allow for the rest of this turn" — auto-approve further EDITS ourselves
      // (see handleControlRequest). We deliberately do NOT send the CLI's
      // suggested `set_permission_mode acceptEdits`: that mode also auto-runs
      // every Bash command (including `rm`/`curl`) with no prompt, which would
      // silently disable the destructive/network gate for the rest of the turn.
      if (opts?.restOfTurn) {
        this.autoAllowEdits = true;
      }
    } else {
      delivered = this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "deny",
            message: denialMessage(opts?.reason)
          }
        }
      });
    }
    // Logged after the write, and saying which of the two happened. Written
    // before, this line claimed every approval reached the CLI — including the
    // ones answered into a process that had already exited, which is the case
    // a background agent's card makes reachable.
    logInfo(
      delivered
        ? `[luno] permission ${behavior} for ${pending.toolName} (${requestId})`
        : `[luno] permission ${behavior} for ${pending.toolName} went nowhere — the CLI process is gone`
    );
  }

  /**
   * An edited "allow" whose new input reads more dangerous than the one on the
   * card. Puts the prompt back, carrying the new reading, and answers nothing.
   *
   * Returns true when it did that, meaning the caller must not send the allow.
   *
   * Why re-ask rather than refuse: the edit is the user's own, and refusing it
   * would be the client second-guessing them. What must not happen is the
   * *original* approval carrying a call it was never given for. One re-ask
   * settles both — `pendingPermissions` now holds the edited input, so a
   * deliberate second Allow sends it unchanged and this returns false.
   *
   * Only escalation re-asks. An edit that makes a call safer (`rm -rf x` into
   * `ls x`) goes straight through: the user already had approval for the worse
   * of the two.
   */
  private raiseEditedAgain(
    requestId: string,
    pending: PermissionRequestPayload,
    edited: Record<string, unknown>
  ): boolean {
    const before = pending.destructive === true || pending.network === true;
    if (before) return false;
    const destructive = isDestructiveRequest(pending.toolName, edited);
    const network = isNetworkRequest(pending.toolName, edited);
    if (!destructive && !network) return false;

    const next: PermissionRequestPayload = {
      ...pending,
      input: edited,
      destructive,
      network,
      // The CLI wrote it about the call it proposed. Measured in a live run:
      // an edited `rm -rf node_modules` came back still captioned "Create
      // probe-dir directory" — a description of the command it is not.
      description: undefined,
      // Both are unofferable on a destructive or network call anyway; naming it
      // here keeps the re-asked card from reading as the one just answered.
      grantLabel: undefined,
      suggestions: []
    };
    this.pendingPermissions.set(requestId, next);
    logInfo(
      `[luno] edited ${pending.toolName} re-classified as ${destructive ? "destructive" : "network"} — asking again`
    );
    const d: StreamDelta = { type: "permission_request", permission: next };
    if (this.session?.sink) this.session.sink(d);
    else this.opts.onOutOfTurn?.(d);
    return true;
  }

  /** @returns false when the child is gone and the answer went nowhere. The
   *  bare write this used to be reported an approval into a closed pipe as
   *  success — the one thing a permission answer must never do. */
  private writeControl(obj: unknown): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Answer a control request this client does not implement.
   *
   * An empty success is not a neutral acknowledgement — for several subtypes
   * it is a malformed answer that claims we did something. Each one that has a
   * defined "I cannot" is given that instead:
   *
   * - `elicitation` — an MCP server asking the user for input mid-call. The
   *   SDK's own answer with no handler is `{action:"decline"}`; `{}` tells the
   *   server we succeeded at a prompt nobody saw.
   * `request_user_dialog` is handled properly by {@link raiseUserDialog} and
   * never reaches here for a kind we declared. A kind we did not — the CLI
   * should not send one, but the list is its bookkeeping, not ours — is
   * answered with the cancel every dialog defaults to anyway.
   *
   * Everything else keeps the empty ack, which is right for the subtypes that
   * only want to know we are alive.
   */
  private answerUnhandledRequest(requestId: string, subtype?: string): void {
    const response =
      subtype === "elicitation" ? { action: "decline" } : ({} as const);
    this.writeControl({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response }
    });
  }

  /**
   * A dialog the CLI is blocked on: not a tool call, a decision.
   *
   * Held like a permission — the id has to survive until someone answers, and
   * the CLI can withdraw it — but kept in its own map so a cancel that clears
   * one cannot take the other with it.
   */
  private raiseUserDialog(
    requestId: string,
    req: NonNullable<CliEvent["request"]>,
    push: (d: StreamDelta) => void
  ): void {
    const kind = req.dialog_kind;
    // Only what we declared. Anything else is answered with its own default
    // rather than shown: a card we cannot draw is worse than none, because it
    // is the thing holding the turn.
    if (
      !kind ||
      !(SUPPORTED_DIALOG_KINDS as readonly string[]).includes(kind)
    ) {
      logInfo(`[luno] dialog ${kind ?? "?"} not declared — cancelling`);
      this.respondToDialog(requestId, undefined, { force: true });
      return;
    }
    const dialog: UserDialogPayload = {
      requestId,
      kind: kind as DialogKind,
      payload: req.payload ?? {},
      toolUseId: req.tool_use_id
    };
    this.pendingDialogs.set(requestId, dialog);
    logInfo(`[luno] dialog needed: ${kind} — awaiting user`);
    push({ type: "user_dialog", dialog });
  }

  /**
   * Answer a dialog. `result` absent means cancelled, which is what every kind
   * falls back to and what a closed panel, a dead turn or a rewind must send.
   *
   * `force` answers an id we are no longer holding — used when declining a
   * kind we never took, where there is nothing to forget.
   */
  respondToDialog(
    requestId: string,
    result?: unknown,
    opts?: { force?: boolean }
  ): void {
    if (!this.pendingDialogs.delete(requestId) && !opts?.force) {
      logInfo(`[luno] dialog response for unknown id ${requestId} — ignored`);
      return;
    }
    logInfo(
      `[luno] dialog ${result === undefined ? "cancelled" : String(result)} (${requestId})`
    );
    this.writeControl({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response:
          result === undefined
            ? { behavior: "cancelled" }
            : { behavior: "completed", result }
      }
    });
  }

  /** Cancel every dialog still outstanding. A dialog nobody can answer any
   *  more holds the CLI exactly as a permission would.
   *
   *  A proposed diff waiting in the editor is the same shape of debt — the
   *  tool call is parked on a decision the user is no longer going to make —
   *  so it is withdrawn here rather than in a place of its own. */
  private cancelPendingDialogs(): void {
    for (const id of [...this.pendingDialogs.keys()]) {
      this.respondToDialog(id);
    }
    this.opts.onAbortIdeWork?.("the turn was cancelled");
  }

  /**
   * Serve one JSON-RPC message for an in-process MCP server.
   *
   * The reply rides inside the control response as `mcp_response` — the
   * envelope read out of the reference's own handler. Nothing here rejects: an
   * unknown server or a failing tool comes back as a JSON-RPC error, because
   * the alternative is a turn that hangs on a request nobody answered.
   */
  private async answerMcpMessage(
    requestId: string,
    req: NonNullable<CliEvent["request"]>
  ): Promise<void> {
    const mcpResponse = await handleIdeMcpMessage(
      req.server_name,
      req.message,
      this.opts.ideOps
    );
    if (mcpResponse.error) {
      logInfo(
        `[luno] mcp ${req.server_name ?? "?"}/${req.message?.method ?? "?"} → ${mcpResponse.error.message}`
      );
    }
    this.writeControl({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { mcp_response: mcpResponse }
      }
    });
  }

  /** Route a CLI control request. `can_use_tool` becomes a permission prompt;
   *  anything else is answered by {@link answerUnhandledRequest}. */
  private handleControlRequest(
    ev: CliEvent,
    push: (d: StreamDelta) => void
  ): void {
    const requestId = ev.request_id;
    const req = ev.request;
    if (requestId && req?.subtype === "request_user_dialog") {
      this.raiseUserDialog(requestId, req, push);
      return;
    }
    if (requestId && req?.subtype === "mcp_message") {
      void this.answerMcpMessage(requestId, req);
      return;
    }
    if (!requestId || !req || req.subtype !== "can_use_tool") {
      if (requestId) this.answerUnhandledRequest(requestId, req?.subtype);
      return;
    }
    const toolName = req.tool_name ?? "tool";
    const interactive = req.requires_user_interaction === true;
    // Agent mode has two implementations and exactly one of them is in force.
    // With the CLI's classifier live our policy steps back to the rungs that
    // carry a user's own decision; without it, our policy is Agent mode.
    const cliClassified = this.nativeAutoLive();
    if (cliClassified) {
      logInfo(
        `[luno] auto mode escalated ${toolName} (${req.decision_reason_type ?? "no reason given"})`
      );
    }
    const { action, destructive, network } = decidePermission(
      toolName,
      req.input,
      {
        autoAllowEdits: this.autoAllowEdits,
        agentMode:
          (this.opts.permissionMode ?? "default") === "auto" && !cliClassified,
        cliClassified,
        grants: this.opts.getToolGrants?.(),
        interactive,
        // The session's own mode, not the setting: Proceed changes the setting
        // and respawns, so mid-turn the live process is the only truth here.
        planMode:
          (this.session?.permissionMode ??
            this.opts.permissionMode ??
            "default") === "plan"
      }
    );
    if (action === "allow") {
      this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: { behavior: "allow", updatedInput: req.input ?? {} }
        }
      });
      return;
    }
    if (action === "deny") {
      logInfo(`[luno] ${toolName} refused — staying in plan mode`);
      this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          // No `interrupt`, unlike the reference client. Interrupting takes
          // every running background agent with it, and the message alone
          // already tells the model to keep planning.
          response: { behavior: "deny", message: STAYED_IN_PLAN_MODE }
        }
      });
      return;
    }
    const payload: PermissionRequestPayload = {
      requestId,
      toolName,
      toolUseId: req.tool_use_id,
      input: req.input ?? {},
      description: req.description,
      destructive,
      network,
      suggestions: (req.permission_suggestions ?? []) as PermissionSuggestion[],
      // The CLI can say a standing grant is off the table for this call. It
      // knows things we do not — the rule that routed it here, whether the
      // classifier could approve it — so an "Always" button offered against
      // its wishes is one whose promise we cannot keep.
      grantLabel:
        req.suppress_always_allow_rule === true
          ? undefined
          : offeredGrantLabel(
              toolName,
              req.input,
              destructive,
              network,
              interactive
            ),
      ...(req.agent_id ? { agentId: req.agent_id } : {}),
      // Read per request rather than at spawn: the file is small, this path
      // runs a handful of times a turn, and a setting changed mid-session
      // should not need a window reload to take effect.
      ...((INTERACTIVE_TOOLS.has(toolName) || interactive) && afkTimeout())
    };
    this.pendingPermissions.set(requestId, payload);
    logInfo(
      `[luno] permission needed: ${toolName}${destructive ? " (destructive)" : network ? " (network)" : ""} — awaiting user`
    );
    push({ type: "permission_request", permission: payload });
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamDelta> {
    const content = lastUserContent(req.messages);
    if (content === null || (typeof content === "string" && !content)) {
      yield { type: "error", error: "No user message to send." };
      return;
    }
    // Argv and the classifier want words; the CLI wants the content. A message
    // that is only an attachment has none of the first and all of the second.
    const userText = textOf(content);

    // Fresh per turn: a prior "allow edits this turn" must not leak into the next.
    this.autoAllowEdits = false;

    if (this.opts.sessionMode) {
      yield* this.streamInSession(req, content);
      return;
    }

    const args = buildArgs(userText, req.model, this.opts);

    const child = spawn(this.opts.binary, args, {
      cwd: this.opts.cwd,
      env: this.childEnv(req.maxTokens),
      // stdin is a pipe in every mode. It carries the prompt, it carries
      // control responses where the protocol is live, and — the reason it is
      // no longer conditional — an open stdin is what keeps the CLI out of the
      // print wind-down that terminates background work. See buildArgs.
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    // A mode belongs to the process that announced it; this one has not spoken.
    this.cliPermissionMode = undefined;

    // Deliver the user turn as a stream-json message. stdin is intentionally
    // left OPEN — it is closed by endTurn(), which is what ends the turn.
    if (child.stdin) {
      const userMsg = JSON.stringify({
        type: "user",
        message: { role: "user", content }
      });
      try {
        child.stdin.write(userMsg + "\n");
      } catch {
        /* spawn race — the exit/error handlers below surface it. */
      }
    }

    // Subagents launched with `run_in_background` that have not reported a
    // terminal status. Declared here because the silence watchdog below reads
    // it: a turn running background work is not wedged just because it is
    // quiet.
    const openTasks = new Set<string>();
    /**
     * How many background tasks the CLI itself says are registered, from its
     * `background_tasks_changed` roster.
     *
     * A second, independent answer to "is anything still running", and the
     * authoritative one — `openTasks` is our own bookkeeping off `task_*`
     * events, and twice now it has read empty while a workflow was demonstrably
     * alive, letting the grace timer end the turn and kill it at ten minutes.
     * Either source saying "busy" is enough to hold the turn.
     */
    let rosterSize = 0;
    /** Whether anything is still running, by either account. */
    const busyWithTasks = () => openTasks.size > 0 || rosterSize > 0;

    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    const clearSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = undefined;
    };
    /** (Re)start the countdown from this moment — the child just showed a sign
     *  of life, so the budget it gets is measured from here. */
    const armSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        // A workflow is silent by construction. Its agents report on state
        // change, not on a clock, so a phase whose agents are each grinding
        // through one long tool call produces nothing on stdout for as long as
        // that takes. Measured: a 4-agent phase reading a 265 MB binary went
        // quiet for ten minutes and was SIGKILLed here — all four sidechains
        // recorded `[Request interrupted by user]` within 10ms of each other,
        // ten minutes of work lost, and nothing anywhere said why.
        //
        // Nothing outside the CLI can tell that apart from a wedge, so while
        // the CLI says work is outstanding it gets the benefit of the doubt.
        // Stop is the user's lever, and it always was.
        if (busyWithTasks()) {
          armSilence();
          return;
        }
        // Never silently. This kill used to leave no log line, no error and no
        // trace in the transcript, which is the only reason it took three
        // sessions to find.
        logInfo(
          "[luno] claude produced nothing for the silence budget; killing it"
        );
        push({
          type: "error",
          error:
            "The Claude CLI stopped responding and was ended. Nothing it had " +
            "not already sent was recovered."
        });
        child.kill("SIGKILL");
        // Not waiting on `exit`: the thing being killed is by definition not
        // responding, and a turn that hangs on its death rattle is the bug
        // over again. Same reason the tool-stall watchdog ends the turn itself.
        push({ type: "done" });
      }, this.opts.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS);
    };

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity
    });
    let stderrBuf = "";
    child.stderr!.on("data", (b: Buffer) => {
      armSilence();
      stderrBuf += b.toString("utf8");
    });
    armSilence();

    const queue: StreamDelta[] = [];
    let resolver: (() => void) | null = null;
    let done = false;
    // Declared before push so push can route deltas through it; assigned just
    // below (its onStall handler calls push, so the two reference each other).
    let stallWatch: ToolStallWatchdog | null = null;
    const push = (d: StreamDelta) => {
      stallWatch?.observe(d);
      queue.push(d);
      resolver?.();
      resolver = null;
    };

    // Per-tool stall watchdog: if a latency-bounded tool (WebFetch/WebSearch)
    // never returns a result, surface a timeout result so the UI spinner clears
    // and stop the wedged CLI — instead of spinning until SILENCE_TIMEOUT_MS. The
    // CLI can't be told to abandon a single hung tool, so killing it (ending
    // the turn) is the only recovery.
    stallWatch = createToolStallWatchdog({
      timeoutMs: this.opts.toolStallMs ?? WEB_TOOL_STALL_MS,
      onStall: (toolId, toolName, ms) => {
        const secs = Math.round(ms / 1000);
        push({
          type: "tool_result",
          toolUseId: toolId,
          resultContent: `${toolName} did not respond within ${secs}s and was stopped. Try again, or use a more specific URL.`,
          resultIsError: true
        });
        if (this.child && !this.child.killed) {
          this.child.kill("SIGTERM");
          const c = this.child;
          setTimeout(() => {
            if (c && !c.killed) c.kill("SIGKILL");
          }, 2000);
        }
        push({ type: "done" });
      }
    });

    // Cancellation hook (see cancel()). Deny any outstanding prompt so the CLI
    // unblocks gracefully, then push `done` so the generator returns on its
    // next tick regardless of when the child actually exits.
    this.abortCurrent = () => {
      this.denyPendingPermissions("Cancelled by the user.");
      this.cancelPendingDialogs();
      stallWatch?.clearAll();
      // Routed through endTurn so a pending background-agent grace timer is
      // cleared too — Stop must not leave one armed to fire a minute later.
      endTurn();
    };

    const processor = makeProcessor(
      this.opts.setResumeSessionId,
      this.opts.onSlashCommands
    );

    // While any task is open the turn is deliberately held past `result` — see
    // BACKGROUND_TASK_GRACE_MS for what that buys. `openTasks` itself is
    // declared above, with the silence watchdog that also reads it.
    /** A task has finished and the model has not said anything since — so the
     *  turn the CLI opens to report it has not run yet. See
     *  TASK_REPORT_GRACE_MS. */
    let pendingTaskReport = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let turnEnded = false;

    const endTurn = () => {
      if (turnEnded) return;
      turnEnded = true;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = undefined;
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      push({ type: "done" });
    };

    /** (Re)start the countdown from this moment — something just showed a sign
     *  of life, so the budget it gets is measured from here. */
    const armGrace = (ms: number) => {
      if (turnEnded) return;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        // Quiet is not evidence, and this is where believing it cost ten
        // minutes of work. Measured: the parent's stdout is silent for the
        // *whole* of a nested tool call — 47.1s across one `sleep 50` inside a
        // workflow agent — so a run doing anything slow looks exactly like a
        // run doing nothing. While the CLI still says work is outstanding the
        // turn is held rather than ended, the same benefit of the doubt the
        // silence watchdog gives, and for the same reason: ending here closes
        // stdin and the `finally` SIGTERMs the process, taking the work with
        // it. Stop is the user's lever.
        if (busyWithTasks()) {
          logInfo(
            `[luno] quiet, but ${openTasks.size} task(s) tracked and ${rosterSize} on the CLI roster; holding the turn`
          );
          armGrace(ms);
          return;
        }
        logInfo("[luno] quiet with nothing outstanding; ending the turn");
        endTurn();
      }, ms);
    };

    /** How long to wait before looking again. While work is outstanding this is
     *  only a re-check interval — see armGrace, which holds rather than ends —
     *  and otherwise it is the whole budget the model's report on a finished
     *  task gets. */
    const graceBudget = () =>
      busyWithTasks()
        ? (this.opts.backgroundGraceMs ?? BACKGROUND_TASK_GRACE_MS)
        : (this.opts.taskReportGraceMs ?? TASK_REPORT_GRACE_MS);

    let sawResult = false;

    rl.on("line", (line) => {
      armSilence();
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: CliEvent;
      try {
        ev = JSON.parse(trimmed) as CliEvent;
      } catch {
        return;
      }
      this.noteEffectiveMode(ev);
      // Bidirectional control protocol (only live with --permission-prompt-tool
      // stdio). Handled here rather than in the pure event processor because
      // answering a request means writing back to the child's stdin.
      if (ev.type === "control_request") {
        this.handleControlRequest(ev, push);
        return;
      }
      // Acks to control requests *we* sent (e.g. set_permission_mode) — ignore.
      if (ev.type === "control_response") return;
      // The CLI's own roster of registered background work. Read here rather
      // than through the processor because nothing downstream needs it — it
      // exists so the turn-end timers have a source of truth that is not our
      // own `task_*` bookkeeping.
      if (ev.type === "system" && ev.subtype === "background_tasks_changed") {
        rosterSize = ev.tasks?.length ?? 0;
        logInfo(`[luno] CLI roster: ${rosterSize} background task(s)`);
      }
      for (const d of processor(ev)) {
        push(d);
        // Anything the model says settles the report a finished task is owed.
        // Read before the task branch so a notification arriving in the same
        // line cannot be cleared by output that preceded it.
        if (d.type === "text" || d.type === "tool_use_start") {
          pendingTaskReport = false;
        }
        if (d.type !== "task" || !d.task) continue;
        const { phase, taskId, status } = d.task;
        if (phase === "started") {
          openTasks.add(taskId);
          logInfo(`[luno] task opened: ${taskId} (${openTasks.size} open)`);
        } else if (phase === "notification" || isTerminalTaskStatus(status)) {
          openTasks.delete(taskId);
          pendingTaskReport = true;
          logInfo(`[luno] task closed: ${taskId} (${openTasks.size} open)`);
        }
      }
      // Under stream-json input the CLI keeps the session open for more input
      // after the turn, so closing stdin is what actually ends it. Held while a
      // backgrounded agent is still running: closing here kills it mid-step and
      // throws away work the user is watching a card for.
      //
      // The CLI emits a `result` per stretch of work, not one per turn. When an
      // agent answers, the model picks the conversation back up and reports what
      // came back — measured on 2.1.220, a second `result` followed the first by
      // ten seconds with a whole paragraph in between. Ending on the last agent
      // rather than on that second `result` cut the model off mid-sentence.
      // Recorded separately from the branch below because `onExit` reads it to
      // tell a turn that failed from a process that exited after answering.
      if (ev.type === "result") {
        sawResult = true;
        // A task that finished *before* this `result` leaves the turn owed one
        // more: the CLI answers its own `<task-notification>` in a fresh turn,
        // and that turn holds the only account of what the task produced.
        // Short workflows always land this way — ending here discarded it.
        if (!busyWithTasks() && !pendingTaskReport) endTurn();
        else armGrace(graceBudget());
        return;
      }
      // Past the first `result` the turn stays alive for the agents and for
      // whatever the model says once they answer. Any sign of either resets the
      // budget, so only real silence ends it.
      if (sawResult) armGrace(graceBudget());
    });

    const onExit = () => {
      clearSilence();
      stallWatch?.clearAll();
      const said = usefulStderr(stderrBuf);
      if (child.exitCode !== 0 && child.signalCode !== "SIGTERM") {
        const msg = exitFailure(stderrBuf, child.exitCode, sawResult);
        if (msg) push({ type: "error", error: msg });
      } else if (said.length) {
        // Never drop what the CLI said just because it left politely.
        logInfo(
          `[luno] claude exited ${child.exitCode ?? "?"} saying: ${said.join(" ")}`
        );
      }
      // A clean exit is still bad news when it takes running work with it, and
      // the CLI does explain itself: `Background tasks still running after
      // 600s; terminating.` was on stderr every time, and reading stderr only
      // on a bad exit code is why finding that cost four sessions. Not for our
      // own SIGTERM — that one is Stop, and the user knows.
      if (child.signalCode !== "SIGTERM" && busyWithTasks() && said.length) {
        push({ type: "error", error: said.join("\n") });
      }
      push({ type: "done" });
      done = true;
      resolver?.();
      resolver = null;
    };
    child.once("exit", onExit);
    child.once("error", (err) => {
      push({ type: "error", error: err.message });
    });

    try {
      while (true) {
        while (queue.length > 0) {
          const d = queue.shift()!;
          yield d;
          if (d.type === "done") return;
        }
        if (done) return;
        await new Promise<void>((res) => {
          resolver = res;
        });
      }
    } finally {
      clearSilence();
      stallWatch?.clearAll();
      this.abortCurrent = null;
      this.pendingPermissions.clear();
      // Wait for the process to fully exit before the turn ends — otherwise the
      // next turn's `--resume` races a still-alive CLI for the same session.
      await terminateChild(child);
      this.child = null;
    }
  }

  /**
   * One turn inside a process that outlives it.
   *
   * The reader is attached to the session rather than to the turn, so anything
   * the CLI emits between turns — a phone driving the same session — is still
   * read off the pipe and handed to `onOutOfTurn` instead of being dropped on
   * the floor or, worse, left to fill the pipe buffer.
   */
  private async *streamInSession(
    req: ProviderRequest,
    content: string | ContentBlock[]
  ): AsyncIterable<StreamDelta> {
    // The task-type playbook is classified from the prompt, so it changes the
    // moment the conversation shifts subject — and it reaches the CLI as
    // `--append-system-prompt`, which a live process cannot be told about. Left
    // to vary it replaced the process mid-conversation, which under Remote
    // Control means a new session URL and a phone that goes quiet. A running
    // session keeps the playbook it was spawned with; the next process picks up
    // whatever is current.
    // A live session keeps the playbook it was spawned with — *including none*.
    // The `??` this replaces could not tell "spawned without one" from "not
    // set", so a process the `/rc` toggle spawned before any turn had been
    // classified got a task-type `--append-system-prompt` on its very next
    // turn, differing argv, and a replacement. The cost is a conversation
    // started that way running without a playbook until its process is next
    // replaced, which is the trade the paragraph above already makes.
    const live = this.session?.exited ? null : this.session;
    const taskType = live ? live.taskType : this.opts.taskType;
    const args = buildArgs(textOf(content), req.model, {
      ...this.opts,
      taskType
    });
    let session: CliSession;
    try {
      session = this.ensureSession(args, req, taskType);
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err)
      };
      return;
    }

    const queue: StreamDelta[] = [];
    let resolver: (() => void) | null = null;
    let ended = false;
    let stallWatch: ToolStallWatchdog | null = null;
    /** Prompts raised while this turn held the sink — the ones it may retire
     *  when it ends. One raised out of turn belongs to nobody's turn. */
    const raisedHere = new Set<string>();
    const push = (d: StreamDelta) => {
      stallWatch?.observe(d);
      if (d.type === "done") ended = true;
      if (d.type === "permission_request" && d.permission) {
        raisedHere.add(d.permission.requestId);
      }
      queue.push(d);
      resolver?.();
      resolver = null;
    };

    // Same contract as the per-turn watchdog, one difference: a wedged tool
    // must not take the process with it. Killing the child here would end the
    // session and drop any Remote Control bridge, so the turn is interrupted
    // over the control channel instead.
    stallWatch = createToolStallWatchdog({
      timeoutMs: this.opts.toolStallMs ?? WEB_TOOL_STALL_MS,
      onStall: (toolId, toolName, ms) => {
        const secs = Math.round(ms / 1000);
        push({
          type: "tool_result",
          toolUseId: toolId,
          resultContent: `${toolName} did not respond within ${secs}s and was stopped. Try again, or use a more specific URL.`,
          resultIsError: true
        });
        this.interrupt();
        push({ type: "done" });
      }
    });

    this.abortCurrent = () => {
      this.denyPendingPermissions("Cancelled by the user.");
      this.cancelPendingDialogs();
      stallWatch?.clearAll();
      push({ type: "done" });
    };

    // A turn the user cancelled is over for us but not yet for the CLI: its
    // `result` is still on the way. Writing now would let that stale result
    // end this turn before it has said anything.
    await waitUntilIdle(session);

    // Stop pressed while we waited. `abortCurrent` has already queued this
    // turn's `done`, and writing now would send a prompt the user cancelled
    // into a turn nothing is reading. Falling through rather than returning, so
    // that queued `done` still reaches the caller.
    if (!ended) {
      session.sink = push;
      session.busy = true;
      const uuid = this.writeUserMessage(session, content);
      if (!uuid) {
        session.sink = null;
        this.abortCurrent = null;
        yield {
          type: "error",
          error: "The Claude session is no longer accepting input."
        };
        return;
      }
    }

    try {
      while (true) {
        while (queue.length > 0) {
          const d = queue.shift()!;
          yield d;
          if (d.type === "done") return;
        }
        if (ended) return;
        await new Promise<void>((res) => {
          resolver = res;
        });
      }
    } finally {
      stallWatch?.clearAll();
      this.abortCurrent = null;
      // Only this turn's prompts. A background agent outlives the turn that
      // launched it, so the one it raises minutes later has no turn to end —
      // clearing the whole map here destroyed its request id and left the CLI
      // blocked on an answer nobody could give any more.
      for (const id of raisedHere) this.pendingPermissions.delete(id);
      // Hand the reader back to the out-of-turn sink. Guarded because a turn
      // that overlapped a replacement session must not detach the new one.
      if (session.sink === push) session.sink = null;
    }
  }

  /**
   * The live session, spawning or replacing it as needed.
   *
   * A process is replaced when argv changes in a way the control protocol
   * cannot express — `--effort` above all, which has no `set_effort`. The
   * conversation survives that (`--resume` carries it), but a Remote Control
   * bridge does not: it has to be re-established afterwards.
   */
  /**
   * @param taskType the playbook `args` were built with, recorded on the
   *   session so the next turn can keep using it rather than reclassifying and
   *   replacing the process underneath a connected device.
   */
  private ensureSession(
    args: string[],
    req: ProviderRequest | undefined,
    taskType?: TaskType
  ): CliSession {
    const live = this.session;
    if (live && !live.exited) {
      if (respawnFingerprint(live.args) === respawnFingerprint(args)) {
        if (req) this.applyLiveOptions(live, req);
        return live;
      }
      // A replacement kills every background agent in the process, and the
      // user changing effort was not asking for that. Hold the old argv until
      // the work drains: `buildArgs` runs again next turn, so nothing needs
      // storing — the difference is simply re-found once it is safe to act on.
      // Whatever the control channel *can* carry still goes now.
      if (this.opts.hasLiveWork?.()) {
        logInfo(
          `[luno] session options changed but work is outstanding — deferring: ${argvDiff(live.args, args)}`
        );
        if (req) this.applyLiveOptions(live, req);
        this.opts.onSettingsPending?.(
          pendingSettings(live.spawnedWith, this.opts)
        );
        return live;
      }
      // Names the flag rather than just the fact. A replacement is invisible
      // from the panel and expensive under Remote Control — it hands the phone
      // a session URL it is not holding — so when one happens the log has to
      // say which option did it, or the next report is another round of
      // guessing.
      logInfo(
        `[luno] session options changed — replacing the CLI process: ${argvDiff(live.args, args)}`
      );
      this.disposeSession();
    }

    const child = spawn(this.opts.binary, args, {
      cwd: this.opts.cwd,
      env: this.childEnv(req?.maxTokens),
      stdio: ["pipe", "pipe", "pipe"]
    });
    // A mode belongs to the process that announced it; this one has not spoken.
    this.cliPermissionMode = undefined;
    const session: CliSession = {
      child,
      args,
      stderr: "",
      sink: null,
      processor: makeProcessor(
        this.opts.setResumeSessionId,
        this.opts.onSlashCommands
      ),
      exited: false,
      model: req?.model,
      permissionMode: this.opts.permissionMode ?? "default",
      taskType,
      busy: false,
      idleWaiters: [],
      pendingEchoes: new Set(),
      spawnedWith: this.opts
    };
    this.session = session;
    this.child = child;
    // A fresh process is honouring everything, whatever it was failing to
    // honour a moment ago.
    this.opts.onSettingsPending?.([]);

    child.stderr?.on("data", (b: Buffer) => {
      session.stderr += b.toString("utf8");
    });

    const route = (d: StreamDelta) => {
      if (session.sink) session.sink(d);
      else this.opts.onOutOfTurn?.(d);
    };

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: CliEvent;
      try {
        ev = JSON.parse(trimmed) as CliEvent;
      } catch {
        return;
      }
      this.noteEffectiveMode(ev);
      if (ev.type === "control_request") {
        this.handleControlRequest(ev, route);
        return;
      }
      // A prompt answered on the phone cancels the request we are still
      // holding. Drop it, or the panel keeps showing a card whose answer would
      // be written against a request id the CLI has already forgotten.
      //
      // The withdrawn request rides along: the CLI says only which id is gone,
      // and by the time the panel hears about it the payload naming the tool
      // has been dropped here.
      if (ev.type === "control_cancel_request") {
        const withdrawn = ev.request_id
          ? this.pendingPermissions.get(ev.request_id)
          : undefined;
        if (ev.request_id && this.pendingPermissions.delete(ev.request_id)) {
          route({
            type: "permission_resolved",
            requestId: ev.request_id,
            permission: withdrawn
          });
        }
        // Dialogs are withdrawn the same way, and more often: the CLI retires
        // one the moment a new user message makes it moot. No response goes
        // back — the id is already forgotten on its side.
        if (ev.request_id && this.pendingDialogs.delete(ev.request_id)) {
          route({ type: "user_dialog_resolved", requestId: ev.request_id });
        }
        return;
      }
      if (ev.type === "control_response") {
        this.resolveControl(ev);
        return;
      }
      // The bridge reporting on itself: ready → connected when a device joins,
      // disconnected/error when it goes. Session-level, not turn-level, so it
      // is read here rather than in the per-turn event processor.
      if (ev.type === "system" && ev.subtype === "bridge_state") {
        const next = bridgeStatus(ev, this.remoteControl);
        if (!next) return;
        this.remoteControl = next;
        // While our own enable request is in flight the CLI's `ready` arrives
        // first but carries no URL; the reply does, a moment later. Announcing
        // both means the banner appears twice, the second time saying the same
        // thing with a link. Let the reply speak.
        if (!this.remoteControlInFlight) {
          route({ type: "remote_control", remoteControl: this.remoteControl });
        }
        return;
      }
      // A prompt the session accepted from somewhere. Ours comes straight back
      // and is dropped; anything left was typed on a connected device, and it
      // is the only announcement that a turn nobody here started is beginning.
      // Read before the processor, which knows `user` events only as the
      // envelope a tool_result travels in.
      const prompt = replayedPrompt(ev);
      if (prompt !== null) {
        if (isCliControlMarker(prompt)) return;
        if (takeEcho(session.pendingEchoes, ev.uuid)) {
          // Ours. With a turn reading, the message was taken into that turn and
          // there is nothing to announce. Same when the session is busy without
          // a sink — that is a turn another surface started, which is already
          // carrying the message, and opening one here would close the queue
          // receiving its answer mid-sentence. With neither — a steered message
          // that found no tool boundary before the turn ended — the CLI is
          // opening a turn of its own to answer it, and that answer needs a
          // turn here to arrive into.
          if (!session.sink && !session.busy) {
            session.busy = true;
            route({ type: "steer_turn", prompt });
          }
          return;
        }
        // The CLI is now working for the other surface. Marking the session
        // busy is what makes a prompt sent from here wait for that turn's
        // `result` instead of interleaving with it.
        session.busy = true;
        route({ type: "remote_prompt", prompt });
        return;
      }
      for (const d of session.processor(ev)) route(d);
      if (ev.type === "result") {
        // Not every `result` belongs to the turn currently holding the sink.
        // The CLI opens a turn of its own to answer a `<task-notification>`,
        // and it stamps that turn's result `origin: {kind: "task-notification"}`
        // — measured, `test/fixtures/workflow-stream.jsonl` line 24. That turn
        // sets neither of the two places `session.busy` is raised (it replays
        // no `user` message, so `replayedPrompt` cannot fire), so a panel turn
        // submitted while it runs installs its sink into a session that is
        // mid-turn, and this `result` would end it before it had said anything.
        if (ev.origin?.kind === "task-notification" && session.busy) return;
        session.busy = false;
        // The same invariant `stream()` holds, applied where a turn actually
        // ends in session mode. A turn the phone or a steered message started
        // never enters `stream()`, so without this an "allow edits this turn"
        // granted once becomes a standing grant for every later such turn.
        this.autoAllowEdits = false;
        for (const wake of session.idleWaiters.splice(0)) wake();
        route({ type: "done" });
      }
    });

    child.once("exit", () => {
      session.exited = true;
      if (this.session === session) {
        this.session = null;
        this.child = null;
      }
      const unexpected = child.exitCode !== 0 && child.signalCode !== "SIGTERM";
      const said = usefulStderr(session.stderr);
      // Whatever it said on the way out, say it somewhere. Passing `answered:
      // true` to exitFailure — which a session process always has — makes it
      // return null every time, so this handler used to surface nothing at all,
      // however loudly the CLI explained itself. That is the same hole the
      // per-turn path had, and it is how a terminated workflow read as silence.
      if (said.length) {
        logInfo(
          `[luno] claude session exited ${child.exitCode ?? "?"} saying: ${said.join(" ")}`
        );
      }
      // A session process has answered many turns by the time it exits, so a
      // late non-zero code is never the current turn failing — but an
      // unexplained death mid-conversation is worth a line on screen.
      if (unexpected && said.length) {
        route({ type: "error", error: said.join("\n") });
      }
      this.settleOnSessionGone(route);
      route({ type: "done", sessionEnded: true });
    });
    child.once("error", (err) => {
      session.exited = true;
      route({ type: "error", error: err.message });
    });

    void this.initializeSession(session, route);

    // A replaced process comes up with no bridge — measured: `--resume` brings
    // the conversation back and leaves Remote Control off. Re-establish it, or
    // changing the effort level would quietly disconnect the user's phone.
    if (this.remoteControlWanted) {
      void this.establishRemoteControl(session, route).catch(() => {
        /* state and delta already carry the failure */
      });
    }

    return session;
  }

  /**
   * The control protocol's opening handshake.
   *
   * Sent for one thing: the reply carries `pending_permission_requests` — the
   * prompts the CLI is still blocked on. A process that is replaced mid-turn
   * (an effort change, the Remote Control toggle) leaves its cards behind in
   * the old stdin, and this is the CLI's own way of handing them to whoever
   * connects next. It matters more since a question became a permission
   * prompt: an unanswered one now holds the turn.
   *
   * Declares **no** `supportedDialogKinds`, deliberately. Declaring a kind is
   * what turns `request_user_dialog` on, and the CLI is explicit that doing so
   * without a handler parks dialogs nothing can answer. Rendering those is a
   * separate piece of work; until it exists, the honest declaration is none.
   *
   * Best-effort throughout. A CLI that answers this with an error, or not at
   * all, is one we go on talking to exactly as before — nothing downstream
   * waits on it.
   */
  private async initializeSession(
    session: CliSession,
    route: (d: StreamDelta) => void
  ): Promise<void> {
    let reply: Record<string, unknown>;
    try {
      reply = await this.sendControl(session, {
        subtype: "initialize",
        // The switch. A kind named here starts arriving, and one that arrives
        // with nothing to draw it parks the turn — so this is the same list
        // `raiseUserDialog` checks against, and it may only grow beside a card.
        supportedDialogKinds: [...SUPPORTED_DIALOG_KINDS]
      });
    } catch (err) {
      logInfo(`[luno] initialize not answered: ${(err as Error).message}`);
      return;
    }
    const pending = reply.pending_permission_requests;
    if (!Array.isArray(pending) || pending.length === 0) return;
    logInfo(`[luno] CLI re-delivered ${pending.length} pending permission(s)`);
    for (const item of pending) {
      const ev = item as CliEvent;
      // Straight back through the normal path: these are the same
      // `control_request` envelopes, so they get the same classification, the
      // same card, and the same bookkeeping as one arriving live.
      if (ev?.request_id && ev.request?.subtype === "can_use_tool") {
        this.handleControlRequest(ev, route);
      }
    }
  }

  /** Push the options the control protocol *can* change onto a live session. */
  private applyLiveOptions(session: CliSession, req: ProviderRequest): void {
    const mode = this.opts.permissionMode ?? "default";
    if (req.model && req.model !== session.model) {
      this.writeControl({
        request_id: nextControlId(),
        type: "control_request",
        request: { subtype: "set_model", model: req.model }
      });
      session.model = req.model;
    }
    if (mode !== session.permissionMode) {
      this.writeControl({
        request_id: nextControlId(),
        type: "control_request",
        request: {
          subtype: "set_permission_mode",
          mode: mapPermissionMode(mode)
        }
      });
      session.permissionMode = mode;
    }
  }

  /**
   * Hand this conversation to claude.ai/code and the Claude mobile app.
   *
   * Session mode only, and not by accident: the bridge lives exactly as long
   * as the process behind it, so the per-turn path could offer a URL that
   * stops working the moment the answer finishes.
   *
   * Returns the session URL the other device connects to. Rejects with the
   * CLI's own message when it refuses — no claude.ai login, an API key in the
   * environment, a non-Anthropic base URL, or an organisation policy.
   */
  async enableRemoteControl(name?: string): Promise<RemoteControlStatus> {
    if (!this.opts.sessionMode) {
      throw new Error(
        "Remote Control needs a session-mode conversation: the bridge ends when the process does."
      );
    }
    this.remoteControlName = name;
    // Set before the process is spawned, not after the CLI confirms: childEnv
    // reads it to decide whether to stand aside on ANTHROPIC_API_KEY, and a
    // respawn racing this request re-establishes on the strength of it.
    this.remoteControlWanted = true;
    // Spawning with the bridge already wanted starts the request itself, so
    // this joins whatever is in flight rather than sending a second one.
    const session = this.liveSessionOrSpawn();
    try {
      return await this.establishRemoteControl(session);
    } catch (err) {
      this.remoteControlName = undefined;
      this.remoteControlWanted = false;
      throw err;
    }
  }

  /**
   * The live session, or a new one — but never a *replacement*.
   *
   * Remote Control's toggle has no turn behind it, so it has no model and no
   * task type to rebuild argv from, and argv rebuilt without them does not
   * match what the process is running. `ensureSession` reads that as "the
   * options changed" and replaces the process.
   *
   * Measured 2026-07-29: switching the bridge on mid-conversation logged
   * `replacing the CLI process: ---model -default` and SIGTERMed the CLI
   * halfway through an assistant message. Replacement is the one thing this
   * path must never do — it is also what hands the phone a session URL nobody
   * is holding.
   */
  private liveSessionOrSpawn(): CliSession {
    const live = this.session;
    if (live && !live.exited) return live;
    // Built and recorded as an ordinary turn would. Spawning with neither left
    // two flags free to differ on the very next turn: `--effort`, whose
    // presence is decided against the model's own ladder, and — in plan mode —
    // the task-type `--append-system-prompt`, because a session recording
    // `taskType: undefined` sends `streamInSession`'s `session.taskType ??
    // opts.taskType` through to the freshly classified one instead of keeping
    // its own. Either difference replaces the process, which is the one thing
    // this path exists not to do.
    return this.ensureSession(
      buildArgs("", this.opts.model, this.opts),
      undefined,
      this.opts.taskType
    );
  }

  /** Ask the CLI for a bridge, or join the request already asking. */
  private establishRemoteControl(
    session: CliSession,
    route?: (d: StreamDelta) => void
  ): Promise<RemoteControlStatus> {
    const existing = this.remoteControlInFlight;
    if (existing) return existing;
    const name = this.remoteControlName;
    const attempt = this.sendControl(session, {
      subtype: "remote_control",
      enabled: true,
      ...(name !== undefined && { name })
    })
      .then((response) => {
        // Switched off while the reply was travelling: `disableRemoteControl`
        // drops its claim on this attempt, and publishing now would light the
        // pill back up for a bridge the CLI has already been told to tear down.
        if (this.remoteControlInFlight !== attempt) return this.remoteControl;
        this.remoteControl = {
          state: "ready",
          sessionUrl: asString(response.session_url),
          connectUrl: asString(response.connect_url)
        };
        logInfo(`[luno] remote control on: ${this.remoteControl.sessionUrl}`);
        route?.({ type: "remote_control", remoteControl: this.remoteControl });
        return this.remoteControl;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Superseded the same way, and an error published for a bridge nobody
        // wants any more is as wrong as a `ready` — the caller still hears it.
        if (this.remoteControlInFlight === attempt) {
          this.remoteControl = { state: "error", error: message };
          route?.({
            type: "remote_control",
            remoteControl: this.remoteControl
          });
        }
        throw err instanceof Error ? err : new Error(message);
      })
      .finally(() => {
        if (this.remoteControlInFlight === attempt) {
          this.remoteControlInFlight = null;
        }
      });
    this.remoteControlInFlight = attempt;
    return attempt;
  }

  /** Stop accepting input from other devices. The conversation itself carries
   *  on locally. */
  async disableRemoteControl(): Promise<void> {
    this.remoteControlName = undefined;
    const wanted = this.remoteControlWanted;
    this.remoteControlWanted = false;
    this.remoteControl = { state: "off" };
    // An enable request may still be in flight. Releasing the claim on it is
    // what makes its reply stand aside instead of publishing `ready` for the
    // bridge being torn down on the next line.
    this.remoteControlInFlight = null;
    const session = this.session;
    if (!wanted || !session || session.exited) return;
    try {
      await this.sendControl(session, {
        subtype: "remote_control",
        enabled: false
      });
    } catch (err) {
      // The bridge is off either way as far as this panel is concerned; a
      // failure here means the CLI never heard us, and the process is about to
      // be replaced or is already gone.
      logInfo(
        `[luno] remote control off (CLI did not confirm): ${String(err)}`
      );
    }
  }

  /** What the panel should be showing right now. */
  remoteControlStatus(): RemoteControlStatus {
    return this.remoteControl;
  }

  /**
   * Refresh the options a turn depends on, without discarding the process.
   *
   * The per-turn path rebuilds the whole provider every turn and needs none
   * of this. A session-mode provider outlives its turns, so the caller has to
   * hand it what changed — the editor's diagnostics and selection above all,
   * which describe the moment the message was sent and are worthless stale.
   *
   * Whether the change can be applied to the running process or needs a new
   * one is not decided here: the next turn's argv is compared through
   * `respawnFingerprint()`, so an option that only exists in argv replaces the
   * process by itself.
   */
  updateOptions(patch: Partial<ClaudeCliOpts>): void {
    this.opts = { ...this.opts, ...patch };
  }

  /**
   * Push a permission-mode change onto the live process, at the moment it is
   * picked rather than at the start of the next turn.
   *
   * Every other option reaches the CLI through argv, and changed argv replaces
   * the process — which a panel turn arranges on its way through
   * `ensureSession`. A turn started on the phone or by a steered message never
   * builds argv at all: it goes straight to `Orchestrator.observe`. So without
   * this the CLI keeps the mode its process was spawned with while the picker
   * says otherwise, and the direction that matters is *leaving* Bypass — in
   * `bypassPermissions` the CLI emits no `can_use_tool`, so a destructive call
   * runs with no card on either surface.
   *
   * Entering Bypass is the transition the CLI refuses on a session not launched
   * with `--dangerously-skip-permissions`. That refusal is left standing rather
   * than answered with a respawn: a respawn takes every background agent and
   * the Remote Control bridge with it, while the loosening the user asked for
   * arrives by itself with their next message from the panel. Failing towards
   * *more* prompts is the safe direction to fail in.
   */
  /**
   * Push a model change onto the live process.
   *
   * The same seam as `setLivePermissionMode`, for the same reason: a turn
   * started on the phone builds no argv, so the picker would go on naming a
   * model the CLI is not running. On the panel path `respawnFingerprint`
   * ignores `--model` — deliberately, so a model change costs no session URL —
   * which routes it to `applyLiveOptions` instead; this is the path with no
   * turn behind it at all.
   *
   * Held back when the two models disagree about the current effort level. That
   * level reaches the CLI through argv and argv cannot be rebuilt under a live
   * process, so pushing the model alone would leave it running under an
   * `--effort` its own ladder does not list. Left alone, the next panel turn
   * carries it: its fingerprint differs on `--effort` and replaces the process.
   */
  async setLiveModel(model: string): Promise<void> {
    // Recorded whether or not the push below happens: a toggle spawning after
    // this has to build argv with the model the next turn will ask for.
    this.opts = { ...this.opts, model };
    const session = this.session;
    if (!session || session.exited || session.model === model) return;
    if (effortFlag(session.model, this.opts) !== effortFlag(model, this.opts)) {
      logInfo(
        `[luno] ${model} takes a different effort level — leaving it to the next turn from the panel`
      );
      return;
    }
    try {
      await this.sendControl(session, { subtype: "set_model", model });
      session.model = model;
    } catch (err) {
      logInfo(`[luno] the CLI kept model ${session.model}: ${String(err)}`);
    }
  }

  async setLivePermissionMode(mode: PermissionMode): Promise<void> {
    this.opts = { ...this.opts, permissionMode: mode };
    const session = this.session;
    if (!session || session.exited || session.permissionMode === mode) return;
    try {
      await this.sendControl(session, {
        subtype: "set_permission_mode",
        mode: mapPermissionMode(mode)
      });
      session.permissionMode = mode;
    } catch (err) {
      logInfo(
        `[luno] the CLI kept permission mode ${session.permissionMode}: ${String(err)}`
      );
    }
  }

  /**
   * The process is gone: settle everything that was waiting on it.
   *
   * Two things outlive a dead pipe if nobody says otherwise. Every in-flight
   * control request sits on its own 30s timeout with no idea the pipe it was
   * written to has closed — and a replacement joining `remoteControlInFlight`
   * would attach itself to that dead promise. And the bridge status still
   * describes a session that no longer exists, so the pill goes on offering a
   * URL nothing is listening on.
   *
   * `connecting` rather than `off` when the bridge is still wanted: a
   * replacement re-establishes it (see `ensureSession`), so the honest reading
   * is "no link right now", not "you turned this off".
   */
  private settleOnSessionGone(emit: (d: StreamDelta) => void): void {
    for (const [, pending] of this.pendingControls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The Claude session ended before it answered."));
    }
    this.pendingControls.clear();
    this.remoteControlInFlight = null;
    if (this.remoteControl.state === "off") return;
    this.remoteControl = this.remoteControlWanted
      ? { state: "connecting" }
      : { state: "off" };
    emit({ type: "remote_control", remoteControl: this.remoteControl });
  }

  /** Send a control request and wait for the CLI's answer. */
  private sendControl(
    session: CliSession,
    request: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const requestId = nextControlId();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(
          new Error(
            `The Claude CLI did not answer '${String(request.subtype)}' within ${CONTROL_TIMEOUT_MS / 1000}s.`
          )
        );
      }, CONTROL_TIMEOUT_MS);
      this.pendingControls.set(requestId, { resolve, reject, timer });
      const wrote = this.writeToChild(session, {
        request_id: requestId,
        type: "control_request",
        request
      });
      if (!wrote) {
        clearTimeout(timer);
        this.pendingControls.delete(requestId);
        reject(new Error("The Claude session is no longer accepting input."));
      }
    });
  }

  /** Settle the promise for a control request we sent. */
  private resolveControl(ev: CliEvent): void {
    const response = ev.response;
    const requestId = response?.request_id;
    if (!requestId) return;
    const pending = this.pendingControls.get(requestId);
    if (!pending) return;
    this.pendingControls.delete(requestId);
    clearTimeout(pending.timer);
    if (response?.subtype === "success") {
      pending.resolve(
        (response.response as Record<string, unknown> | undefined) ?? {}
      );
    } else {
      pending.reject(new Error(response?.error ?? "The Claude CLI refused."));
    }
  }

  /** Stop the current turn without ending the session.
   *
   *  Takes every background agent with it — measured against 2.1.219, a running
   *  agent reported `status: "stopped"` 10ms after the request. So this is for
   *  Stop and nothing else: no path that merely *sends* may come through here.
   */
  private interrupt(): void {
    this.writeControl({
      request_id: nextControlId(),
      type: "control_request",
      request: { subtype: "interrupt" }
    });
  }

  /**
   * Interrupt, and hand back whatever the CLI had not read yet.
   *
   * The queue lives inside the CLI, and its answer to `interrupt` carries
   * `still_queued`. Measured against 2.1.219: a message the turn had already
   * accepted comes back as `[]`, so this returns what was written and never
   * looked at, not everything typed.
   *
   * Failure is not reported anywhere — the interrupt is the point, and a CLI
   * that will not answer a control request has already left the user with a
   * stopped turn and nothing to hand back.
   */
  private async interruptReturningQueued(): Promise<void> {
    const session = this.session;
    if (!session || session.exited) return;
    try {
      const res = await this.sendControl(session, { subtype: "interrupt" });
      const queued = Array.isArray(res.still_queued)
        ? res.still_queued.filter((t): t is string => typeof t === "string")
        : [];
      if (queued.length) this.opts.onStillQueued?.(queued.join("\n\n"));
    } catch {
      /* the turn is stopped either way */
    }
  }

  /**
   * Write one user message to the live session, and register its echo.
   *
   * Shared by the turn that opens a stream and by `steer`, because the message
   * on the wire is identical either way — only the reader's state differs.
   *
   * @returns the uuid it was written under, or null if stdin would not take it.
   */
  private writeUserMessage(
    session: CliSession,
    content: string | ContentBlock[]
  ): string | null {
    // The preamble travels as message text rather than in argv, which is
    // frozen at spawn — so it is part of the user message every other surface
    // on this session renders. Measured 2026-07-30 on claude.ai: what the panel
    // hides behind its own timeline reads there as a wall of "What the user is
    // looking at" above every single thing the user typed. Sent when it moves
    // and not otherwise: unchanged, the model already has it in context, and
    // repeating it buys tokens and noise on the other device and nothing else.
    const preamble = turnPreamble(this.opts);
    const moved = Boolean(preamble) && preamble !== session.preamble;
    const sent = moved ? withPreamble(preamble, content) : content;
    // Our own id on our own message. The CLI keeps it and returns it on the
    // replay, which is how the echo is recognised without guessing from the
    // text. Registered before the write, not after: the replay can be back
    // before the next tick, and an unregistered echo would land on the timeline
    // as a prompt the user never typed on the phone.
    const uuid = randomUUID();
    session.pendingEchoes.add(uuid);
    const wrote = this.writeToChild(session, {
      type: "user",
      uuid,
      session_id: "",
      parent_tool_use_id: null,
      // Says a person typed this, here. The official extension stamps the same
      // field on every message it sends — `send(…, {kind:"human"})` in its
      // webview — and a session shared with another device is the one place
      // where "who sent this" is not obvious from the fact that it arrived.
      origin: { kind: "human" },
      message: { role: "user", content: sent }
    });
    if (!wrote) {
      takeEcho(session.pendingEchoes, uuid);
      return null;
    }
    // Recorded only once the CLI has it. A write that failed took the context
    // with it, and the retry has to carry it again.
    if (moved) session.preamble = preamble;
    return uuid;
  }

  /**
   * Add to the turn already in flight instead of waiting for it.
   *
   * The CLI picks a second `user` message off stdin at the next tool boundary
   * and continues the *same* turn — measured on 2.1.219: written at 7.78s,
   * echoed at 8.24s, no second `system/init`, one `result`. Pure text
   * generation has no boundary, so a message sent into it waits and the CLI
   * opens the next turn for it itself; that is physics, not a defect.
   *
   * Deliberately does **not** install a sink, raise `busy` or wait for idle.
   * The message belongs to the turn already reading, and interrupting to make
   * room would kill every background agent (see `interrupt`).
   *
   * @returns false when there is no live session to write to, which is the
   *   caller's signal to open an ordinary turn instead.
   */
  steer(userText: string): boolean {
    const session = this.session;
    if (!session || session.exited) return false;
    return this.writeUserMessage(session, userText) !== null;
  }

  private writeToChild(session: CliSession, obj: unknown): boolean {
    const stdin = session.child.stdin;
    // Deliberately not the return value of write(): `false` there means the
    // buffer is above its high-water mark, not that the write failed. Right
    // after spawn it is routinely false while the pipe is still connecting,
    // and the data is queued and delivered regardless.
    if (session.exited || !stdin || stdin.destroyed || stdin.writableEnded) {
      return false;
    }
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  private childEnv(maxTokens?: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Measured 2026-07-31, against 2.1.219: the bridge comes up **fine** with
    // `ANTHROPIC_API_KEY` in the environment — `remote_control{enabled:true}`
    // answered `success` with a session_url. So the reason this used to give,
    // "Remote Control refuses to start under an API key", is simply false and
    // has been removed rather than reworded.
    //
    // What stands: the CLI may prefer an env-supplied key over its own
    // credentials, which would move the conversation off the user's
    // subscription and onto an API bill. That half is untested — the probe ran
    // with a deliberately invalid key on a machine that also had OAuth creds,
    // so it cannot tell "ignored" from "used". Standing aside stays until it is
    // settled; it costs nothing when the CLI has its own login.
    const wantsBridge = this.remoteControlWanted;
    if (wantsBridge && env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
    // Injected whatever the bridge is doing. On the fallback sign-in — a token
    // pasted because `claude setup-token` was not usable — this variable *is*
    // the user's only credential, and there is no `~/.claude` login behind it.
    // Withholding it on `/rc` handed the CLI nothing to authenticate with, for
    // the sake of a refusal that the 2026-07-31 probe showed does not happen.
    if (this.opts.token) env.ANTHROPIC_API_KEY = this.opts.token;
    if (Number.isFinite(maxTokens) && (maxTokens ?? 0) > 0) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(maxTokens!));
    }
    // Belt to buildArgs' braces. Stream-json input already keeps the CLI out of
    // its print wind-down, but if any configuration ever falls back to the argv
    // path this stops the CLI terminating background work behind our back: `0`
    // is its own documented value for "wait indefinitely", and the bounds that
    // remain are ours — the silence watchdog, and Stop.
    env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ??= "0";
    return env;
  }

  /**
   * End the long-lived process. Safe to call when there is none.
   *
   * A turn still reading this process is told before the sink is dropped. The
   * exit handler does route `done` when the child goes, but `route` delivers
   * through `session.sink` — which this method has already cleared by then, so
   * the delta lands out-of-turn, where nothing ends a turn. Measured
   * 2026-07-29: a mid-turn replacement left the panel reading **Brewing** with
   * no process behind it, and no way out but reloading the window.
   */
  disposeSession(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (this.child === session.child) this.child = null;
    session.exited = true;
    const sink = session.sink;
    session.sink = null;
    if (sink) {
      sink({
        type: "error",
        error: "The Claude session ended before this turn finished."
      });
      sink({ type: "done" });
    }
    // Out of turn deliberately: the sink above has just been told this turn is
    // over, and the bridge belongs to the session rather than to any turn.
    this.settleOnSessionGone((d) => this.opts.onOutOfTurn?.(d));
    void terminateChild(session.child);
  }
}

/** Read a string out of a CLI response without trusting its shape. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

let controlSeq = 0;
function nextControlId(): string {
  controlSeq += 1;
  return `luno-${controlSeq}`;
}

/** Resolve once the CLI has finished the turn it is on, or after
 *  TURN_DRAIN_TIMEOUT_MS — a wedged CLI must not leave the panel unable to
 *  send anything ever again. */
function waitUntilIdle(session: CliSession): Promise<void> {
  if (!session.busy || session.exited) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      logInfo("[luno] previous turn never reported a result — sending anyway");
      session.busy = false;
      finish();
    }, TURN_DRAIN_TIMEOUT_MS);
    session.idleWaiters.push(finish);
  });
}

/** Resolve once the child has exited; SIGTERM, then SIGKILL after a grace period. */
function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let kill: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (kill) clearTimeout(kill);
      resolve();
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      setTimeout(finish, 200);
    }, 2000);
  });
}

/**
 * The wording for an "always allow" button, or `undefined` when the card must
 * not offer one.
 *
 * Destructive and network calls are refused here as well as in
 * `decidePermission`. Two checks for one rule is deliberate: this one keeps the
 * button off the screen, and that one would refuse the grant even if a message
 * arrived claiming otherwise.
 */

/** The auto-continue deadline as a payload fragment, or nothing when the user
 *  has not set one — which is the CLI's own default. */
function afkTimeout(): { afkTimeoutMs: number } | undefined {
  const ms = askUserQuestionTimeoutMs();
  return ms === null ? undefined : { afkTimeoutMs: ms };
}

function offeredGrantLabel(
  toolName: string,
  input: Record<string, unknown> | undefined,
  destructive: boolean,
  network: boolean,
  interactive: boolean
): string | undefined {
  if (destructive || network) return undefined;
  // A standing grant cannot answer a question: `decidePermission` checks the
  // interactive gate above the grant list, so offering "Always" here would
  // render a button that silently does nothing the next time round. Both
  // triggers, for the same reason the gate itself has both.
  if (INTERACTIVE_TOOLS.has(toolName) || interactive) return undefined;
  const grant = grantFor(toolName, input);
  return grant ? grantLabel(grant) : undefined;
}

/**
 * The newest user message's content, whole.
 *
 * Returns what was handed in rather than a flattening of it: an attached image
 * or PDF is a block on this message, and the string this used to return dropped
 * every block that was not text — so an attachment could be built anywhere in
 * the host and would still never reach the CLI.
 *
 * `null` when there is no user message at all, which is a different thing from
 * one carrying no words: a screenshot with nothing typed is a real turn.
 */
function lastUserContent(messages: Message[]): string | ContentBlock[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const blocks = m.content;
    if (blocks.length > 0) return blocks;
  }
  return null;
}

/** The words in a content payload. What argv and the task classifier read —
 *  neither has anywhere to put an image. */
function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
}

/**
 * Put the turn preamble in front of the user's own content.
 *
 * A string concatenation for a string, and a text block in front of the rest
 * for an array — `preamble + blocks` would have stringified the array into
 * `[object Object]` and sent that as the prompt.
 */
function withPreamble(
  preamble: string,
  content: string | ContentBlock[]
): string | ContentBlock[] {
  if (typeof content === "string") return preamble + content;
  return [{ type: "text", text: preamble }, ...content];
}
