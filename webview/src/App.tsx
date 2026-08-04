// ─────────────────────────────────────────────────────────────
// App shell — owns auth state, timeline, and shared composer
// inputs (models, skills, pending-insert payload). Code from
// Cmd+U flows in as a structured payload that the RichEditor
// renders as an atomic, editable code block inline.
// ─────────────────────────────────────────────────────────────

import { useEffect, useReducer, useState } from "react";
import {
  send,
  onMessage,
  patchState,
  loadState,
  PermissionMode,
  EffortLevel,
  TimelineEvent,
  EditorContext,
  ModelInfo,
  SkillInfo,
  ChatStatus,
  PermissionRequestView,
  SubagentTaskView,
  PendingSetting,
  UserDialogView
} from "./lib/rpc";
import { subscribeToSettings } from "./lib/settings";
import { Spinner, type CodeInsert } from "./design/primitives";
import { ChatScreen } from "./features/chat";
import { WelcomeScreen } from "./features/auth/WelcomeScreen";
import { FALLBACK_MODELS } from "./features/chat/constants";
import {
  liveAgents,
  subagentOutcome,
  type LiveAgents
} from "./features/chat/subagent-state";
import { IDLE_VOICE, type VoiceState } from "./features/chat/voice-state";
import { StopAgentsModal } from "./features/chat/StopAgentsModal";
import s from "./App.module.scss";

// ── Auth state ───────────────────────────────────────────────
//
// Subscription-only: the bundled Claude Code CLI is the single transport.
// We start in `loading` until the host posts its first `auth` message,
// then flip to either `authed` or `signedOut`. The signed-out state is
// entered when the user clicks Logout — the panel runs `claude logout`
// silently and re-broadcasts auth with `authed: false`. The user then
// either signs back in (WelcomeScreen → `claudeLogin` RPC) or restarts
// the extension after running `claude login` in a terminal of their own.

type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | {
      status: "authed";
      model: string;
      permissionMode: PermissionMode;
      effort: EffortLevel;
      thinking: boolean;
      ultracode: boolean;
    };

interface Persisted {
  events?: TimelineEvent[];
  input?: string;
  pins?: { path: string; label: string }[];
  /**
   * Which conversation this surface was showing.
   *
   * Written for the extension host to read back, not for this app: a webview's
   * persisted state is the only thing VS Code returns when it restores an
   * editor tab after a window reload, so without it the tab comes back with no
   * conversation behind it. Kept current from every message that carries an id
   * — the host changes sessions under a surface on New Chat, on adoption and on
   * a switch.
   */
  sessionId?: string;
}

// ── Timeline reducer ─────────────────────────────────────────

type TimelineAction =
  | { type: "reset" }
  | { type: "append"; event: TimelineEvent }
  | { type: "replace"; events: TimelineEvent[] };

function timelineReducer(
  state: TimelineEvent[],
  action: TimelineAction
): TimelineEvent[] {
  switch (action.type) {
    case "reset":
      return [];
    case "append": {
      const idx = state.findIndex((e) => e.id === action.event.id);
      if (idx === -1) return [...state, action.event];
      // Replace in place when the host re-posts an existing event (e.g. a
      // plan-comment edit mutates meta and re-emits the same id).
      const next = state.slice();
      next[idx] = action.event;
      return next;
    }
    case "replace":
      return action.events;
  }
}

// ── Component ────────────────────────────────────────────────

// The global `app` class rides along with the module class: theme.css keys the
// "lift the chrome above the ambient aurora" rule off `.app > *:not(…)`, and it
// must keep naming the ambient layers to exclude them.
const SHELL = `app ${s.shell}`;

export function App() {
  const initial = loadState<Persisted>() ?? {};

  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [events, dispatchTimeline] = useReducer(
    timelineReducer,
    initial.events ?? []
  );
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState(initial.input ?? "");
  const [error, setError] = useState<string | null>(null);
  const [editorContext, setEditorContext] = useState<EditorContext | null>(
    null
  );
  const [models, setModels] = useState<ModelInfo[]>([...FALLBACK_MODELS]);
  // alias → resolved concrete id (e.g. `default` → `claude-opus-4-7[1m]`),
  // accumulated as the host resolves each picker entry. Lets every row show
  // its real version the moment the picker opens.
  const [resolvedModels, setResolvedModels] = useState<Record<string, string>>(
    {}
  );
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [composerFocusKey, setComposerFocusKey] = useState(0);
  const [pendingInsert, setPendingInsert] = useState<CodeInsert | null>(null);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  // Dictation, held here rather than in the composer because it arrives from
  // the host and outlives a remount of the editor.
  const [voice, setVoice] = useState<VoiceState>(IDLE_VOICE);
  // What the host calls this conversation and how it reads its stored
  // timeline. Both arrive together because the host recomputes them together.
  const [sessionMeta, setSessionMeta] = useState<{
    title: string;
    status: ChatStatus | null;
  }>({ title: "", status: null });
  const [bannerVisible, setBannerVisible] = useState(false);
  const [skillSuggestion, setSkillSuggestion] = useState<{
    skillId: string;
    skillName: string;
    reason: string;
    taskType: string;
  } | null>(null);
  const [pins, setPins] = useState<{ path: string; label: string }[]>(
    initial.pins ?? []
  );
  // In-flight tool-permission prompts. With parallel tool calls the CLI can
  // block on several `can_use_tool` requests at once. We keep a FIFO queue and
  // surface one card at a time; answering the head reveals the next. A single
  // slot used to drop every prompt but the latest, leaving the CLI blocked on
  // the unanswered ones forever and wedging the whole turn.
  const [pendingPermissions, setPendingPermissions] = useState<
    PermissionRequestView[]
  >([]);
  const pendingPermission = pendingPermissions[0] ?? null;

  // Dialogs queue for the same reason permissions do: the CLI can be blocked on
  // more than one, and a single slot would drop every prompt but the newest and
  // leave the rest unanswered forever.
  const [pendingDialogs, setPendingDialogs] = useState<UserDialogView[]>([]);
  const pendingDialog = pendingDialogs[0] ?? null;

  // What each running subagent is doing right now, keyed by CLI task id.
  // Deliberately outside `events` and outside `patchState`: the timeline holds
  // the dispatch and the result, which are what still mean something tomorrow.
  // This holds the middle of the run, which stops meaning anything the moment
  // the run ends — and the CLI process dies with the turn, so there is never a
  // live subagent to restore after a reload.
  const [taskProgress, setTaskProgress] = useState<
    Record<string, SubagentTaskView>
  >({});
  /** Stop was pressed with agents running — see StopAgentsModal for why that
   *  is a question rather than an action. Holds the count as it was when
   *  asked, so the dialog cannot renumber itself under the user's cursor. */
  const [stopWithAgents, setStopWithAgents] = useState<LiveAgents | null>(null);
  /** Controls showing a value the running CLI has not been given: applying it
   *  means replacing the process, and the conversation has agents in it. */
  const [pendingSettings, setPendingSettings] = useState<PendingSetting[]>([]);
  /** Modes the user's own Claude Code settings forbid. Never offered — a mode
   *  refused the moment it is picked is worse than one that was not on the
   *  menu. */
  const [disabledModes, setDisabledModes] = useState<PermissionMode[]>([]);

  // Persist non-volatile UI state. Patch rather than replace — the theme
  // store owns its own slice of the same state object.
  useEffect(() => {
    patchState<Persisted>({ events, input, pins });
  }, [events, input, pins]);

  // Report keyboard focus so the host can scope keybindings to the chat.
  // `document.hasFocus()` covers the mount: a webview revealed by a keybinding
  // is already focused, and the browser fires no event for a state it was
  // created in.
  useEffect(() => {
    const report = (focused: boolean) => send({ type: "chatFocus", focused });
    const onFocus = () => report(true);
    const onBlur = () => report(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    if (document.hasFocus()) report(true);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      report(false);
    };
  }, []);

  // The webview-facing settings store keeps itself current; nothing renders
  // from this effect, so it stays out of the handler below.
  useEffect(() => subscribeToSettings(), []);

  // Single inbound message handler.
  useEffect(() => {
    const off = onMessage((m) => {
      switch (m.type) {
        case "auth": {
          if (!m.authed) {
            setAuth({ status: "signedOut" });
            break;
          }
          setAuth({
            status: "authed",
            model: m.model ?? "default",
            permissionMode: m.permissionMode ?? "default",
            effort: m.effort ?? "high",
            thinking: m.thinking ?? true,
            ultracode: m.ultracode ?? false
          });
          setPendingSettings(m.pendingSettings ?? []);
          setDisabledModes(m.disabledModes ?? []);
          send({ type: "requestModels" });
          send({ type: "requestSkills" });
          break;
        }
        case "hello":
          patchState<Persisted>({ sessionId: m.sessionId });
          setStreaming("");
          setError(null);
          setBusy(false);
          setPendingPermissions([]);
          setPendingDialogs([]);
          setTaskProgress({});
          break;
        case "reset":
          patchState<Persisted>({ sessionId: m.sessionId });
          dispatchTimeline({ type: "reset" });
          setStreaming("");
          setError(null);
          // New Chat always lands on a usable composer, even if a turnEnd was missed.
          setBusy(false);
          setPendingPermissions([]);
          setPendingDialogs([]);
          setTaskProgress({});
          break;
        case "returnToComposer":
          setPendingRestore(m.text);
          break;
        // A `vscode://` link's prompt. Same path as a handed-back follow-up:
        // it lands in the composer, focuses it, and waits for a person. The
        // focus bump is the only signal a link did anything, since the panel
        // may already have been open.
        case "prefillComposer":
          setPendingRestore(m.text);
          setComposerFocusKey((k) => k + 1);
          break;
        case "timeline":
          dispatchTimeline({ type: "append", event: m.event });
          // The orchestrator flushes streamed text into a real assistant
          // event right before any tool_use_start, so when we see either an
          // assistant *or* a tool_call land in the timeline we can safely
          // drop the live streaming buffer — the content it held is now
          // anchored above whatever comes next.
          if (m.event.kind === "assistant" || m.event.kind === "tool_call") {
            setStreaming("");
          }
          // The closing row is the only thing that ever says an agent stopped.
          // Nothing else does: the host deletes the task from its own live map
          // and writes this event, and posts no further progress for it — so an
          // entry left here keeps its last `running` status for good, and the
          // header goes on claiming agents long after the last one answered.
          if (m.event.kind === "subagent") {
            const meta = m.event.meta as
              { taskId?: string; phase?: string } | undefined;
            if (meta?.phase === "end" && meta.taskId) {
              setTaskProgress((prev) => {
                if (!(meta.taskId! in prev)) return prev;
                const next = { ...prev };
                delete next[meta.taskId!];
                return next;
              });
            }
          }
          break;
        case "delta": {
          const d = m.delta;
          // `prev`, not `s` — `s` is the styles import at module scope.
          if (d.type === "text") setStreaming((prev) => prev + d.text);
          else if (d.type === "error") setError(d.error);
          break;
        }
        case "turnStart":
          setBusy(true);
          setStreaming("");
          setError(null);
          break;
        case "turnEnd":
          setBusy(false);
          setStreaming("");
          // The turn is over (completed or cancelled) — no prompt can still
          // be live, so drop any card that didn't get an explicit answer.
          setPendingPermissions([]);
          setPendingDialogs([]);
          // Subagents are not the same case, and used to be treated as one.
          // The process outlives the turn now, so an agent still running at
          // `turnEnd` keeps running — wiping it here left its card with a
          // title and a spinner and nothing else: no activity line, no
          // workflow roster, no elapsed time, because live outranks stored.
          // A *finished* agent does have to go, or the stale progress summary
          // beats the answer on its own closing event.
          setTaskProgress((prev) =>
            Object.fromEntries(
              Object.entries(prev).filter(
                ([, t]) => subagentOutcome(t.status) === "running"
              )
            )
          );
          break;
        case "subagentProgress":
          setTaskProgress((prev) => ({
            ...prev,
            [m.task.taskId]: { ...prev[m.task.taskId], ...m.task }
          }));
          break;
        case "permissionRequest":
          // Append to the queue (deduping on requestId so a re-posted prompt
          // doesn't enqueue twice). Never overwrite — each pending prompt must
          // be answered or the CLI stays blocked on it.
          setPendingPermissions((q) =>
            q.some((p) => p.requestId === m.request.requestId)
              ? q
              : [...q, m.request]
          );
          break;
        case "permissionResolved":
          // Answered on another device. Only this one leaves — the queue can
          // hold prompts the phone never saw, and dropping those would leave
          // the CLI blocked on questions with no card left to answer them.
          setPendingPermissions((q) =>
            q.filter((p) => p.requestId !== m.requestId)
          );
          break;
        case "userDialog":
          setPendingDialogs((q) =>
            q.some((d) => d.requestId === m.dialog.requestId)
              ? q
              : [...q, m.dialog]
          );
          break;
        case "userDialogResolved":
          // Withdrawn by the CLI — it retires a dialog the moment a new user
          // message makes it moot. Nothing goes back; the id is already gone.
          setPendingDialogs((q) =>
            q.filter((d) => d.requestId !== m.requestId)
          );
          break;
        case "error":
          setError(m.message);
          setBusy(false);
          setPendingPermissions([]);
          setPendingDialogs([]);
          break;
        case "editorContext":
          setEditorContext(m.context ?? null);
          break;
        case "rewind":
          // Rewinding cancels any in-flight turn server-side, so clear the
          // client's transient state too: drop the streaming buffer, any
          // error, and the busy/loader flag. When the rewind empties the
          // timeline this lands on the same clean slate as a new chat.
          dispatchTimeline({ type: "replace", events: m.events });
          setStreaming("");
          setError(null);
          setBusy(false);
          setPendingPermissions([]);
          setPendingDialogs([]);
          break;
        case "models":
          if (m.models.length) setModels(m.models);
          break;
        case "activeModel":
          setResolvedModels((prev) =>
            prev[m.alias] === m.model ? prev : { ...prev, [m.alias]: m.model }
          );
          break;
        case "skills":
          setSkills(m.skills);
          break;
        case "insertSelection":
          // Cmd+U payload — RichEditor renders this as a styled code block
          // at the cursor; the markdown markers never appear to the user.
          setPendingInsert({
            file: m.file,
            language: m.language,
            startLine: m.startLine,
            endLine: m.endLine,
            text: m.text
          });
          setComposerFocusKey((k) => k + 1);
          break;
        case "voice":
          setVoice((prev) => ({
            listening: m.phase === "listening",
            committed: m.committed,
            interim: m.interim,
            error: m.error,
            language: m.language,
            // The level keeps its last value across a text update: the two
            // messages are independent and reading zero between them would
            // make the meter stutter at the frame rate of the transcript.
            level: m.phase === "listening" ? prev.level : 0
          }));
          // The transcript reaches the editor once, at the end. Appending it
          // through the same path a cancelled turn uses means it lands behind
          // whatever was already typed rather than replacing it.
          if (m.phase === "idle" && m.committed.trim()) {
            setPendingRestore(m.committed.trim());
            setComposerFocusKey((k) => k + 1);
          }
          break;
        case "voiceLevel":
          setVoice((prev) =>
            prev.listening ? { ...prev, level: m.level } : prev
          );
          break;
        case "fileSearchResults":
          // Consumed by MentionPopover via its own subscription.
          break;
        case "historyList":
          // Consumed by HistoryDrawer via its own subscription.
          break;
        case "loadedSession":
          patchState<Persisted>({ sessionId: m.sessionId });
          dispatchTimeline({ type: "replace", events: m.events });
          setStreaming("");
          setError(null);
          setBusy(false);
          setPendingPermissions([]);
          setPendingDialogs([]);
          // Everything above belongs to the conversation being left behind, and
          // so does this: a chat running twenty agents handed its surface to
          // another one and the header of the *new* chat kept saying `agents`.
          // The host re-publishes whatever the incoming conversation has open.
          setTaskProgress({});
          break;
        case "sessionMeta":
          setSessionMeta({ title: m.title, status: m.status });
          break;
        case "conventionsStatus":
          // The banner is what acts on this now; the header stopped naming the
          // conventions file when it stopped being news after the first read.
          break;
        case "conventionsBanner":
          setBannerVisible(true);
          break;
        case "skillSuggestion":
          setSkillSuggestion({
            skillId: m.skillId,
            skillName: m.skillName,
            reason: m.reason,
            taskType: m.taskType
          });
          break;
      }
    });
    send({ type: "refreshAuth" });
    send({ type: "refreshEditorContext" });
    return off;
  }, []);

  if (auth.status === "loading") {
    return (
      <div className={SHELL}>
        <div className="app-ambient" aria-hidden />
        <div className={s.center}>
          <Spinner size={48} />
        </div>
      </div>
    );
  }

  if (auth.status === "signedOut") {
    return (
      <div className={SHELL}>
        <div className="app-ambient" aria-hidden />
        <WelcomeScreen />
      </div>
    );
  }

  return (
    <div className={SHELL}>
      <div className="app-ambient" aria-hidden />
      <div className="app-ambient-top" aria-hidden />
      <ChatScreen
        model={auth.model}
        resolvedModels={resolvedModels}
        permissionMode={auth.permissionMode}
        effort={auth.effort}
        thinking={auth.thinking}
        ultracode={auth.ultracode}
        events={events}
        taskProgress={taskProgress}
        pendingSettings={pendingSettings}
        disabledModes={disabledModes}
        streaming={streaming}
        busy={busy}
        input={input}
        error={error}
        editorContext={editorContext}
        models={models}
        skills={skills}
        composerFocusKey={composerFocusKey}
        pendingInsert={pendingInsert}
        voice={voice}
        onDismissVoiceError={() => setVoice(IDLE_VOICE)}
        pendingRestore={pendingRestore}
        onRestored={() => setPendingRestore(null)}
        sessionTitle={sessionMeta.title}
        sessionStatus={sessionMeta.status}
        bannerVisible={bannerVisible}
        onHideBanner={() => setBannerVisible(false)}
        skillSuggestion={skillSuggestion}
        onDismissSkillSuggestion={() => setSkillSuggestion(null)}
        onInserted={() => setPendingInsert(null)}
        pins={pins}
        onPin={(p) =>
          setPins((curr) =>
            curr.some((x) => x.path === p.path) ? curr : [...curr, p]
          )
        }
        onUnpin={(path) =>
          setPins((curr) => curr.filter((p) => p.path !== path))
        }
        onClearPins={() => setPins([])}
        onInput={setInput}
        onSubmit={(text) => {
          // Auto-prepend pinned-file mentions so the agent reliably has
          // them in scope. We use the @-mention syntax the agent already
          // resolves, separated by spaces, then a blank line before the
          // user's text. Skip pins that the user has already mentioned.
          const lowered = text.toLowerCase();
          const auto = pins
            .filter((p) => !lowered.includes(`@${p.label.toLowerCase()}`))
            .map((p) => `@${p.label}`)
            .join(" ");
          const finalText = auto ? `${auto}\n\n${text}` : text;
          send({ type: "prompt", text: finalText });
          setInput("");
        }}
        onCancel={() => {
          // Stop reaches the CLI as an interrupt, and that takes every
          // background agent with it. Only ask when there is something to lose.
          const running = liveAgents(taskProgress);
          if (running.count > 0) setStopWithAgents(running);
          else send({ type: "cancel" });
        }}
        onDismissError={() => setError(null)}
        pendingPermission={pendingPermission}
        onPermissionRespond={(behavior, opts) => {
          if (!pendingPermission) return;
          send({
            type: "permissionResponse",
            requestId: pendingPermission.requestId,
            behavior,
            restOfTurn: opts?.restOfTurn,
            always: opts?.always,
            alwaysScope: opts?.alwaysScope,
            updatedInput: opts?.updatedInput,
            reason: opts?.reason
          });
          // Dequeue only the prompt we just answered; the next queued prompt
          // (if any) becomes the new head and its card renders immediately.
          setPendingPermissions((q) => q.slice(1));
        }}
        pendingDialog={pendingDialog}
        onDialogRespond={(result) => {
          if (!pendingDialog) return;
          send({
            type: "userDialogResponse",
            requestId: pendingDialog.requestId,
            result
          });
          setPendingDialogs((q) => q.slice(1));
        }}
      />
      <StopAgentsModal
        agents={stopWithAgents}
        onCancel={() => setStopWithAgents(null)}
        onConfirm={() => {
          send({ type: "cancel" });
          setStopWithAgents(null);
        }}
      />
    </div>
  );
}
