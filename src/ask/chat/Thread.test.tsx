import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskInspectorProvider } from "../config.tsx";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import { Thread } from "./Thread.tsx";
import type { UseChatResult } from "./useChat.ts";
import { TestAskProvider } from "../testing.tsx";

function sseResponse(frames: string[]): Response {
  const text = frames.map((frame) => `${frame}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

/**
 * `Thread` resolves a reopened turn's `agent_id` through the shared
 * `useAgents` hook, so the Ask screen makes more than one request now and
 * a single `mockResolvedValue` would hand the same, already-consumed
 * `Response` body to all of them. Each route gets its own fresh response.
 */
function routeFetch(runOrDetail: () => Response) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes("/agent/agents")) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: 3, name: "Sales-Analyst", is_active: true }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(runOrDetail());
  });
}

const GOLDEN_FRAMES = [
  `data: {"type":"start","messageId":"msg-1"}`,
  `data: {"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`,
  `data: {"type":"data-phase","data":{"phase":"plan","state":"cached"},"transient":true}`,
  `data: {"type":"data-phase","data":{"phase":"execute","state":"done","sql":"SELECT item FROM sales"},"transient":true}`,
  `data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"run_sql","input":{"sql":"SELECT 1"}}`,
  `data: {"type":"tool-output-available","toolCallId":"call_1","output":"1 row returned"}`,
  `data: {"type":"data-table","data":{"columns":["item"],"rows":[["Chicken Biryani"]]}}`,
  `data: {"type":"text-start","id":"answer"}`,
  `data: {"type":"text-delta","id":"answer","delta":"Chicken Biryani led the week."}`,
  `data: {"type":"data-phase","data":{"phase":"validate","state":"done","score":0.82,"reasoning":"Every figure appears in the evidence."},"transient":true}`,
  `data: {"type":"text-end","id":"answer"}`,
  `data: {"type":"finish","messageMetadata":{"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"cost_usd":0.0005,"duration_ms":500}}}`,
  `data: [DONE]`,
];

function renderThread() {
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    return null;
  }

  // The inspector is an INPUT now, not a provider that owns its own state:
  // the console's panel supplies one, and a host without a panel supplies
  // nothing. Here it records what the rail selected, which is the only thing
  // these tests care about.
  const selected: unknown[] = [];
  const utils = render(
    <TestAskProvider>
      <AskInspectorProvider
        inspector={{ selection: null, selectPhase: (segment) => selected.push(segment) }}
      >
        <ChatProvider>
          <Capture />
          <Thread />
        </ChatProvider>
      </AskInspectorProvider>
    </TestAskProvider>,
  );
  return { ...utils, chatRef, selected };
}

describe("Thread", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error -- test-only teardown of a property redefined per test
    delete navigator.clipboard;
  });

  it("shows the live rail while streaming, then collapses to a summary once the run finishes", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));

    // Live: the user's bubble and the reasoning card, reading as sentences
    // about what the run is doing, show up before the run finishes.
    await waitFor(() => {
      expect(screen.getByText("top items last week")).toBeInTheDocument();
      expect(screen.getByRole("list", { name: "Reasoning steps" })).toBeInTheDocument();
    });

    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    // The card survives the run finishing — this is the behaviour change
    // the whole pass is about. The old rail was replaced by a stranded
    // chip the moment a run completed, so the reasoning was visible only
    // while nobody was reading it.
    expect(screen.getByRole("list", { name: "Reasoning steps" })).toBeInTheDocument();
    expect(screen.getByText("Reused the cached plan")).toBeInTheDocument();
    expect(screen.getByText("Called run_sql")).toBeInTheDocument();
    expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument();
    expect(screen.getByText("Chicken Biryani")).toBeInTheDocument();
  });

  it("names the agent, the tool count, the score and the real cost — and never a zero it has no source for", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week", { agent: "Sales-Analyst" }));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    // Named twice on purpose: once on the reasoning card (who is doing
    // the work) and once in the strip (who produced this answer) — the
    // same two places the reference console names it.
    expect(screen.getAllByText("Sales-Analyst")).toHaveLength(2);
    expect(screen.getByText("1 tool")).toBeInTheDocument();
    // Same reasoning as the agent name: on the step that produced it, and
    // again in the strip so it survives collapsing the card.
    expect(screen.getAllByText("score 0.82")).toHaveLength(2);
    expect(screen.getByText("$0.0005")).toBeInTheDocument();
    expect(screen.getByText("120 tok")).toBeInTheDocument();
  });

  it("names no agent when the caller named none, rather than a default that may not exist", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const { chatRef } = renderThread();

    // No `agent` option: the server picks its own default and never says
    // which. Printing a guess here would be a checkable, wrong claim about
    // who answered.
    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    expect(screen.getByRole("list", { name: "Reasoning steps" })).toBeInTheDocument();
    expect(screen.queryByText("Analytics")).not.toBeInTheDocument();
    expect(screen.queryByText("Sales-Analyst")).not.toBeInTheDocument();
  });

  it("opens the executed SQL and the judge's own reasoning behind the debug toggle", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    // Closed by default — the debug panel is for checking an answer, not
    // for reading one.
    expect(screen.queryByText("SELECT item FROM sales")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show debug" }));

    expect(screen.getByText("SELECT item FROM sales")).toBeInTheDocument();
    expect(screen.getByText("Every figure appears in the evidence.")).toBeInTheDocument();
    expect(screen.getByText(/passed · 0\.82/)).toBeInTheDocument();
  });

  it("reopening a conversation renders sheets but never the expanded rail", async () => {
    fetchMock.mockImplementation(
      routeFetch(() => new Response(
        JSON.stringify({
          id: 9,
          title: "Top items",
          created_at: "2026-08-20T10:41:00Z",
          updated_at: "2026-08-20T10:41:05Z",
          messages: [
            {
              id: 1,
              role: "user",
              content: "top items last week",
              agent_id: null,
              trace_id: null,
              meta: null,
              created_at: "2026-08-20T10:41:00Z",
            },
            {
              id: 2,
              role: "assistant",
              content: "Chicken Biryani led the week.",
              agent_id: 3,
              trace_id: "t1",
              meta: {
                ui_parts: [
                  { type: "data-table", data: { columns: ["item"], rows: [["Chicken Biryani"]] } },
                ],
              },
              created_at: "2026-08-20T10:41:05Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )),
    );

    const { chatRef } = renderThread();
    await act(() => chatRef.current!.loadConversation(9));

    expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument();
    expect(screen.getByText("Chicken Biryani")).toBeInTheDocument();
    // The load-bearing assertion: a reopened run never had transient
    // events to begin with, so there is no reasoning to accidentally show
    // — and no debug toggle over an empty trace either.
    expect(screen.queryByRole("list", { name: "Reasoning steps" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show debug" })).not.toBeInTheDocument();
  });

  it("still reports a reopened answer's real cost and model, which do survive the reload", async () => {
    fetchMock.mockImplementation(
      routeFetch(() => new Response(
        JSON.stringify({
          id: 9,
          title: null,
          created_at: "2026-08-20T10:41:00Z",
          updated_at: "2026-08-20T10:41:05Z",
          messages: [
            {
              id: 1,
              role: "user",
              content: "top items last week",
              agent_id: null,
              trace_id: null,
              meta: null,
              created_at: "2026-08-20T10:41:00Z",
            },
            {
              id: 2,
              role: "assistant",
              content: "Chicken Biryani led the week.",
              agent_id: 3,
              trace_id: "t1",
              meta: {
                ui_parts: [],
                usage: {
                  input_tokens: 900,
                  output_tokens: 100,
                  total_tokens: 1000,
                  cost_usd: 0.0212,
                  duration_ms: 4200,
                  calls: [{ model: "openrouter/openai/gpt-5-mini", input_tokens: 900, output_tokens: 100, cost_usd: 0.0212, priced: true }],
                },
              },
              created_at: "2026-08-20T10:41:05Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )),
    );

    const { chatRef } = renderThread();
    await act(() => chatRef.current!.loadConversation(9));

    expect(screen.getByText("$0.0212")).toBeInTheDocument();
    expect(screen.getByText("1,000 tok")).toBeInTheDocument();
    // The routing prefix names how the call was routed, not what answered.
    expect(screen.getByText("openai/gpt-5-mini")).toBeInTheDocument();
    // Attribution comes from this message's own agent_id (3), resolved
    // against the agent list — never from whichever agent the picker
    // happens to be showing now.
    expect(screen.getByText("Sales-Analyst")).toBeInTheDocument();
  });

  it("names nobody for a reopened turn whose agent no longer exists, rather than the wrong one", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/agent/agents")) {
        // The agent that answered (id 3) has since been deleted.
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 99, name: "Customer-Support", is_active: true }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 9,
            title: null,
            created_at: "2026-08-20T10:41:00Z",
            updated_at: "2026-08-20T10:41:05Z",
            messages: [
              {
                id: 1,
                role: "user",
                content: "top items last week",
                agent_id: null,
                trace_id: null,
                meta: null,
                created_at: "2026-08-20T10:41:00Z",
              },
              {
                id: 2,
                role: "assistant",
                content: "Chicken Biryani led the week.",
                agent_id: 3,
                trace_id: "t1",
                meta: { ui_parts: [] },
                created_at: "2026-08-20T10:41:05Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    const { chatRef } = renderThread();
    await act(() => chatRef.current!.loadConversation(9));

    expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument();
    expect(screen.queryByText("Customer-Support")).not.toBeInTheDocument();
  });

  it("renders a reopened answer whole, even where the typewriter would otherwise run", async () => {
    // The requirement that looks broken when it is wrong: only a run this
    // session watched may reveal itself character by character. Everything
    // else in this file runs in jsdom, which has no matchMedia and so
    // never animates at all — so this is the one test that has to put the
    // reveal in a position to fire and prove it does not.
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    // Frames are requested but never delivered: if this turn animated, the
    // answer would sit at zero characters forever.
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    fetchMock.mockImplementation(
      routeFetch(() => new Response(
        JSON.stringify({
          id: 9,
          title: null,
          created_at: "2026-08-20T10:41:00Z",
          updated_at: "2026-08-20T10:41:05Z",
          messages: [
            {
              id: 76,
              role: "user",
              content: "top items last week",
              agent_id: null,
              trace_id: null,
              meta: null,
              created_at: "2026-08-20T10:41:00Z",
            },
            {
              id: 77,
              role: "assistant",
              content: "Chicken Biryani led the week.",
              agent_id: 3,
              trace_id: "t1",
              meta: { ui_parts: [] },
              created_at: "2026-08-20T10:41:05Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )),
    );

    const { chatRef } = renderThread();
    await act(() => chatRef.current!.loadConversation(9));

    expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument();
  });

  it("renders a chart part alongside the table rather than falling through to the empty state", async () => {
    fetchMock.mockImplementation(
      routeFetch(() =>
        sseResponse([
          `data: {"type":"start","messageId":"msg-4"}`,
          `data: {"type":"data-table","data":{"columns":["store"],"rows":[["Bandra"]]}}`,
          `data: {"type":"data-chart","data":{"title":"Net sales by month","subLabel":"last 4 months","series":[{"key":"net","label":"Net sales","color":"var(--sheet-accent)"}],"data":[{"label":"May","values":{"net":29082789}},{"label":"Jun","values":{"net":18492463}}]}}`,
          `data: {"type":"text-start","id":"answer"}`,
          `data: {"type":"text-delta","id":"answer","delta":"Bandra led."}`,
          `data: {"type":"text-end","id":"answer"}`,
          `data: {"type":"finish"}`,
          `data: [DONE]`,
        ]),
      ),
    );
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("month on month net sales"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    // Both sheets, both real — not one sheet and one "No data for this
    // window." placeholder.
    expect(screen.getByText("Query results")).toBeInTheDocument();
    expect(screen.getByText("Net sales by month")).toBeInTheDocument();
    expect(screen.queryByText("No data for this window.")).not.toBeInTheDocument();
    // The axis is legible at money scale rather than eight digits wide.
    expect(screen.getByText("3Cr")).toBeInTheDocument();
    expect(screen.getByText("May")).toBeInTheDocument();
  });

  it("leaves a legible error line, not a stuck rail, when a run fails mid-stream", async () => {
    fetchMock.mockImplementation(
      routeFetch(() =>
        sseResponse([
          `data: {"type":"start","messageId":"msg-2"}`,
          `data: {"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`,
          `data: {"type":"error","errorText":"the run failed unexpectedly (ref: abc123)"}`,
          `data: [DONE]`,
        ]),
      ),
    );
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("hello"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    expect(screen.getByText(/the run failed unexpectedly \(ref: abc123\)/)).toBeInTheDocument();
    expect(screen.getByText(/Try asking again\./)).toBeInTheDocument();
    expect(screen.queryByText(/sorry/i)).not.toBeInTheDocument();
  });

  it("copies the question's own text from its own Copy button, not the answer's", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    fireEvent.click(screen.getByRole("button", { name: "Copy question" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("top items last week"));
    expect(writeText).not.toHaveBeenCalledWith("Chicken Biryani led the week.");
  });

  it("copies the answer's own text from its own Copy button, not the question's", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Chicken Biryani led the week."));
    expect(writeText).not.toHaveBeenCalledWith("top items last week");
  });

  it("rerun sends a brand-new run with the same question text, appending rather than editing history", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));
    expect(chatRef.current!.messages).toHaveLength(2);

    const rerunButtons = screen.getAllByRole("button", { name: "Rerun this question" });
    act(() => fireEvent.click(rerunButtons[0]!));

    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    // The original turn is still there (rerun never edits history) plus a
    // brand-new pair carrying the identical question text.
    expect(chatRef.current!.messages).toHaveLength(4);
    const askedTexts = chatRef.current!.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(askedTexts).toEqual(["top items last week", "top items last week"]);

    // `postAgentRun` goes through `GatewayClient.agentStream` now, which
    // calls `fetch(new Request(url, init))` — one argument — so both the URL
    // and the body are read off the Request.
    const runCalls = fetchMock.mock.calls.filter((call) =>
      (call[0] as Request).url.endsWith("/agent/run"),
    );
    expect(runCalls).toHaveLength(2);
    const secondRequestBody = await (runCalls[1]![0] as Request).json();
    expect(secondRequestBody.message).toBe("top items last week");
  });

  it("selecting text inside a message bubble is not blocked by any wrapper", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    const answer = screen.getByText("Chicken Biryani led the week.");
    // Neither the paragraph nor any ancestor up to the thread root opts
    // out of text selection — the actual mechanism a "can't select text"
    // bug in this codebase would use (CLAUDE.md's own house style has no
    // other way to block it: no drag handler, no overlay).
    let node: HTMLElement | null = answer;
    while (node && node !== document.body) {
      expect(getComputedStyle(node).userSelect).not.toBe("none");
      node = node.parentElement;
    }
  });
  it("leads with a stat row and folds the query table behind its row count", async () => {
    // The reader's complaint, end to end: "net sales per store, median and
    // IQR" answered with a paragraph and 265 rows, the two figures asked
    // for appearing in no component at all.
    const frames = [
      `data: {"type":"start","messageId":"msg-9"}`,
      // 265 rows, because the collapse rule is about a table big enough
      // to drown the answer — a short one stays inline (partLayout.ts).
      `data: ${JSON.stringify({
        type: "data-table",
        data: {
          columns: ["store", "net_sales"],
          rows: [["Bandra", "400000.00"]].concat(
            Array.from({ length: 264 }, (_, n) => [`Store ${n}`, `${n}00000.00`]),
          ),
          row_count: 265,
          column_kinds: ["text", "currency"],
        },
      })}`,
      `data: {"type":"data-stats","data":{"title":"Net sales per store","subLabel":"last 14 days · over 265 values","figures":[{"label":"Median net sales","value":"\u20b99,44,220.66"},{"label":"IQR net sales","value":"\u20b99,62,279.45"}]}}`,
      `data: {"type":"text-start","id":"answer"}`,
      `data: {"type":"text-delta","id":"answer","delta":"Half the stores clear 9.4 lakh."}`,
      `data: {"type":"text-end","id":"answer"}`,
      `data: {"type":"finish"}`,
      `data: [DONE]`,
    ];
    fetchMock.mockImplementation(routeFetch(() => sseResponse(frames)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("median and IQR of net sales per store"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    // The figures are on screen as figures.
    expect(screen.getByText("₹9,44,220.66")).toBeInTheDocument();
    expect(screen.getByText("₹9,62,279.45")).toBeInTheDocument();

    // The table is still there — it is what the figures are checked
    // against — but closed, and labelled with the count it is hiding.
    const disclosure = document.querySelector("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure!.open).toBe(false);
    const summary = disclosure!.querySelector("summary")!;
    expect(summary).toHaveTextContent("265 rows");
    fireEvent.click(summary);
    expect(screen.getByText("Bandra")).toBeInTheDocument();

    // And it comes after the answer, not before it.
    const statsNode = screen.getByText("Net sales per store");
    expect(
      statsNode.compareDocumentPosition(disclosure!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leaves a plain ranking's table open, because there the table is the answer", async () => {
    // The property a careless "just collapse every table" change breaks.
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    expect(screen.getByText("Chicken Biryani")).toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });
});

// --- the reading is printed once ------------------------------------------
//
// `show_summary` produces the same words twice by design: a `data-summary`
// part for the eye, and prose for the judge, the stored message and Copy.
// Rendering both printed the answer to the reader twice — once laid out,
// then again as a markdown restatement below the evidence.

const SUMMARY_FRAMES = [
  `data: {"type":"start","messageId":"msg-1"}`,
  `data: {"type":"data-summary","data":{"headline":"Chicken Biryani led the week","points":["It outsold the next item two to one."]}}`,
  `data: {"type":"text-start","id":"answer"}`,
  `data: {"type":"text-delta","id":"answer","delta":"Chicken Biryani led the week. It outsold the next item two to one."}`,
  `data: {"type":"text-end","id":"answer"}`,
  `data: {"type":"finish","messageMetadata":{}}`,
  `data: [DONE]`,
];

describe("an answer that laid itself out", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not restate the summary as prose beneath itself", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(SUMMARY_FRAMES)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    expect(screen.getAllByText(/Chicken Biryani led the week/)).toHaveLength(1);
  });

  it("still renders prose when nothing laid itself out", async () => {
    fetchMock.mockImplementation(routeFetch(() => sseResponse(GOLDEN_FRAMES)));
    const { chatRef } = renderThread();

    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    expect(screen.getByText(/Chicken Biryani led the week\./)).toBeInTheDocument();
  });
});
