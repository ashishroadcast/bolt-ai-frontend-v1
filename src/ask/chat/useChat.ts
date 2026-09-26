import { useCallback, useEffect, useRef, useState } from "react";
import { useAskClient } from "../config.tsx";
import type { UIPart } from "../parts/catalog.tsx";
import { fetchConversation } from "./conversation.ts";
import { buildPhaseTimeline, readPhaseDetail, type PhaseTimelineEvent } from "./phaseTimeline.ts";
import { readDataStream, type DataChunk, type UsageMetadata } from "./protocol.ts";
import { postAgentRun } from "./runStream.ts";
import { buildRunTrace, EMPTY_TRACE, type TraceEvent } from "./runTrace.ts";
import type { ActiveRun, ChatMessage, RunSummary } from "./types.ts";
import { toUIPart } from "./wireParts.ts";

export interface UseChatResult {
  messages: ChatMessage[];
  /** The run currently in flight, or `null` between runs. `Thread.tsx`
   * renders the expanded rail from this and only this — see the module
   * docstring for why that alone is what keeps a reopened conversation
   * from ever showing it. */
  activeRun: ActiveRun | null;
  status: "idle" | "streaming";
  /** The last send-level failure (couldn't even start a run) — distinct
   * from a run that started and then errored, which lands as a message
   * with `runSummary.status === "error"` instead, since that failure has
   * a place in the thread and this one doesn't. */
  error: string | null;
  sendMessage: (text: string, options?: { agent?: string }) => void;
  loadConversation: (conversationId: number) => Promise<void>;
  /**
   * Who the Ask screen is currently talking to (a `GET /agent/agents`
   * *name*, not an id — `POST /agent/run`'s `RunIn.agent` is name-keyed;
   * see `chat/runStream.ts`'s own note). Lives here, not in `AskRoute`
   * local state, because `Composer` (which reads it to build the
   * `sendMessage` call) and `AgentPicker` (which sets it) are both
   * consumers of this same context but not of each other. `null` until
   * `AgentPicker` resolves a first default — see that component for why a
   * console with no agents at all must never send a run with this unset.
   */
  selectedAgent: string | null;
  setSelectedAgent: (name: string | null) => void;
  /** The conversation id the thread currently on screen was loaded from
   * (`loadConversation`'s own argument), or `null` for a thread that
   * hasn't been tied to a persisted conversation yet — a run started
   * fresh from the composer, before the server has told this client any
   * id back (`runStream.ts`'s own note: `POST /agent/run` never returns
   * one). `HistoryPanel.tsx` reads this to know whether the conversation
   * a delete just removed is the one currently open, so it can clear the
   * thread instead of leaving it pointed at a row that no longer exists. */
  activeConversationId: number | null;
  /** Resets the thread to the empty state without touching anything
   * server-side — used when the conversation currently open gets deleted
   * out from under it (`HistoryPanel.tsx`), so a stray next message
   * doesn't get sent with a `session_id` for a conversation that's gone. */
  clearConversation: () => void;
}

let localIdCounter = 0;
function nextLocalId(prefix: string): string {
  localIdCounter += 1;
  return `${prefix}-${localIdCounter}`;
}

/**
 * Drives one `/agent/run` turn end to end and exposes the two-way split the
 * whole design rests on (design plan §10.1; task brief "The distinction
 * this whole design rests on"):
 *
 * - **Transient `data-phase` parts never leave `activeRun`.** They are
 *   folded into `phaseTimeline.buildPhaseTimeline`'s `events` — a
 *   function-local array, not component state, and never copied onto a
 *   `ChatMessage`. The *only* place a finished run's phase detail survives
 *   at all is `ChatMessage.runSummary.segments`, attached once, by this
 *   hook, from data this hook itself observed live — never from anything
 *   `conversation.hydrateMessages` produces, because a reopened message's
 *   `meta.ui_parts` was never given transient parts to begin with
 *   (`StreamWriter.persisted_parts`, agent-service's own guarantee).
 * - **Persisted `data-*` parts become `ChatMessage.parts`**, the same
 *   `UIPart[]` shape `renderUIPart` (`../components/catalog.tsx`) expects,
 *   whether they arrived live or were hydrated from history.
 *
 * `activeRun` is cleared the instant `finish`/`error` (or an unexplained
 * end of stream) lands, and that same instant is when the finished
 * `ChatMessage` — carrying `runSummary` — is appended. There is no
 * intermediate "just finished, still expanded" state to accidentally
 * render: the rail's live view and a message's collapsed summary are
 * mutually exclusive by construction, not by a flag `Thread.tsx` has to
 * check correctly.
 */
export function useChat(): UseChatResult {
  const client = useAskClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [status, setStatus] = useState<"idle" | "streaming">("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);

  const isStreamingRef = useRef(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<number | null>(null);

  useEffect(() => {
    // Sets the ref back to true on every (re)mount — not just once at
    // useRef's initializer — because StrictMode's dev-only mount -> cleanup
    // -> remount simulation runs that cleanup for real. Without this line
    // the cleanup below still flips mountedRef.current to false during the
    // simulated unmount, and nothing ever flips it back for the real mount
    // that follows: every `if (mountedRef.current) setX(...)` guard in this
    // hook (loadConversation's setMessages, runTurn's updateActiveRun and
    // finalize) then silently no-ops for the rest of the session, even
    // though the provider is genuinely mounted and on screen. That was the
    // actual "chat history not opening" bug (this task's report) — a
    // successful GET /agent/conversations/{id} hydrated correctly, but the
    // guard dropped the setMessages call that would have shown it.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // The one real cancel mechanism (`app.api.run`'s own docstring:
      // "there is no cancel endpoint... cancellation is closing the
      // connection") — fired only when this provider itself unmounts
      // (session end), never on an ordinary route change elsewhere in the
      // console. See this task's report for why the provider is scoped
      // above the router rather than to the /ask route.
      abortRef.current?.abort();
    };
  }, []);

  const runTurn = useCallback(async (text: string, options?: { agent?: string }) => {
    isStreamingRef.current = true;
    setStatus("streaming");
    setError(null);

    const runStartAt = Date.now();
    const userMessage: ChatMessage = {
      id: nextLocalId("user"),
      role: "user",
      content: text,
      parts: [],
      createdAt: runStartAt,
    };
    setMessages((prev) => [...prev, userMessage]);

    const events: PhaseTimelineEvent[] = [{ kind: "run-start", at: runStartAt }];
    // The second, richer event log (`runTrace.ts`): `events` above sizes
    // the inspector's time-proportional segments and deliberately keeps
    // only what a bar needs, while this one keeps every field a phase or
    // tool part actually carried — the SQL, the judge's reasoning, the
    // tool arguments. Two logs rather than one widened log because the
    // segment builder is shared with `shell/Inspector.tsx`, which is not
    // this task's to change.
    const traceEvents: TraceEvent[] = [];
    const partsAcc: UIPart[] = [];
    let textAcc = "";
    // Transient: never persisted, never part of the message — see
    // ActiveRun.thought.
    let thoughtAcc = "";
    let messageId = nextLocalId("run");
    let sawTerminal = false;
    // Never DEFAULT_AGENT_NAME: the server's own fallback is not something
    // this client observed, and naming an agent that may not exist is a
    // worse answer to "who am I chatting with" than naming none. See
    // RunSummary.agentName.
    //
    // A starting guess only — `options?.agent` is unset for most runs now
    // (auto-routed by `app.api.run._choose_agent`), so this gets overwritten
    // by the "start" chunk's own `messageMetadata.agent_name` the moment it
    // arrives, which is the server's actual decision rather than this
    // client's request.
    let agentName = options?.agent ?? null;

    setActiveRun({
      messageId,
      status: "streaming",
      startedAt: Date.now(),
      segments: [],
      trace: EMPTY_TRACE,
      text: "",
      thought: "",
      parts: [],
      agentName,
    });

    const updateActiveRun = (patch: Partial<ActiveRun>) => {
      if (!mountedRef.current) return;
      setActiveRun((prev) => (prev ? { ...prev, ...patch } : prev));
    };

    const finalize = (summary: RunSummary, usage: UsageMetadata | null) => {
      const finalMessage: ChatMessage = {
        id: messageId,
        role: "assistant",
        content: textAcc,
        parts: [...partsAcc],
        createdAt: runStartAt,
        runSummary: summary,
        usage,
      };
      if (!mountedRef.current) return;
      setMessages((prev) => [...prev, finalMessage]);
      setActiveRun(null);
    };

    const summaryFrom = (outcome: "done" | "error", errorText: string | null) => {
      const segments = buildPhaseTimeline(events);
      const totalMs =
        segments.length > 0
          ? segments[segments.length - 1]!.endedAt - segments[0]!.startedAt
          : Date.now() - runStartAt;
      const trace = buildRunTrace(traceEvents);
      return { status: outcome, totalMs, errorText, segments, trace, agentName } satisfies RunSummary;
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await postAgentRun(
        client,
        { message: text, agent: options?.agent, session_id: conversationIdRef.current ?? undefined },
        { signal: controller.signal },
      );

      for await (const chunk of readDataStream(response.body!)) {
        switch (chunk.type) {
          case "start": {
            messageId = chunk.messageId;
            const resolvedAgent = chunk.messageMetadata?.agent_name;
            if (typeof resolvedAgent === "string") agentName = resolvedAgent;
            updateActiveRun({ messageId, agentName });
            break;
          }
          case "text-delta": {
            textAcc += chunk.delta;
            updateActiveRun({ text: textAcc });
            break;
          }
          case "tool-input-available": {
            const at = Date.now();
            events.push({ kind: "tool", at });
            traceEvents.push({
              kind: "tool-input",
              at,
              callId: chunk.toolCallId,
              name: chunk.toolName,
              input: chunk.input,
            });
            updateActiveRun({ segments: buildPhaseTimeline(events), trace: buildRunTrace(traceEvents) });
            break;
          }
          case "tool-output-available": {
            const at = Date.now();
            events.push({ kind: "tool", at });
            traceEvents.push({ kind: "tool-output", at, callId: chunk.toolCallId, output: chunk.output });
            updateActiveRun({ segments: buildPhaseTimeline(events), trace: buildRunTrace(traceEvents) });
            break;
          }
          case "finish": {
            sawTerminal = true;
            events.push({ kind: "run-end", at: Date.now() });
            finalize(summaryFrom("done", null), chunk.messageMetadata?.usage ?? null);
            break;
          }
          case "error": {
            sawTerminal = true;
            events.push({ kind: "run-end", at: Date.now() });
            finalize(summaryFrom("error", chunk.errorText), null);
            break;
          }
          default: {
            if (!chunk.type.startsWith("data-")) break;
            const dataChunk = chunk as DataChunk;
            if (dataChunk.transient) {
              if (dataChunk.type === "data-phase") {
                const data = dataChunk.data;
                const phase = typeof data.phase === "string" ? data.phase : "";
                const at = Date.now();
                events.push({
                  kind: "phase",
                  at,
                  phase,
                  state: typeof data.state === "string" ? data.state : undefined,
                  score: typeof data.score === "number" ? data.score : undefined,
                  tokens: typeof data.tokens === "number" ? data.tokens : undefined,
                  durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
                  // What the phase produced — the Inspector shows this
                  // when a phase in the rail is clicked.
                  detail: readPhaseDetail(data),
                });
                // Verbatim, not the five fields `events` picked out: the
                // SQL, sql_params, plan_gate and the judge's reasoning all
                // ride this same part (`pipeline._phase_event`), and the
                // reasoning card and debug panel need every one of them.
                traceEvents.push({ kind: "phase", at, data });
                updateActiveRun({
                  segments: buildPhaseTimeline(events),
                  trace: buildRunTrace(traceEvents),
                });
              }
              if (dataChunk.type === "data-thought") {
                const delta = dataChunk.data.delta;
                if (typeof delta === "string" && delta !== "") {
                  thoughtAcc += delta;
                  updateActiveRun({ thought: thoughtAcc });
                }
              }
              // Any other transient data-* type has no rail mechanism yet
              // — dropped, the same forward-compatible discard protocol
              // parseChunk applies to a chunk type it doesn't know.
            } else {
              partsAcc.push(toUIPart(dataChunk.type, dataChunk.data));
              updateActiveRun({ parts: [...partsAcc] });
            }
          }
        }
      }

      // The stream ended (reader EOF) without a finish or error chunk —
      // a dropped connection, a proxy that closed early, or a backend
      // crash mid-run. "A half-drawn rail that never resolves is the
      // failure users will actually hit" (task brief) — this is exactly
      // the case that guards against, by finalizing as a legible failure
      // rather than leaving activeRun.status stuck at "streaming" forever.
      if (!sawTerminal) {
        events.push({ kind: "run-end", at: Date.now() });
        finalize(summaryFrom("error", "Connection closed before the run finished."), null);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // A deliberate cancel (provider unmount) — not a failure the
        // operator caused, so nothing renders and nothing needs undoing:
        // the assistant message simply never gets appended.
        return;
      }
      const message = err instanceof Error ? err.message : "Asking failed unexpectedly.";
      if (mountedRef.current) {
        finalize(summaryFrom("error", message), null);
        setError(message);
      }
    } finally {
      abortRef.current = null;
      isStreamingRef.current = false;
      if (mountedRef.current) setStatus("idle");
    }
  }, []);

  const sendMessage = useCallback(
    (text: string, options?: { agent?: string }) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      if (isStreamingRef.current) {
        setError("Wait for this run to finish before asking again.");
        return;
      }
      void runTurn(trimmed, options);
    },
    [runTurn],
  );

  const loadConversation = useCallback(async (conversationId: number) => {
    const hydrated = await fetchConversation(client, conversationId);
    conversationIdRef.current = conversationId;
    if (mountedRef.current) {
      setMessages(hydrated);
      setActiveConversationId(conversationId);
    }
  }, []);

  const clearConversation = useCallback(() => {
    conversationIdRef.current = null;
    setActiveConversationId(null);
    setMessages([]);
    setActiveRun(null);
  }, []);

  return {
    messages,
    activeRun,
    status,
    error,
    sendMessage,
    loadConversation,
    selectedAgent,
    setSelectedAgent,
    activeConversationId,
    clearConversation,
  };
}
