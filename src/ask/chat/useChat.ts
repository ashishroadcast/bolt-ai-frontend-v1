import { useCallback, useEffect, useRef, useState } from "react";
import { useAskClient, useAskConfig, type AskHostContext } from "../config.tsx";
import type { UIPart } from "../parts/catalog.tsx";
import { fetchConversation } from "./conversation.ts";
import { buildPhaseTimeline, readPhaseDetail, type PhaseTimelineEvent } from "./phaseTimeline.ts";
import { readDataStream, type DataChunk, type UsageMetadata } from "./protocol.ts";
import { isMissingConversationError, postAgentRun } from "./runStream.ts";
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
  /**
   * Something the reader should know about the last send that is not a
   * failure — today only that a follow-up could not continue its
   * conversation and started a new one instead. Cleared by the next send,
   * and by opening or starting a conversation. `Composer` shows it, since
   * it is about what just happened to the question the reader sent.
   */
  notice: string | null;
  sendMessage: (text: string, options?: SendOptions) => void;
  /**
   * Ends the run in flight at the reader's request. Closing the connection
   * is the only cancel `POST /agent/run` has (`app.api.run`'s docstring), so
   * that is what this does; the turn then lands as `runSummary.status ===
   * "stopped"`, keeping whatever text and parts had already arrived. A no-op
   * between runs.
   */
  stop: () => void;
  /** Replaces the thread with a persisted conversation. A run still in
   * flight is let go once the conversation has loaded — its answer belonged
   * to the thread being replaced — and any slash-armed agent is disarmed. */
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
  /** The persisted conversation the thread on screen belongs to: the id
   * `loadConversation` opened, or the one the server named in a fresh
   * thread's first "start" chunk (`messageMetadata.session_id`). `null`
   * only for a thread no run has been started in yet. Every follow-up is
   * sent with it, which is what gives the agent the earlier turns.
   * `HistoryPanel.tsx` also reads this to know whether the conversation
   * a delete just removed is the one currently open, so it can clear the
   * thread instead of leaving it pointed at a row that no longer exists. */
  activeConversationId: number | null;
  /** Resets the thread to the empty state — "New conversation", and when the
   * conversation currently open gets deleted out from under it
   * (`HistoryPanel.tsx`), so a stray next message doesn't get sent with a
   * `session_id` for a conversation that's gone. Nothing is deleted
   * server-side; a run still in flight is closed and appends nothing. */
  clearConversation: () => void;
}

export interface SendOptions {
  agent?: string;
  /**
   * Leave `selectedWidgetId` out of this one run's `host_context` — the
   * composer's context chip was dismissed, so this question is not about
   * that widget even though the builder still has it selected.
   */
  omitSelectedWidget?: boolean;
}

/**
 * The host's description of its screen, for one run — or null to send none.
 *
 * Read per run, never cached: the builder's canvas and selection change
 * between questions. A host whose provider throws gets a run without context
 * rather than no run at all; the context sharpens an answer, it is never what
 * makes one possible.
 */
function readHostContext(
  provider: (() => AskHostContext | null) | undefined,
  omitSelectedWidget: boolean,
): AskHostContext | null {
  let context: AskHostContext | null;
  try {
    context = provider?.() ?? null;
  } catch {
    return null;
  }
  if (context === null || typeof context !== "object") return null;
  if (!omitSelectedWidget || context.selectedWidgetId === undefined) return context;
  const withoutSelection = { ...context };
  delete withoutSelection.selectedWidgetId;
  return withoutSelection;
}

let localIdCounter = 0;
function nextLocalId(prefix: string): string {
  localIdCounter += 1;
  return `${prefix}-${localIdCounter}`;
}

/**
 * How long a run may say nothing at all — no chunk, and not the server's
 * `: keepalive` either — before it is treated as gone.
 *
 * agent-service writes that keepalive after every five seconds of silence
 * (`protocol.py`'s `HEARTBEAT_SECONDS`), so twenty is four missed in a row:
 * a model thinking hard still beats every five seconds, while a connection
 * that died with a sleeping laptop, or a proxy that half-closed it, beats
 * never. Without this the second case showed "working" forever.
 */
const STALL_TIMEOUT_MS = 20_000;
const LOST_CONNECTION = "Lost connection to the run.";
const CONVERSATION_RESTARTED = "That conversation can't be continued, so this started a new one.";

export interface UseChatOptions {
  /** `STALL_TIMEOUT_MS`, overridable so a test can watch a run stall
   * without waiting twenty real seconds. Nothing else should set it. */
  stallTimeoutMs?: number;
}

/** Why this hook itself aborted a run: the reader asked, or the run went
 * silent. An abort with no reason recorded is an unmount, which appends
 * nothing at all. */
type EndReason = "stopped" | "stalled";

interface InFlightRun {
  end: (reason: EndReason) => void;
  /** Takes this run out of `runsInFlight`. Idempotent: the run's own
   * `finally` and `discardRun` may both call it. */
  release: () => void;
}

/**
 * Runs streaming right now, across every `useChat` on the page.
 *
 * Module state, on purpose, and read only through the two functions below:
 * the console's organisation switch reloads the page, and it sits in the top
 * bar, nowhere near a `ChatProvider` it could ask. A counter rather than a
 * flag because a page can hold more than one Ask.
 */
let runsInFlight = 0;
let unloadConfirmed = false;

/** Whether a reload now would cut off an answer still being written. */
export function isAskRunInFlight(): boolean {
  return runsInFlight > 0;
}

/**
 * For a caller that has already asked the reader, in its own words, whether
 * to leave mid-run and been told yes — so the browser's generic "Leave site?"
 * prompt does not ask them a second time on the reload that follows.
 */
export function confirmUnloadDuringAskRun(): void {
  unloadConfirmed = true;
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
export function useChat({ stallTimeoutMs = STALL_TIMEOUT_MS }: UseChatOptions = {}): UseChatResult {
  const client = useAskClient();
  const { hostContextProvider } = useAskConfig();
  // A ref, because `runTurn` is created once and must still reach the
  // provider the host has CURRENTLY assigned — the element re-renders with a
  // new config whenever one is set or cleared.
  const hostContextRef = useRef(hostContextProvider);
  hostContextRef.current = hostContextProvider;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [status, setStatus] = useState<"idle" | "streaming">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);

  const isStreamingRef = useRef(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<InFlightRun | null>(null);
  const conversationIdRef = useRef<number | null>(null);
  // Which thread a run belongs to. Bumped whenever the thread on screen is
  // replaced (a new conversation, or one reopened from History), and every
  // write a run makes checks it first: without it, the previous run's answer
  // landed in whatever thread was showing when it finished, and its
  // `isStreamingRef` kept the new screen's composer locked until then.
  const generationRef = useRef(0);
  // The same idea for `loadConversation`, whose fetch can resolve after the
  // reader has already moved on — to another conversation, or a new one.
  const loadTokenRef = useRef(0);

  // Closing the tab, or reloading it, mid-run cuts the answer off — the run
  // is cancelled server-side the moment the connection closes, and nothing
  // is saved. Only while streaming: a prompt on every close would train
  // people to click through it.
  useEffect(() => {
    if (status !== "streaming") return;
    const warn = (event: BeforeUnloadEvent) => {
      if (unloadConfirmed) return;
      event.preventDefault();
      // Still required by browsers that predate preventDefault() here.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

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

  const runTurn = useCallback(async (text: string, options?: SendOptions) => {
    const generation = generationRef.current;
    const isCurrent = () => mountedRef.current && generationRef.current === generation;
    isStreamingRef.current = true;
    setStatus("streaming");
    setError(null);
    setNotice(null);

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
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      setMessages((prev) => [...prev, finalMessage]);
      setActiveRun(null);
    };

    const summaryFrom = (outcome: RunSummary["status"], errorText: string | null) => {
      const segments = buildPhaseTimeline(events);
      // `usage.duration_ms` is the sum of provider-reported model-call
      // durations, and the phase durations are independent measurements.
      // Measure the user's actual wait directly from submit to terminal event.
      const totalMs = Math.max(0, Date.now() - runStartAt);
      const trace = buildRunTrace(traceEvents);
      return { status: outcome, totalMs, errorText, segments, trace, agentName } satisfies RunSummary;
    };

    const controller = new AbortController();
    abortRef.current = controller;
    // Set just before this hook aborts the run itself, and read back in the
    // catch below: an AbortError alone cannot say whether the reader pressed
    // Stop, the watchdog gave up, or the provider unmounted — and those end
    // three different ways.
    let endReason: EndReason | null = null;
    const end = (reason: EndReason) => {
      if (controller.signal.aborted) return;
      endReason = reason;
      controller.abort();
    };
    runsInFlight += 1;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      runsInFlight -= 1;
    };
    inFlightRef.current = { end, release };

    // Armed only once the response has arrived: agent-service routes the
    // question before it sends headers, and that can legitimately take
    // longer than the stall window. From then on every read resets it —
    // keepalives included, which is the point.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = () => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => end("stalled"), stallTimeoutMs);
    };

    try {
      const hostContext = readHostContext(
        hostContextRef.current,
        options?.omitSelectedWidget === true,
      );
      const send = () =>
        postAgentRun(
          client,
          {
            message: text,
            agent: options?.agent,
            session_id: conversationIdRef.current ?? undefined,
            // Left off entirely when there is none: an embed with no
            // dashboard beside it sends exactly the body it always did.
            ...(hostContext === null ? {} : { host_context: hostContext }),
          },
          { signal: controller.signal },
        );
      let response: Response;
      try {
        response = await send();
      } catch (err) {
        // A conversation that can be read but not continued — deleted in
        // another tab since it was opened, or a channel transcript that was
        // never this user's own run. The follow-up used to fail with the
        // server's "no conversation N for this user" and nothing else to try;
        // now it is sent once more, as the first turn of a new conversation.
        // Refused only before any run started, so this never runs a question
        // twice.
        if (!isMissingConversationError(err) || conversationIdRef.current === null || !isCurrent()) {
          throw err;
        }
        conversationIdRef.current = null;
        setActiveConversationId(null);
        response = await send();
        if (isCurrent()) setNotice(CONVERSATION_RESTARTED);
      }

      armWatchdog();
      // Left the moment a terminal chunk lands. The server writes nothing
      // after `finish`/`error` but `[DONE]`, and it commits the answer
      // before it sends `finish` (`app.api.run`), so there is nothing left
      // to wait for — and waiting is what let a connection that broke in
      // that gap turn a delivered answer into a second, failed turn.
      stream: for await (const chunk of readDataStream(response.body!, { onActivity: armWatchdog })) {
        switch (chunk.type) {
          case "start": {
            messageId = chunk.messageId;
            const resolvedAgent = chunk.messageMetadata?.agent_name;
            if (typeof resolvedAgent === "string") agentName = resolvedAgent;
            // The conversation this run was saved under. A fresh thread has
            // no id until here, and without keeping it every follow-up was
            // sent with no `session_id` — a new conversation each time, so
            // "and last week?" reached the agent with none of the earlier turns.
            //
            // Only while this run's thread is still the one on screen: a
            // stale run naming its conversation would point the NEW thread's
            // follow-ups at the old one.
            const sessionId = chunk.messageMetadata?.session_id;
            if (typeof sessionId === "number" && Number.isInteger(sessionId) && isCurrent()) {
              conversationIdRef.current = sessionId;
              setActiveConversationId(sessionId);
            }
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
            break stream;
          }
          case "error": {
            sawTerminal = true;
            events.push({ kind: "run-end", at: Date.now() });
            finalize(summaryFrom("error", chunk.errorText), null);
            break stream;
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
              // `live`: this part is arriving on a run this session started,
              // which is what lets a drafted widget insert itself exactly once
              // (wireParts.adaptWidgetDraft). History never passes it.
              partsAcc.push(toUIPart(dataChunk.type, dataChunk.data, { live: true }));
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
      // The turn already landed. Whatever broke after that — the connection
      // dropping before `[DONE]`, Stop pressed a beat too late — must not
      // append a second, failed turn beneath the answer.
      if (sawTerminal) return;
      if (controller.signal.aborted) {
        // Checked off the signal, not the error: `fetch` and a body read
        // reject with whatever the platform chose, and it was this hook that
        // pulled the plug either way.
        if (endReason === null) {
          // A deliberate cancel (provider unmount, or the thread replaced
          // under it) — not a failure the operator caused, so nothing
          // renders and nothing needs undoing: the assistant message simply
          // never gets appended.
          return;
        }
        events.push({ kind: "run-end", at: Date.now() });
        finalize(
          endReason === "stopped" ? summaryFrom("stopped", null) : summaryFrom("error", LOST_CONNECTION),
          null,
        );
        return;
      }
      const message = err instanceof Error ? err.message : "Asking failed unexpectedly.";
      if (isCurrent()) {
        finalize(summaryFrom("error", message), null);
        setError(message);
      }
    } finally {
      if (stallTimer !== null) clearTimeout(stallTimer);
      release();
      if (inFlightRef.current?.end === end) inFlightRef.current = null;
      // A stale run leaves these alone: they belong to whatever run the new
      // thread may already have started.
      if (generationRef.current === generation) {
        abortRef.current = null;
        isStreamingRef.current = false;
        if (mountedRef.current) setStatus("idle");
      }
    }
  }, []);

  /**
   * Lets go of the run in flight, if any, because the thread it was writing
   * into is about to be replaced. Silent — `endReason` stays null, so the run
   * appends nothing — and immediate: the composer unlocks now, not whenever
   * the abort finishes unwinding.
   */
  const discardRun = useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current?.release();
    inFlightRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    isStreamingRef.current = false;
    setStatus("idle");
    setActiveRun(null);
  }, []);

  const stop = useCallback(() => {
    inFlightRef.current?.end("stopped");
  }, []);

  const sendMessage = useCallback(
    (text: string, options?: SendOptions) => {
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

  const loadConversation = useCallback(
    async (conversationId: number) => {
      // Picking the conversation a run is still streaming into, from History:
      // it is already on screen and still being written, and reloading it
      // would throw away the answer on its way.
      if (conversationId === conversationIdRef.current && isStreamingRef.current) return;
      const token = ++loadTokenRef.current;
      const hydrated = await fetchConversation(client, conversationId);
      // Superseded while it loaded — the reader opened another, or started a
      // new one — or the provider is gone.
      if (token !== loadTokenRef.current || !mountedRef.current) return;
      // Only now, once there is a thread to replace it with: a load that
      // fails leaves the current thread, and any run in it, as they were.
      discardRun();
      conversationIdRef.current = conversationId;
      setMessages(hydrated);
      setActiveConversationId(conversationId);
      setError(null);
      setNotice(null);
      // Same rule as `clearConversation`: an agent armed by slash command was
      // armed for the conversation it was typed in, not for this one.
      setSelectedAgent(null);
    },
    [discardRun],
  );

  const clearConversation = useCallback(() => {
    loadTokenRef.current += 1;
    discardRun();
    conversationIdRef.current = null;
    setActiveConversationId(null);
    setMessages([]);
    setError(null);
    setNotice(null);
    // A slash command arms an agent for "the rest of this conversation", so a
    // new one starts unarmed and routes itself. Keeping it sent the next plain
    // question to the last builder used.
    setSelectedAgent(null);
  }, [discardRun]);

  return {
    messages,
    activeRun,
    status,
    error,
    notice,
    sendMessage,
    stop,
    loadConversation,
    selectedAgent,
    setSelectedAgent,
    activeConversationId,
    clearConversation,
  };
}
