import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "./useChat.ts";
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
function openEndedResponse(signal?: AbortSignal): Response {
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(
        new TextEncoder().encode(`data: {"type":"start","messageId":"pending"}\n\n`),
      );
    },
  });
  signal?.addEventListener("abort", () => {
    controllerRef.error(new DOMException("The operation was aborted.", "AbortError"));
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
});
