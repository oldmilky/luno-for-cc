// ─────────────────────────────────────────────────────────────
// Chat screen — orchestrates timeline + composer + empty state.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../design/icons";
import { AnimatePresence, motion } from "framer-motion";
import {
  send,
  onMessage,
  TimelineEvent,
  EditorContext,
  PermissionMode,
  EffortLevel,
  ModelInfo,
  SkillInfo,
  ChatStatus,
  PermissionRequestView,
  GrantScope,
  RemoteControlStatus,
  PendingSetting,
  SubagentTaskView,
  UserDialogView
} from "../../lib/rpc";
import { ConnectorsModal } from "../mcp";
import { PermissionsModal } from "./modals/PermissionsModal";
import {
  ENTER_CARD,
  PRESS,
  DURATION,
  EASE_OUT,
  TRAVEL
} from "../../design/motion";
import type { CodeInsert } from "../../design/primitives";
import { Header } from "./Header";
import { isRemoteControlCommand } from "./remote-control-command";
import { Composer } from "./Composer";
import { ContextStrip } from "./ContextStrip";
import { EmptyState } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { RewindModal } from "./modals/RewindModal";
import { FableOverageDialog } from "./modals/FableOverageDialog";
import { EditConfirmModal } from "./modals/EditConfirmModal";
import { PermissionRequest } from "./PermissionRequest";
import { HistoryDrawer } from "./modals/HistoryDrawer";
import { AssistantMessage } from "./timeline/AssistantMessage";
import { ThinkingIndicator } from "./timeline/ThinkingIndicator";
import { ConventionsBanner } from "./ConventionsBanner";
import { SkillSuggestion } from "./SkillSuggestion";
import { liveAgents, agentPanel, mergeTaskState } from "./timeline/subagent-state";
import type { VoiceState } from "./voice-state";
import { BackgroundAgentsModal } from "./modals/BackgroundAgentsModal";
import { CommandPalette } from "./modals/CommandPalette";
import { KeyboardHints } from "./modals/KeyboardHints";
import { PinnedContext, PinnedFile } from "./PinnedContext";
import { groupEvents, type RenderCtx } from "./timeline/group-events";
import { renderGroup } from "./timeline/render-groups";
import { InlineMessageEditor } from "./timeline/InlineMessageEditor";
import s from "./ChatScreen.module.scss";

export interface ChatScreenProps {
  model: string;
  /** alias → resolved concrete id for every picker entry, so each row can
   *  show its real version. */
  resolvedModels: Record<string, string>;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  thinking: boolean;
  /** The sixth effort choice, carried beside the level the CLI knows. */
  ultracode: boolean;
  events: TimelineEvent[];
  /** What each *running* subagent is doing, keyed by CLI task id. Live only —
   *  the dispatch and the result come off `events` and outlive a reload. */
  taskProgress: Record<string, SubagentTaskView>;
  streaming: string;
  busy: boolean;
  input: string;
  error: string | null;
  editorContext: EditorContext | null;
  models: ReadonlyArray<ModelInfo>;
  skills: ReadonlyArray<SkillInfo>;
  /** Controls the running CLI has not been given — marked on their chips. */
  pendingSettings?: ReadonlyArray<PendingSetting>;
  /** Modes the user's settings forbid — kept out of the picker entirely. */
  disabledModes?: ReadonlyArray<PermissionMode>;
  composerFocusKey: number;
  pendingInsert: CodeInsert | null;
  /** What the host calls this conversation, and how it reads its stored
   *  timeline. Both come from `sessionMeta`, which the host recomputes
   *  whenever the name or the attention could have moved. */
  sessionTitle: string;
  sessionStatus: ChatStatus | null;
  /** Dictation, for the composer's strip and its mic button. */
  voice: VoiceState;
  onDismissVoiceError: () => void;
  pendingRestore: string | null;
  onRestored: () => void;
  bannerVisible: boolean;
  onHideBanner: () => void;
  skillSuggestion: {
    skillId: string;
    skillName: string;
    reason: string;
    taskType: string;
  } | null;
  onDismissSkillSuggestion: () => void;
  onInserted: () => void;
  pins: ReadonlyArray<PinnedFile>;
  onPin: (p: PinnedFile) => void;
  onUnpin: (path: string) => void;
  onClearPins: () => void;
  onInput: (v: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onDismissError: () => void;
  /** The pending tool-permission prompt to render above the composer, if any. */
  pendingPermission: PermissionRequestView | null;
  onPermissionRespond: (
    behavior: "allow" | "deny",
    opts?: {
      restOfTurn?: boolean;
      always?: boolean;
      /** Where the standing grant goes. Absent means LUNO's own storage. */
      alwaysScope?: GrantScope;
      updatedInput?: Record<string, unknown>;
      reason?: string;
    }
  ) => void;
  /** A decision the CLI needs that is not about a tool. Rendered in the same
   *  slot as an approval — both block the turn, and only one can be at the
   *  head of either queue at a time. */
  pendingDialog: UserDialogView | null;
  onDialogRespond: (result?: "consent" | "switch_default") => void;
}

export function ChatScreen({
  model,
  resolvedModels,
  permissionMode,
  effort,
  thinking,
  ultracode,
  events,
  taskProgress,
  streaming,
  busy,
  input,
  error,
  editorContext,
  models,
  skills,
  pendingSettings,
  disabledModes,
  composerFocusKey,
  pendingInsert,
  sessionTitle,
  sessionStatus,
  voice,
  onDismissVoiceError,
  pendingRestore,
  onRestored,
  bannerVisible,
  onHideBanner,
  skillSuggestion,
  onDismissSkillSuggestion,
  onInserted,
  pins,
  onPin: _onPin,
  onUnpin,
  onClearPins,
  onInput,
  onSubmit,
  onCancel,
  onDismissError,
  pendingPermission,
  onPermissionRespond,
  pendingDialog,
  onDialogRespond
}: ChatScreenProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const [, force] = useState(0);
  const [pendingRewind, setPendingRewind] = useState<{
    turnId: string;
    messagesAfter: number;
  } | null>(null);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{
    turnId: string;
    text: string;
    messagesAfter: number;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [remoteControl, setRemoteControl] = useState<RemoteControlStatus>({
    state: "off"
  });

  // The host is the only authority here: the bridge changes state without
  // anyone in the panel asking, when a device joins or the network drops.
  useEffect(
    () =>
      onMessage((m) => {
        if (m.type === "remoteControl") setRemoteControl(m.status);
      }),
    []
  );

  // Host-initiated "open connectors" command (from the `luno.openConnectors`
  // VS Code command). Listens for the RPC message and reveals the modal.
  useEffect(() => {
    return onMessage((m) => {
      if (m.type === "openConnectors") setConnectorsOpen(true);
    });
  }, []);
  // Session epoch — bumps when the timeline goes from non-empty → empty (i.e.
  // user clicked "New chat"). Wrapping the log content in AnimatePresence with
  // a key tied to this number gives a clean fade-out / fade-in on reset rather
  // than the messages just popping away.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  // A card the user clicked on the empty state. It never leaves this screen —
  // both the hero that raises it and the composer that consumes it are here.
  const [pendingPrefill, setPendingPrefill] = useState<string | null>(null);
  const prevEventCount = useRef(events.length);
  useEffect(() => {
    if (prevEventCount.current > 0 && events.length === 0) {
      setSessionEpoch((e) => e + 1);
    }
    prevEventCount.current = events.length;
  }, [events.length]);

  // If the timeline replaces (rewind / new session / load) and the message
  // being edited is gone, exit edit mode so we don't leave a dangling editor.
  useEffect(() => {
    if (editingTurnId && !events.some((e) => e.id === editingTurnId)) {
      setEditingTurnId(null);
    }
  }, [events, editingTurnId]);

  // Global keyboard shortcuts — Cmd/Ctrl+K opens palette, "?" opens hints.
  // We skip the "?" when the user is typing in a text field so it doesn't
  // hijack normal questions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField =
        document.activeElement &&
        ((document.activeElement as HTMLElement).tagName === "INPUT" ||
          (document.activeElement as HTMLElement).tagName === "TEXTAREA" ||
          (document.activeElement as HTMLElement).isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (!inField && e.key === "?" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setHintsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /** Per-turn user override. If absent, collapsed state is derived from the
   *  turn shape: completed turns auto-collapse, the active streaming turn
   *  stays expanded. User clicks set an explicit override that wins. */
  const [manualToggles, setManualToggles] = useState<
    Map<string, "expanded" | "collapsed">
  >(new Map());
  const toggleTurn = (turnId: string, currentlyCollapsed: boolean): void => {
    setManualToggles((m) => {
      const next = new Map(m);
      next.set(turnId, currentlyCollapsed ? "expanded" : "collapsed");
      return next;
    });
  };
  const isTurnCollapsed = (
    turnId: string,
    hasWork: boolean,
    isLatestTurn: boolean
  ): boolean => {
    const override = manualToggles.get(turnId);
    if (override) return override === "collapsed";
    // Active streaming turn — keep expanded so the user sees live work.
    if (isLatestTurn && busy) return false;
    // Completed turns with any work to hide — collapse by default.
    return hasWork;
  };

  const grouped = useMemo(() => groupEvents(events), [events]);
  // Persistent "working" loader for the whole turn — from submit, through the
  // pre-output thinking gap, while text streams, and during tool execution —
  // until the turn ends. Trails at the bottom of the log so it always reads as
  // "more is coming".
  const showThinking = busy;
  // The turn can end with the work still going: a `run_in_background` agent
  // lives in a process that outlives its turn. The verb line above is the
  // model's, so it goes at `turnEnd` — this is what keeps the header from
  // calling a conversation done while a workflow runs in it.
  const running = useMemo(() => liveAgents(taskProgress), [taskProgress]);
  // History first, live detail over it — `taskProgress` alone empties as soon
  // as a run ends, and the panel has to outlive the work it reports on.
  // Recomputed only when one of the two moves, which is also the only time any
  // of these numbers can change: every one of them is the CLI's own figure, and
  // none is a clock read.
  const agents = useMemo(
    () => agentPanel(mergeTaskState(grouped.subagents.byTaskId, taskProgress)),
    [grouped.subagents, taskProgress]
  );
  // The panel's reading, not `liveAgents`', so the header chip and the toolbar
  // button can never claim different things about the same work. Both sides of
  // this count agents through `runningUnits`; they differ only in the map they
  // read, and the host replays `subagentProgress` for every live task when a
  // panel attaches, so the two converge as soon as it does.
  const agentsRunning = agents.running > 0;
  const planContext = useMemo<RenderCtx>(
    () => ({
      views: grouped.views,
      ordered: grouped.ordered,
      subagents: grouped.subagents,
      questions: grouped.questions,
      taskProgress
    }),
    [grouped, taskProgress]
  );

  // Continue-from-here: seed the composer with a follow-up prompt anchored to
  // the excerpt of an assistant message. Onfocus the composer too so the user
  // can immediately type their follow-up.
  const handleContinueFromHere = (excerpt: string) => {
    const trimmed = excerpt.trim();
    if (!trimmed) return;
    onInput(`> ${trimmed.replace(/\n/g, "\n> ")}\n\n`);
    // composerFocusKey bump can't be done here (it's a prop), so we trigger a
    // microtask focus via the DOM.
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(
        '[contenteditable="true"]'
      );
      el?.focus();
    });
  };

  // Diff-line comment: append a structured note to the composer so the next
  // prompt naturally carries the file/line context. Keeps everything else
  // the user has typed intact — just slots the note in below.
  const handleAddDiffNote = (note: import("./modals/FileDiffModal").DiffLineNote) => {
    const fileName = note.path.split("/").pop() ?? note.path;
    const chunk = `On \`${fileName}:${note.lineNo}\` (\`${note.context.trim().slice(0, 80)}\`): ${note.text}`;
    const prefix = input.trim() ? input.trimEnd() + "\n\n" : "";
    onInput(prefix + chunk + "\n");
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(
        '[contenteditable="true"]'
      );
      el?.focus();
    });
  };

  useEffect(() => {
    if (userScrolled.current) return;
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [grouped, streaming, showThinking]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolled.current = !nearBottom;
    force((n) => n + 1);
  };

  return (
    <>
      <Header
        title={sessionTitle}
        storedStatus={sessionStatus}
        busy={busy}
        awaitingApproval={pendingPermission !== null}
        errored={error !== null}
        agentsRunning={agentsRunning}
        agentCount={agents.running}
        onOpenAgents={() => setAgentsOpen(true)}
        events={events}
        streaming={streaming}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenConnectors={() => setConnectorsOpen(true)}
        onOpenPermissions={() => setPermissionsOpen(true)}
        remoteControl={remoteControl}
      />

      {bannerVisible && <ConventionsBanner onHideForSession={onHideBanner} />}

      {skillSuggestion && (
        <SkillSuggestion
          skillId={skillSuggestion.skillId}
          skillName={skillSuggestion.skillName}
          reason={skillSuggestion.reason}
          taskType={skillSuggestion.taskType}
          onDismiss={onDismissSkillSuggestion}
        />
      )}

      <div className={s.screen}>
        <div ref={logRef} onScroll={onScroll} className={s.log}>
          <AnimatePresence mode="wait" initial={false}>
            {grouped.groups.length === 0 && !streaming && (
              <motion.div
                key={`empty-${sessionEpoch}`}
                {...ENTER_CARD}
                // Kept: the hero lifts away as the first message lands, and
                // `mode="wait"` needs an exit. ENTER_CARD has none of its own.
                exit={{ opacity: 0, y: -TRAVEL.md }}
                className={s.center}
              >
                <EmptyState onPick={setPendingPrefill} />
              </motion.div>
            )}
          </AnimatePresence>
          {grouped.groups.map((g, i) => {
            const isLatestTurn =
              g.kind === "turn" &&
              !grouped.groups.slice(i + 1).some((x) => x.kind === "turn");
            const isEditing = g.kind === "user" && g.id === editingTurnId;
            if (isEditing && g.kind === "user") {
              const messagesAfter = grouped.groups.length - i - 1;
              return (
                <InlineMessageEditor
                  key={g.id}
                  initialText={g.text}
                  busy={busy}
                  model={model}
                  permissionMode={permissionMode}
                  models={models}
                  skills={skills}

                  onCancel={() => setEditingTurnId(null)}
                  onSubmit={(text) => {
                    setPendingEdit({ turnId: g.id, text, messagesAfter });
                  }}
                />
              );
            }
            return renderGroup(
              g,
              i,
              grouped.groups,
              planContext,
              (turnId, messagesAfter) =>
                setPendingRewind({ turnId, messagesAfter }),
              (turnId) => setEditingTurnId(turnId),
              isTurnCollapsed,
              toggleTurn,
              isLatestTurn,
              handleContinueFromHere,
              handleAddDiffNote
            );
          })}
          {streaming && (
            <div className={s.rail}>
              <AssistantMessage text={streaming} streaming showAvatar={false} />
            </div>
          )}
          {showThinking && <ThinkingIndicator />}
          {error && <ErrorBanner text={error} onDismiss={onDismissError} />}
        </div>

        <AnimatePresence>
          {userScrolled.current && (
            <motion.button
              key="scroll-bottom"
              type="button"
              className={s.fab}
              style={{
                boxShadow:
                  "0 4px 18px var(--accent-shadow), 0 12px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.08) inset"
              }}
              aria-label="Scroll to bottom"
              {...ENTER_CARD}
              // The FAB has always popped in from 0.85 and dropped away as it
              // goes. Those scales are design, not timing, so they ride along
              // with ENTER_CARD's rise; only the travel and curve converge.
              initial={{ ...ENTER_CARD.initial, scale: 0.85 }}
              animate={{ ...ENTER_CARD.animate, scale: 1 }}
              exit={{ opacity: 0, y: TRAVEL.sm, scale: 0.9 }}
              // Hover and press are their own roles, but the element-level
              // `transition` is already spoken for by the enter — so each
              // gesture carries its timing on the target instead.
              whileHover={{
                y: -2,
                scale: 1.05,
                transition: { duration: DURATION.hover, ease: EASE_OUT }
              }}
              whileTap={{ ...PRESS.whileTap, transition: PRESS.transition }}
              onClick={() => {
                userScrolled.current = false;
                const el = logRef.current;
                if (el)
                  el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                force((n) => n + 1);
              }}
            >
              <Icon name="arrowDown" size={14} strokeWidth={2} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <RewindModal
        pending={pendingRewind}
        agents={running}
        onCancel={() => setPendingRewind(null)}
        onConfirm={() => {
          if (pendingRewind) {
            send({ type: "rewindTo", turnId: pendingRewind.turnId });
          }
          setPendingRewind(null);
        }}
      />

      <EditConfirmModal
        pending={pendingEdit}
        agents={running}
        onCancel={() => setPendingEdit(null)}
        onDontRevert={() => {
          if (pendingEdit) {
            send({
              type: "editAt",
              turnId: pendingEdit.turnId,
              text: pendingEdit.text,
              revertFiles: false
            });
          }
          setPendingEdit(null);
          setEditingTurnId(null);
        }}
        onRevert={() => {
          if (pendingEdit) {
            send({
              type: "editAt",
              turnId: pendingEdit.turnId,
              text: pendingEdit.text,
              revertFiles: true
            });
          }
          setPendingEdit(null);
          setEditingTurnId(null);
        }}
      />

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelect={(id) => {
          send({ type: "loadSession", id });
          setHistoryOpen(false);
        }}
      />

      <ConnectorsModal
        open={connectorsOpen}
        onClose={() => setConnectorsOpen(false)}
      />

      <PermissionsModal
        open={permissionsOpen}
        onClose={() => setPermissionsOpen(false)}
      />

      <KeyboardHints open={hintsOpen} onClose={() => setHintsOpen(false)} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        models={models}
        skills={skills}
        permissionMode={permissionMode}
        disabledModes={disabledModes}
        onLoadSession={(id) => send({ type: "loadSession", id })}
        onOpenKeyboardHints={() => setHintsOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      <BackgroundAgentsModal
        open={agentsOpen}
        panel={agents}
        onClose={() => setAgentsOpen(false)}
        // The same door the composer's Stop uses, so the confirmation that
        // names what is about to be lost is reached either way — and there is
        // exactly one path that sends the interrupt.
        onStopAll={() => {
          setAgentsOpen(false);
          onCancel();
        }}
      />

      <div
        className={s.dock}
        style={{
          boxShadow: "0 -8px 24px -16px rgba(0,0,0,0.55)"
        }}
      >
        <AnimatePresence>
          {pendingPermission && (
            <PermissionRequest
              key={pendingPermission.requestId}
              request={pendingPermission}
              onRespond={onPermissionRespond}
            />
          )}
          {/* Below the approval on purpose: a tool waiting to run is the more
              urgent of the two, and both blocking at once is rare enough that
              stacking beats choosing. */}
          {pendingDialog?.kind === "fable_overage_consent_prompt" && (
            <FableOverageDialog
              key={pendingDialog.requestId}
              dialog={pendingDialog}
              onRespond={onDialogRespond}
            />
          )}
        </AnimatePresence>
        <PinnedContext
          pins={pins}
          onRemove={onUnpin}
          onClearAll={onClearPins}
        />
        <ContextStrip
          context={editorContext}
          pinned={pins.some(
            (p) => editorContext && p.path === editorContext.file
          )}
          onPin={() => {
            if (!editorContext) return;
            _onPin({
              path: editorContext.file,
              label: editorContext.file.split("/").pop() ?? editorContext.file
            });
          }}
          onUnpin={() => editorContext && onUnpin(editorContext.file)}
        />
        <Composer
          value={input}
          onChange={onInput}
          onSubmit={(text) => {
            userScrolled.current = false;
            // `/rc` never reaches the model. It is a command to this panel, and
            // the CLI does not expose it over stream-json anyway — it is absent
            // from the slash-command list a headless session reports, so sending
            // it as a prompt would just make the model read the words.
            if (isRemoteControlCommand(text)) {
              send({
                type: "toggleRemoteControl",
                enabled: remoteControl.state === "off"
              });
              return;
            }
            onSubmit(text);
          }}
          onCancel={onCancel}
          busy={busy}

          model={model}
          resolvedModels={resolvedModels}
          permissionMode={permissionMode}
          effort={effort}
          thinking={thinking}
          ultracode={ultracode}
          models={models}
          skills={skills}
          pendingSettings={pendingSettings}
          disabledModes={disabledModes}
          focusKey={composerFocusKey}
          pendingInsert={pendingInsert}
          onInserted={onInserted}
          voice={voice}
          onDismissVoiceError={onDismissVoiceError}
          pendingRestore={pendingRestore}
          onRestored={onRestored}
          pendingPrefill={pendingPrefill}
          onPrefilled={() => setPendingPrefill(null)}
          agents={agents}
          onOpenAgents={() => setAgentsOpen(true)}
        />
      </div>
    </>
  );
}
