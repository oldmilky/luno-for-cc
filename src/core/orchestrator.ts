// ─────────────────────────────────────────────────────────────
// Orchestrator — drives one user turn through the Claude CLI
// provider.
//
// The CLI owns tool execution end-to-end; this loop just streams
// the provider's output, splits text vs tool_use blocks, lets the
// PlanInterceptor convert the special planning tools into structured
// timeline events, and accumulates the assistant message history.
//
// Two ways in, one loop: `turn` sends a prompt and reads the answer,
// `observe` reads an answer to a prompt another surface sent. With
// Remote Control on, both surfaces drive the same CLI process, and a
// turn is a turn whichever of them started it.
//
// Earlier versions had a parallel `runInternal` path for the
// Anthropic-Messages-API fork where we ran tools in-process. That
// fork is gone — there's a single CLI provider and the orchestrator
// is correspondingly slim.
// ─────────────────────────────────────────────────────────────

import { ContentBlock, StreamDelta } from "./types.js";
import { Session } from "./session.js";
import { ChatProvider, ProviderRequest } from "../providers/base.js";
import { PlanInterceptor } from "./plan-intercept.js";

export interface OrchestratorOpts {
  provider: ChatProvider;
  model: string;
  maxTokens: number;
  onDelta?: (d: StreamDelta) => void;
}

export class Orchestrator {
  cancelled = false;

  constructor(
    private session: Session,
    private o: OrchestratorOpts
  ) {}

  cancel() {
    this.cancelled = true;
  }

  async turn(userText: string): Promise<void> {
    // Awaited so checkpoint capture (registered via session.onUserTurn)
    // finishes before the agent starts firing tool calls. Otherwise the
    // first write can race the snapshot and we lose pre-state for rewind.
    await this.session.addUser(userText);

    const req: ProviderRequest = {
      model: this.o.model,
      maxTokens: this.o.maxTokens,
      messages: this.session.messages,
      tools: []
    };

    await this.consume(this.o.provider.stream(req));
  }

  /**
   * A turn this panel did not start.
   *
   * The prompt was typed on a connected phone or on claude.ai/code, and the CLI
   * — one long-lived process, shared by both surfaces — is already answering it.
   * Nothing is written to the provider here; the deltas are handed in from
   * wherever they were read. Everything after that is the same turn the local
   * path runs, and deliberately so: a remote turn gets the same checkpoint, the
   * same plan interception and the same message history, or rewinding across
   * one would restore a state the timeline no longer describes.
   */
  async observe(
    userText: string,
    stream: AsyncIterable<StreamDelta>
  ): Promise<void> {
    await this.session.addUser(userText);
    await this.consume(stream);
  }

  private async consume(stream: AsyncIterable<StreamDelta>): Promise<void> {
    const blocks: ContentBlock[] = [];
    let currentTool: { id: string; name: string; inputBuf: string } | null =
      null;
    const seenAssistantBlockIds = new Set<string>();
    const planIntercept = new PlanInterceptor(this.session);
    let textBuf = "";

    /**
     * @param meta stamped onto the emitted event. Only the cancel path uses it,
     *   and only to say the answer was cut off: a flushed partial reply is
     *   otherwise indistinguishable from a finished one, so anything reading
     *   the tail of a timeline would call a stopped turn complete.
     */
    const flushText = (meta?: Record<string, unknown>) => {
      if (!textBuf) return;
      blocks.push({ type: "text", text: textBuf });
      this.session.emit({
        kind: "assistant",
        title: "Assistant",
        body: textBuf,
        ...(meta ? { meta } : {})
      });
      textBuf = "";
    };

    for await (const delta of stream) {
      // A cancelled turn keeps whatever the model already said. Text sits in
      // `textBuf` until a tool call or the end of the stream flushes it, so
      // returning straight out threw away a partial answer the user had already
      // watched arrive — Stop, rewind, edit and switching session all land here.
      // `messages` stays untouched on purpose, exactly as the `error` case
      // below does: a half-finished block sequence is not safe to feed back as
      // context for the next turn.
      if (this.cancelled) {
        flushText({ interrupted: true });
        return;
      }
      this.o.onDelta?.(delta);
      switch (delta.type) {
        case "text":
          if (delta.text) textBuf += delta.text;
          break;
        case "tool_use_start":
          flushText();
          currentTool = {
            id: delta.tool!.id,
            name: delta.tool!.name,
            inputBuf: ""
          };
          break;
        case "tool_use_input":
          if (currentTool) currentTool.inputBuf += delta.partialInput ?? "";
          break;
        case "tool_use_end":
          if (currentTool) {
            let input: Record<string, unknown>;
            try {
              input = currentTool.inputBuf
                ? JSON.parse(currentTool.inputBuf)
                : {};
            } catch {
              input = {};
            }
            blocks.push({
              type: "tool_use",
              id: currentTool.id,
              name: currentTool.name,
              input
            });
            // Plan-mode tools (ExitPlanMode / TodoWrite / AskUserQuestion)
            // become structured plan_* events instead of generic tool_calls.
            const intercepted = planIntercept.consume(
              currentTool.name,
              currentTool.id,
              input
            );
            if (!intercepted && !seenAssistantBlockIds.has(currentTool.id)) {
              seenAssistantBlockIds.add(currentTool.id);
              this.session.emitToolCall(
                currentTool.id,
                currentTool.name,
                input
              );
            }
            currentTool = null;
          }
          break;
        case "tool_result":
          if (delta.toolUseId) {
            // Suppress synthetic tool_result rendering for intercepted plan
            // events — the PlanCard already conveys approval / answer state.
            if (planIntercept.interceptedToolIds.has(delta.toolUseId)) break;
            this.session.addToolResult(
              delta.toolUseId,
              delta.resultContent ?? "",
              !!delta.resultIsError
            );
          }
          break;
        case "error":
          flushText();
          this.session.emit({
            kind: "error",
            title: "Provider error",
            body: delta.error
          });
          return;
      }
    }

    flushText();
    planIntercept.flush();

    // Persist the full block sequence into messages history (used as
    // context for any follow-up turn the user sends).
    if (blocks.length > 0) {
      this.session.messages.push({ role: "assistant", content: blocks });
    }
  }
}
