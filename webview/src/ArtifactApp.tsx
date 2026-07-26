// ─────────────────────────────────────────────────────────────
// Plan artifact shell — mounted into a VS Code editor tab via
// PlanArtifactManager. Reads timeline events posted by the host
// (the chat panel's session is the canonical source) and folds
// them into the plan revisions, then renders the matching
// PlanFullView for `revisionId`.
//
// Mutations (planComment, planAcceptStep, planEditComment, …)
// flow back through the standard `send()` RPC layer; the host
// routes them into the same handlers the chat sidebar uses, and
// re-posts the resulting event to every open panel — including
// this one. Round-trip stays well under 16 ms in practice.
// ─────────────────────────────────────────────────────────────

import { useEffect, useReducer, useMemo } from "react";
import { onMessage, send, TimelineEvent } from "./lib/rpc";
import { foldPlanState, PlanFullView } from "./features/plan";
import s from "./ArtifactApp.module.scss";

interface Props {
  revisionId: string;
}

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
      const next = state.slice();
      next[idx] = action.event;
      return next;
    }
    case "replace":
      return action.events;
  }
}

export function ArtifactApp({ revisionId }: Props) {
  const [events, dispatch] = useReducer(timelineReducer, []);

  useEffect(() => {
    const off = onMessage((m) => {
      switch (m.type) {
        case "loadedSession":
          dispatch({ type: "replace", events: m.events });
          break;
        case "timeline":
          dispatch({ type: "append", event: m.event });
          break;
        case "rewind":
          dispatch({ type: "replace", events: m.events });
          break;
        case "reset":
          dispatch({ type: "reset" });
          break;
      }
    });
    // Handshake: ask the host for the current timeline. We do this *after*
    // attaching the listener so the response can't race past us. The host
    // looks up our panel by revisionId and posts loadedSession directly.
    send({ type: "requestArtifactState", revisionId });
    return off;
  }, [revisionId]);

  const revisions = useMemo(() => foldPlanState(events), [events]);
  const idx = revisions.findIndex((v) => v.meta.revisionId === revisionId);
  const view = idx >= 0 ? revisions[idx] : undefined;
  const previous = idx > 0 ? revisions[idx - 1] : undefined;
  const isLatest = idx === revisions.length - 1;

  if (!view) {
    return (
      <div className={s.empty}>
        <div className={s.emptyTitle}>Plan revision not found</div>
        <div className={s.emptyBody}>
          The plan you opened may have been rewound or replaced. Reopen it from
          the chat panel to see the current state.
        </div>
      </div>
    );
  }

  return (
    // `artifact-shell` stays global — theme.css hangs the artifact-mode plan
    // overrides off it, and those are the plan feature's to own.
    <div className={`artifact-shell ${s.shell}`}>
      <PlanFullView
        view={view}
        previous={previous}
        isLatest={isLatest}
        ordinal={idx + 1}
        onCollapse={() => {
          // In artifact mode "collapse" doesn't make sense — close the tab
          // instead by sending a no-op message; the host doesn't need to
          // do anything because VS Code closes when the user clicks ✕ on
          // the tab itself.
          send({ type: "refreshAuth" }); // keep the connection warm
        }}
      />
    </div>
  );
}
