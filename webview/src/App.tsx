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
  SubagentTaskView
} from "./lib/rpc";
import { Spinner, type CodeInsert } from "./design/primitives";
import { ChatScreen } from "./features/chat";
import { WelcomeScreen } from "./features/auth/WelcomeScreen";
import { FALLBACK_MODELS } from "./features/chat/constants";
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
  // Typed during a turn and held by the host until that turn ends. Mirrored
  // here only to render it — the host owns it, because a conversation outlives
  // the surface showing it.
  const [queued, setQueued] = useState("");
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
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

  // What each running subagent is doing right now, keyed by CLI task id.
  // Deliberately outside `events` and outside `patchState`: the timeline holds
  // the dispatch and the result, which are what still mean something tomorrow.
  // This holds the middle of the run, which stops meaning anything the moment
  // the run ends — and the CLI process dies with the turn, so there is never a
  // live subagent to restore after a reload.
  const [taskProgress, setTaskProgress] = useState<
    Record<string, SubagentTaskView>
  >({});

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
          break;
        case "reset":
          patchState<Persisted>({ sessionId: m.sessionId });
          dispatchTimeline({ type: "reset" });
          setStreaming("");
          setError(null);
          // New Chat always lands on a usable composer, even if a turnEnd was missed.
          setBusy(false);
          setPendingPermissions([]);
          setQueued("");
          setTaskProgress({});
          break;
        case "queued":
          setQueued(m.text);
          break;
        case "returnToComposer":
          setQueued("");
          setPendingRestore(m.text);
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
          // Same for subagents: the host has just closed every open one on the
          // timeline, so keeping live progress would fight the finished card.
          setTaskProgress({});
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
        case "error":
          setError(m.message);
          setBusy(false);
          setPendingPermissions([]);
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
        streaming={streaming}
        busy={busy}
        input={input}
        error={error}
        editorContext={editorContext}
        models={models}
        skills={skills}
        composerFocusKey={composerFocusKey}
        pendingInsert={pendingInsert}
        queued={queued}
        onQueuedEdit={(text) => {
          send({ type: "dropQueued" });
          setQueued("");
          setPendingRestore(text);
        }}
        onQueuedDrop={() => {
          send({ type: "dropQueued" });
          setQueued("");
        }}
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
        onCancel={() => send({ type: "cancel" })}
        onDismissError={() => setError(null)}
        pendingPermission={pendingPermission}
        onPermissionRespond={(behavior, restOfTurn) => {
          if (!pendingPermission) return;
          send({
            type: "permissionResponse",
            requestId: pendingPermission.requestId,
            behavior,
            restOfTurn
          });
          // Dequeue only the prompt we just answered; the next queued prompt
          // (if any) becomes the new head and its card renders immediately.
          setPendingPermissions((q) => q.slice(1));
        }}
      />
    </div>
  );
}
