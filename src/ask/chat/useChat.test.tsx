import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAskRunInFlight, useChat } from "./useChat.ts";
import { TestAskProvider } from "../testing.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sseResponse(frames: string[], status = 200): Response {
  const text = frames.map((frame) => `${frame}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, { status });
}

/** A stream that yields one chunk and then never closes — stands in for a
 * run genuinely still in flight (used by the concurrency-guard and
 * abort-on-unmount tests). Errors its reader with a real AbortError once
 * `signal` fires, the same reaction a real `fetch` body gives a caller
 * mid-read, so the abort test exercises `useChat`'s actual catch branch
 * rather than assuming the wiring works. */
function openEndedResponse(signal?: AbortSignal, frames: string[] = []): Response {
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(
        new TextEncoder().encode(
          [`data: {"type":"start","messageId":"pending"}`, ...frames].map((frame) => `${frame}\n\n`).join(""),
        ),
      );
    },
  });
  signal?.addEventListener("abort", () => {
    controllerRef.error(new DOMException("The operation was aborted.", "AbortError"));
  });
  return new Response(body, { status: 200 });
}

/** Open-ended, and quiet except for the server's `: keepalive` comment every
 * `everyMs` — a model thinking for a long time, as the wire shows it. */
function heartbeatOnlyResponse(signal: AbortSignal, everyMs: number): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"start","messageId":"quiet"}\n\n`));
      timer = setInterval(() => controller.enqueue(new TextEncoder().encode(": keepalive\n\n")), everyMs);
      signal.addEventListener("abort", () => {
        clearInterval(timer);
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      });
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, { status: 200 });
}

const GOLDEN_FRAMES = [
  `data: {"type":"start","messageId":"msg-1"}`,
  `data: {"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`,
  `data: {"type":"data-phase","data":{"phase":"plan","state":"done"},"transient":true}`,
  `data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"run_sql","input":{"sql":"SELECT 1"}}`,
  `data: {"type":"tool-output-available","toolCallId":"call_1","output":"1 row returned"}`,
  `data: {"type":"data-table","data":{"columns":["n"],"rows":[[1]]}}`,
  `data: {"type":"text-start","id":"answer"}`,
  `data: {"type":"text-delta","id":"answer","delta":"The answer is 1."}`,
  `data: {"type":"data-phase","data":{"phase":"validate","state":"done"},"transient":true}`,
  `data: {"type":"text-end","id":"answer"}`,
  `data: {"type":"finish","messageMetadata":{"usage":{"input_tokens":120,"output_tokens":40,"total_tokens":160,"cost_usd":0.0006,"duration_ms":842.5}}}`,
  `data: [DONE]`,
];

// One Date.now() value per call useChat.ts actually makes while walking
// GOLDEN_FRAMES: runStartAt, then one per data-phase/tool chunk, then the
// finish run-end mark. Chosen to match phaseTimeline.test.ts's own golden
// numbers so the proportionality assertion below is exact, not "some bars
// differ" — the mock clock trades a little coupling to call order for a
// fully deterministic (non-flaky) proportionality test.
// The first entry is the run's own start (ActiveRun.startedAt, read when
// the request goes out); the rest are the phase boundaries the frames
// below report. Both come off the same Date.now(), so a reading added
// anywhere in useChat shifts every one after it — which is exactly what
// this list is for.
const CLOCK = [0, 0, 400, 1500, 1600, 4300, 4900];

function mockClock(times: number[]) {
  let i = 0;
  vi.spyOn(Date, "now").mockImplementation(() => times[Math.min(i++, times.length - 1)]!);
}

// `postAgentRun` goes through `GatewayClient.agentStream` now, which calls
// `fetch(new Request(url, init))` — one argument, exactly as `agentFetch`
// has always done. So these read the Request rather than an `(url, init)`
// pair. A `Request` built from an init carries its `signal`, so the abort
// wiring is still observable, just one property deeper.

describe("useChat", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("streams a run end to end: user turn, live phases, then a persisted assistant message", async () => {
    mockClock(CLOCK);
    fetchMock.mockResolvedValue(sseResponse(GOLDEN_FRAMES));
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("Which store sells more?"));

    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: "user", content: "Which store sells more?" });

    const assistant = result.current.messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("The answer is 1.");
    expect(assistant.id).toBe("msg-1"); // the real server-assigned id from the "start" chunk

    // Persisted history carries the table and nothing else — no data-phase
    // entry ever reaches .parts, which is the whole point of "transient".
    // The wire's parallel-array shape ({columns:["n"], rows:[[1]]}) went
    // through wireParts.toUIPart into DataTable's own props shape.
    expect(assistant.parts).toEqual([
      {
        intent: "data-table",
        data: {
          title: "Query results",
          subLabel: "1 row",
          // Typed numeric off the column's own values, which is what
          // right-aligns it and gives it tabular figures (wireParts.ts).
          columns: [{ key: "n", header: "N", type: "number" }],
          rows: [{ n: 1 }],
        },
      },
    ]);

    expect(assistant.runSummary).toMatchObject({ status: "done" });
    // Usage lives on the message, not on runSummary — it is the one piece
    // of run metadata that survives a reload (ChatMessage.usage).
    expect(assistant.usage).toMatchObject({ input_tokens: 120, output_tokens: 40, total_tokens: 160 });
  });

  it("keeps transient phase events out of persisted history, in both .parts and .content", async () => {
    mockClock(CLOCK);
    fetchMock.mockResolvedValue(sseResponse(GOLDEN_FRAMES));
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("Which store sells more?"));

    await waitFor(() => {
      const assistant = result.current.messages[1];
      expect(assistant).toBeDefined();
      expect(assistant!.parts.some((p) => p.intent === "data-phase")).toBe(false);
      expect(JSON.stringify(assistant)).not.toContain("data-phase");
    });
  });

  it("collapses the rail on completion: activeRun clears and the phase detail lives only in runSummary", async () => {
    mockClock(CLOCK);
    fetchMock.mockResolvedValue(sseResponse(GOLDEN_FRAMES));
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("Which store sells more?"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(result.current.activeRun).toBeNull();
    const segments = result.current.messages[1]!.runSummary!.segments;
    expect(segments.map((s) => s.phase)).toEqual(["research", "plan", "execute", "validate"]);
  });

  it("keeps every field a data-phase part carried, not only the ones a bar needs", async () => {
    mockClock(CLOCK);
    fetchMock.mockResolvedValue(
      sseResponse([
        `data: {"type":"start","messageId":"msg-9"}`,
        `data: {"type":"data-phase","data":{"phase":"plan","state":"cached","duration_ms":900},"transient":true}`,
        `data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"run_sql","input":{"sql":"SELECT 1"}}`,
        `data: {"type":"tool-output-available","toolCallId":"call_1","output":"1 row returned"}`,
        `data: {"type":"data-phase","data":{"phase":"execute","state":"done","duration_ms":50,"sql":"SELECT 1 FROM t"},"transient":true}`,
        `data: {"type":"data-phase","data":{"phase":"validate","state":"done","duration_ms":20,"score":0.82,"reasoning":"Every figure is in the evidence."},"transient":true}`,
        `data: {"type":"finish"}`,
        `data: [DONE]`,
      ]),
    );
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("Which store sells more?"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    // The four fields the old rail threw away: the executed SQL, the
    // judge's score, the judge's own prose, and the tool call's output.
    const trace = result.current.messages[1]!.runSummary!.trace;
    expect(trace.executedSql).toBe("SELECT 1 FROM t");
    expect(trace.score).toBe(0.82);
    expect(trace.reasoning).toBe("Every figure is in the evidence.");
    expect(trace.tools).toEqual([
      { callId: "call_1", name: "run_sql", input: { sql: "SELECT 1" }, output: "1 row returned" },
    ]);
    expect(trace.steps.map((step) => step.label)).toEqual([
      "Reused the cached plan",
      "Called run_sql",
      "Ran the plan",
      "Validated the answer",
    ]);
  });

  it("gives bars real, unequal proportional durations — not six equal segments", async () => {
    mockClock(CLOCK);
    fetchMock.mockResolvedValue(sseResponse(GOLDEN_FRAMES));
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("Which store sells more?"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    const byPhase = Object.fromEntries(
      result.current.messages[1]!.runSummary!.segments.map((s) => [s.phase, s.durationMs]),
    );
    expect(byPhase.research).toBe(400);
    expect(byPhase.plan).toBe(1100);
    expect(byPhase.execute).toBe(3400); // the biggest share, same as the mockup's execute-dominant run
    expect(new Set(Object.values(byPhase)).size).toBeGreaterThan(1);
  });

  it("leaves a legible error state, not a stuck spinner, when the stream errors mid-run", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        `data: {"type":"start","messageId":"msg-2"}`,
        `data: {"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`,
        `data: {"type":"error","errorText":"the run failed unexpectedly (ref: abc123)"}`,
        `data: [DONE]`,
      ]),
    );
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("hello"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(result.current.activeRun).toBeNull();
    const assistant = result.current.messages[1]!;
    expect(assistant.runSummary).toMatchObject({
      status: "error",
      errorText: "the run failed unexpectedly (ref: abc123)",
    });
  });

  it("finalizes as a legible failure when the stream ends with no finish/error at all", async () => {
    // No [DONE], no finish, no error: the connection just stops, exactly
    // the "dropped connection" case the task brief names by name.
    fetchMock.mockResolvedValue(
      sseResponse([
        `data: {"type":"start","messageId":"msg-3"}`,
        `data: {"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`,
      ]),
    );
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("hello"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(result.current.activeRun).toBeNull();
    expect(result.current.messages[1]!.runSummary).toMatchObject({
      status: "error",
      errorText: "Connection closed before the run finished.",
    });
  });

  it("shows the answer once when the connection breaks after finish but before [DONE]", async () => {
    // Delivered in one read, then the next read fails the way a dropped
    // socket does. Before, that failure became a second, "network error"
    // turn under an answer that had already arrived whole.
    const frames = [
      `data: {"type":"start","messageId":"msg-20"}`,
      `data: {"type":"text-delta","id":"answer","delta":"Done."}`,
      `data: {"type":"finish"}`,
    ];
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames.map((frame) => `${frame}\n\n`).join("")));
      },
      pull(controller) {
        pulls += 1;
        controller.error(new TypeError("network error"));
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("hello"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(pulls).toBeGreaterThan(0); // the break really was there to be hit
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toMatchObject({ content: "Done.", runSummary: { status: "done" } });
    expect(result.current.error).toBeNull();
  });

  it("does not start a second run while one is already streaming", async () => {
    fetchMock.mockImplementation((request: Request) =>
      Promise.resolve(openEndedResponse(request.signal)),
    );
    const { result, unmount } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("first"));
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    act(() => result.current.sendMessage("second"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(1); // only "first" was ever appended
    expect(result.current.error).toMatch(/wait/i);

    unmount(); // let the open-ended request settle instead of leaking into the next test
  });

  it("aborts the in-flight request on unmount and appends nothing further", async () => {
    fetchMock.mockImplementation((request: Request) =>
      Promise.resolve(openEndedResponse(request.signal)),
    );
    const { result, unmount } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("hello"));
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    const signal = (fetchMock.mock.calls[0]![0] as Request).signal;
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
    // No assistant message was ever finalized for a run cancelled this way
    // — matching agent-service's own "a run cancelled this way persists
    // nothing new" (app/api/run.py's module docstring).
    expect(result.current.messages).toHaveLength(1);
  });

  it("stop() closes the connection and lands the turn as stopped, keeping what had arrived", async () => {
    fetchMock.mockImplementation((request: Request) =>
      Promise.resolve(
        openEndedResponse(request.signal, [
          `data: {"type":"data-table","data":{"columns":["n"],"rows":[[1]]}}`,
          `data: {"type":"text-delta","id":"answer","delta":"So far, one"}`,
        ]),
      ),
    );
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("hello"));
    await waitFor(() => expect(result.current.activeRun?.text).toBe("So far, one"));
    const signal = (fetchMock.mock.calls[0]![0] as Request).signal;

    act(() => result.current.stop());

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(signal.aborted).toBe(true);
    expect(result.current.activeRun).toBeNull();
    const assistant = result.current.messages[1]!;
    expect(assistant.content).toBe("So far, one");
    expect(assistant.parts).toHaveLength(1);
    // Not an error: the reader asked for this.
    expect(assistant.runSummary).toMatchObject({ status: "stopped", errorText: null });
    expect(result.current.error).toBeNull();
  });

  it("warns before the tab closes mid-run, and only mid-run", async () => {
    fetchMock.mockImplementation((request: Request) => Promise.resolve(openEndedResponse(request.signal)));
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });
    const closeTab = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(closeTab()).toBe(false);
    expect(isAskRunInFlight()).toBe(false);

    act(() => result.current.sendMessage("hello"));
    await waitFor(() => expect(result.current.status).toBe("streaming"));
    expect(closeTab()).toBe(true);
    expect(isAskRunInFlight()).toBe(true);

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(closeTab()).toBe(false);
    expect(isAskRunInFlight()).toBe(false);
  });

  it("stop() between runs does nothing", () => {
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });
    act(() => result.current.stop());
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.status).toBe("idle");
  });

  it("ends a run that goes completely silent as a lost connection, instead of working forever", async () => {
    fetchMock.mockImplementation((request: Request) => Promise.resolve(openEndedResponse(request.signal)));
    const { result } = renderHook(() => useChat({ stallTimeoutMs: 40 }), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("hello"));

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect((fetchMock.mock.calls[0]![0] as Request).signal.aborted).toBe(true);
    expect(result.current.messages[1]!.runSummary).toMatchObject({
      status: "error",
      errorText: "Lost connection to the run.",
    });
  });

  it("keeps a quiet run alive for as long as the server's keepalives keep arriving", async () => {
    fetchMock.mockImplementation((request: Request) =>
      Promise.resolve(heartbeatOnlyResponse(request.signal, 10)),
    );
    const { result, unmount } = renderHook(() => useChat({ stallTimeoutMs: 150 }), {
      wrapper: TestAskProvider,
    });

    act(() => result.current.sendMessage("hello"));
    await waitFor(() => expect(result.current.status).toBe("streaming"));
    // Several stall windows pass with no chunk at all — only comments.
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));

    expect(result.current.status).toBe("streaming");
    expect(result.current.messages).toHaveLength(1);
    unmount();
  });

  // The actual "chat history not opening" bug (this task's report): a
  // successful GET /agent/conversations/{id} hydrated correctly, but
  // `loadConversation`'s `if (mountedRef.current) setMessages(...)` guard
  // silently dropped the call — `mountedRef` had been set back to `false`
  // by StrictMode's dev-only mount -> cleanup -> remount simulation and
  // nothing ever set it back to `true` for the real mount that followed.
  // `main.tsx` always renders inside `<StrictMode>`, so this is the
  // condition the real app runs under; `renderHook` alone (every other
  // test in this file) does not reproduce it — a plain, unwrapped render
  // passed against the bug the whole time.
  it("hydrates a loaded conversation into messages even under StrictMode's mount/unmount/remount", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 20020,
        title: null,
        created_at: "2026-08-28T03:46:22.049116Z",
        updated_at: "2026-08-28T03:46:22.049117Z",
        messages: [
          {
            id: 400039,
            role: "user",
            content: "How many stores are in the warehouse?",
            agent_id: null,
            trace_id: null,
            meta: null,
            created_at: "2026-08-28T03:46:22.049971Z",
          },
          {
            id: 400040,
            role: "assistant",
            content: "store_count\n299",
            agent_id: 1,
            trace_id: null,
            meta: null,
            created_at: "2026-08-28T03:46:22.049972Z",
          },
        ],
      }),
    );
    const { result } = renderHook(() => useChat(), {
      // Both wrappers: StrictMode is what this test is about, and the
      // config is what every Ask component needs to mount at all.
      wrapper: ({ children }) => (
        <StrictMode>
          <TestAskProvider>{children}</TestAskProvider>
        </StrictMode>
      ),
    });

    await act(() => result.current.loadConversation(20020));

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", content: "store_count\n299" });
  });

  it("clearConversation resets the thread locally without any server call", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 4,
        title: null,
        created_at: "2026-08-20T10:41:00Z",
        updated_at: "2026-08-20T10:41:00Z",
        messages: [
          {
            id: 1,
            role: "user",
            content: "hi",
            agent_id: null,
            trace_id: null,
            meta: null,
            created_at: "2026-08-20T10:41:00Z",
          },
        ],
      }),
    );
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    await act(() => result.current.loadConversation(4));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.activeConversationId).toBe(4);

    const callsBeforeClear = fetchMock.mock.calls.length;
    act(() => result.current.clearConversation());

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.activeRun).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeClear);
  });

  it("continues the conversation the server named, so a follow-up carries the earlier turns", async () => {
    const framesFor = (sessionId: number) => [
      `data: {"type":"start","messageId":"msg-${sessionId}","messageMetadata":{"session_id":${sessionId},"agent_name":"Report"}}`,
      `data: {"type":"text-delta","id":"answer","delta":"ok"}`,
      `data: {"type":"finish"}`,
      `data: [DONE]`,
    ];
    fetchMock.mockImplementation(() => Promise.resolve(sseResponse(framesFor(57))));
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });
    const sentBody = async (call: number) =>
      (await (fetchMock.mock.calls[call]![0] as Request).clone().json()) as Record<string, unknown>;

    act(() => result.current.sendMessage("Sales this week?"));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(await sentBody(0)).not.toHaveProperty("session_id");
    expect(result.current.activeConversationId).toBe(57);

    act(() => result.current.sendMessage("And last week?"));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(await sentBody(1)).toMatchObject({ message: "And last week?", session_id: 57 });

    // A new conversation starts over: no id until its own first run names one.
    act(() => result.current.clearConversation());
    act(() => result.current.sendMessage("Something else"));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(await sentBody(2)).not.toHaveProperty("session_id");
  });

  it("starts a new conversation with the same question when the open one can't be continued", async () => {
    // Deleted in another tab since it was opened, or a channel transcript:
    // readable, but the server will not add a turn to it.
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          `data: {"type":"start","messageId":"m1","messageMetadata":{"session_id":57}}`,
          `data: {"type":"finish"}`,
          `data: [DONE]`,
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ detail: "no conversation 57 for this user" }, 404))
      .mockResolvedValueOnce(
        sseResponse([
          `data: {"type":"start","messageId":"m2","messageMetadata":{"session_id":58}}`,
          `data: {"type":"text-delta","id":"answer","delta":"Here it is."}`,
          `data: {"type":"finish"}`,
          `data: [DONE]`,
        ]),
      );
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });
    const sentBody = async (call: number) =>
      (await (fetchMock.mock.calls[call]![0] as Request).clone().json()) as Record<string, unknown>;

    act(() => result.current.sendMessage("Sales this week?"));
    await waitFor(() => expect(result.current.activeConversationId).toBe(57));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    act(() => result.current.sendMessage("And by city?"));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await sentBody(1)).toMatchObject({ message: "And by city?", session_id: 57 });
    expect(await sentBody(2)).toMatchObject({ message: "And by city?" });
    expect(await sentBody(2)).not.toHaveProperty("session_id");
    expect(result.current.activeConversationId).toBe(58);
    // Asked once, answered once — the refusal never became a turn of its own.
    expect(result.current.messages.map((message) => message.content)).toEqual([
      "Sales this week?",
      "",
      "And by city?",
      "Here it is.",
    ]);
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBe("That conversation can't be continued, so this started a new one.");

    // The note is about that send, not the ones after it.
    fetchMock.mockResolvedValueOnce(sseResponse([`data: {"type":"finish"}`, `data: [DONE]`]));
    act(() => result.current.sendMessage("Thanks"));
    await waitFor(() => expect(result.current.notice).toBeNull());
  });

  describe("which agent a follow-up goes to", () => {
    const routedTo = (agent: string, extra = "") => [
      `data: {"type":"start","messageId":"m","messageMetadata":{"session_id":57,"agent_name":"${agent}"${extra}}}`,
      `data: {"type":"finish"}`,
      `data: [DONE]`,
    ];
    const runBodies = () =>
      Promise.all(
        fetchMock.mock.calls
          .map((call) => call[0] as Request)
          .filter((request) => new URL(request.url).pathname === "/agent/run")
          .map(async (request) => (await request.clone().json()) as Record<string, unknown>),
      );

    async function ask(result: { current: ReturnType<typeof useChat> }, text: string, agent?: string) {
      act(() => result.current.sendMessage(text, agent === undefined ? undefined : { agent }));
      await waitFor(() => expect(result.current.status).toBe("idle"));
    }

    it("keeps a plain follow-up with the agent the server routed the conversation to", async () => {
      fetchMock
        .mockResolvedValueOnce(sseResponse(routedTo("Fleet-Report")))
        .mockResolvedValueOnce(sseResponse(routedTo("Fleet-Report")))
        .mockResolvedValueOnce(sseResponse(routedTo("Form-Builder")))
        .mockResolvedValueOnce(sseResponse(routedTo("Fleet-Report")))
        .mockResolvedValueOnce(sseResponse(routedTo("Fleet-Report")));
      const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

      await ask(result, "trips per vehicle last week");
      await ask(result, "now by city");
      // Armed by the reader: that wins, and is not what gets pinned — once
      // they disarm it they want routing, not the builder they let go of.
      await ask(result, "a checklist form", "Form-Builder");
      await ask(result, "how many trips today?");
      // A new conversation starts unpinned.
      act(() => result.current.clearConversation());
      await ask(result, "something else");

      const bodies = await runBodies();
      expect(bodies[0]!.agent).toBeUndefined();
      expect(bodies[1]).toMatchObject({ message: "now by city", agent: "Fleet-Report" });
      expect(bodies[2]).toMatchObject({ agent: "Form-Builder" });
      expect(bodies[3]!.agent).toBeUndefined();
      expect(bodies[4]!.agent).toBeUndefined();
    });

    it("does not pin an agent the router fell back to, and says it was a fallback", async () => {
      fetchMock
        .mockResolvedValueOnce(sseResponse(routedTo("General", `,"routing_fallback":true`)))
        .mockResolvedValueOnce(sseResponse(routedTo("Fleet-Report")));
      const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

      await ask(result, "hmm");
      expect(result.current.messages[1]!.runSummary).toMatchObject({
        agentName: "General",
        routingFallback: true,
      });
      await ask(result, "yes");

      const bodies = await runBodies();
      expect(bodies[1]!.agent).toBeUndefined();
      expect(result.current.messages[3]!.runSummary!.routingFallback).toBe(false);
    });

    it("routes afresh when the pinned agent has been switched off since", async () => {
      fetchMock
        .mockResolvedValueOnce(sseResponse(routedTo("Fleet-Report")))
        .mockResolvedValueOnce(
          jsonResponse({ detail: "no active agent named 'Fleet-Report' available to this tenant" }, 404),
        )
        .mockResolvedValueOnce(sseResponse(routedTo("Fleet-Ops")));
      const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

      await ask(result, "trips per vehicle");
      await ask(result, "and by city");

      const bodies = await runBodies();
      expect(bodies).toHaveLength(3);
      expect(bodies[1]).toMatchObject({ agent: "Fleet-Report", session_id: 57 });
      expect(bodies[2]!.agent).toBeUndefined();
      expect(bodies[2]).toMatchObject({ message: "and by city", session_id: 57 });
      expect(result.current.messages[3]!.runSummary).toMatchObject({ status: "done", agentName: "Fleet-Ops" });
    });

    it("sends a reopened conversation's follow-up to whoever answered it last, by name", async () => {
      const conversation = {
        ...CONVERSATION_5,
        messages: [
          ...CONVERSATION_5.messages,
          {
            id: 2,
            role: "assistant",
            content: "an older answer",
            agent_id: 3,
            trace_id: null,
            meta: null,
            created_at: "2026-09-20T10:00:01Z",
          },
        ],
      };
      fetchMock.mockImplementation((request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/agent/conversations/5") return Promise.resolve(jsonResponse(conversation));
        if (path === "/agent/agents") {
          return Promise.resolve(
            jsonResponse([
              { id: 1, name: "General", is_active: true },
              { id: 3, name: "Fleet-Report", is_active: true },
            ]),
          );
        }
        return Promise.resolve(sseResponse(routedTo("Fleet-Report")));
      });
      const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

      await act(() => result.current.loadConversation(5));
      await ask(result, "and last month?");

      expect((await runBodies())[0]).toMatchObject({ agent: "Fleet-Report", session_id: 5 });
    });

    it("routes a reopened conversation's follow-up when its last agent is gone", async () => {
      const conversation = {
        ...CONVERSATION_5,
        messages: [
          ...CONVERSATION_5.messages,
          {
            id: 2,
            role: "assistant",
            content: "an older answer",
            agent_id: 3,
            trace_id: null,
            meta: null,
            created_at: "2026-09-20T10:00:01Z",
          },
        ],
      };
      fetchMock.mockImplementation((request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/agent/conversations/5") return Promise.resolve(jsonResponse(conversation));
        if (path === "/agent/agents") {
          return Promise.resolve(jsonResponse([{ id: 3, name: "Fleet-Report", is_active: false }]));
        }
        return Promise.resolve(sseResponse(routedTo("General")));
      });
      const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

      await act(() => result.current.loadConversation(5));
      await ask(result, "and last month?");

      expect((await runBodies())[0]!.agent).toBeUndefined();
    });
  });

  it("does not retry a 404 that is not about the conversation", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: "no active agent named 'Retired' available to this tenant" }, 404),
    );
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("hello", { agent: "Retired" }));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.messages[1]!.runSummary).toMatchObject({ status: "error" });
    expect(result.current.notice).toBeNull();
  });

  it("clearConversation disarms a slash-command agent, so the next question routes itself", () => {
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });
    act(() => result.current.setSelectedAgent("Dashboard-Builder"));
    expect(result.current.selectedAgent).toBe("Dashboard-Builder");

    act(() => result.current.clearConversation());

    expect(result.current.selectedAgent).toBeNull();
  });
});

/**
 * A run whose stream the test finishes by hand, and which — unlike a real
 * `fetch` body — keeps going after its request is aborted. That is the
 * point: it proves a stale run's answer is dropped by the generation check
 * itself, not merely because the abort happened to stop it first.
 */
function heldRun(sessionId: number) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(
          new TextEncoder().encode(
            `data: {"type":"start","messageId":"held","messageMetadata":{"session_id":${sessionId}}}\n\n`,
          ),
        );
      },
    }),
    { status: 200 },
  );
  const finish = (text: string) => {
    controller.enqueue(
      new TextEncoder().encode(
        [
          `data: {"type":"text-delta","id":"answer","delta":"${text}"}`,
          `data: {"type":"finish"}`,
          `data: [DONE]`,
        ]
          .map((frame) => `${frame}\n\n`)
          .join(""),
      ),
    );
    controller.close();
  };
  return { response, finish };
}

const CONVERSATION_5 = {
  id: 5,
  title: null,
  created_at: "2026-09-20T10:00:00Z",
  updated_at: "2026-09-20T10:00:00Z",
  messages: [
    {
      id: 1,
      role: "user",
      content: "an older question",
      agent_id: null,
      trace_id: null,
      meta: null,
      created_at: "2026-09-20T10:00:00Z",
    },
  ],
};

describe("useChat — replacing the thread while a run is in flight", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const runBodies = () =>
    Promise.all(
      fetchMock.mock.calls
        .map((call) => call[0] as Request)
        .filter((request) => new URL(request.url).pathname === "/agent/run")
        .map(async (request) => (await request.clone().json()) as Record<string, unknown>),
    );

  it("a new conversation unlocks at once and never receives the old run's answer", async () => {
    const held = heldRun(11);
    fetchMock.mockResolvedValueOnce(held.response);
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("first"));
    await waitFor(() => expect(result.current.activeConversationId).toBe(11));
    const firstSignal = (fetchMock.mock.calls[0]![0] as Request).signal;

    act(() => result.current.clearConversation());

    expect(firstSignal.aborted).toBe(true);
    expect(result.current.status).toBe("idle");
    expect(result.current.activeRun).toBeNull();
    expect(result.current.messages).toHaveLength(0);

    // The old run finishes anyway; its answer has nowhere to go.
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `data: {"type":"start","messageId":"new","messageMetadata":{"session_id":12}}`,
        `data: {"type":"text-delta","id":"answer","delta":"new answer"}`,
        `data: {"type":"finish"}`,
        `data: [DONE]`,
      ]),
    );
    act(() => held.finish("old answer"));
    act(() => result.current.sendMessage("second"));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(result.current.messages.map((message) => message.content)).toEqual(["second", "new answer"]);
    expect(result.current.activeConversationId).toBe(12);
    const bodies = await runBodies();
    expect(bodies[1]).not.toHaveProperty("session_id");
  });

  it("reopening another conversation from History drops the run and the slash-armed agent", async () => {
    const held = heldRun(11);
    fetchMock.mockImplementation((request: Request) => {
      if (new URL(request.url).pathname === "/agent/conversations/5") {
        return Promise.resolve(jsonResponse(CONVERSATION_5));
      }
      return Promise.resolve(held.response);
    });
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });
    act(() => result.current.setSelectedAgent("Form-Builder"));
    act(() => result.current.sendMessage("draft a form", { agent: "Form-Builder" }));
    await waitFor(() => expect(result.current.activeConversationId).toBe(11));

    await act(() => result.current.loadConversation(5));

    expect(result.current.status).toBe("idle");
    expect(result.current.activeRun).toBeNull();
    expect(result.current.activeConversationId).toBe(5);
    expect(result.current.selectedAgent).toBeNull();

    act(() => held.finish("old answer"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(result.current.messages.map((message) => message.content)).toEqual(["an older question"]);
    expect(result.current.activeConversationId).toBe(5);
  });

  it("keeps the run when the conversation picked is the one it is streaming into", async () => {
    const held = heldRun(11);
    fetchMock.mockResolvedValueOnce(held.response);
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    act(() => result.current.sendMessage("first"));
    await waitFor(() => expect(result.current.activeConversationId).toBe(11));

    await act(() => result.current.loadConversation(11));

    expect(fetchMock).toHaveBeenCalledTimes(1); // no reload of what is on screen
    act(() => held.finish("the answer"));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.messages.map((message) => message.content)).toEqual(["first", "the answer"]);
  });

  it("a load that resolves after the reader started a new conversation does not replace it", async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useChat(), { wrapper: TestAskProvider });

    let load!: Promise<void>;
    act(() => {
      load = result.current.loadConversation(5);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => result.current.clearConversation());
    await act(async () => {
      answer(jsonResponse(CONVERSATION_5));
      await load;
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.activeConversationId).toBeNull();
  });
});
