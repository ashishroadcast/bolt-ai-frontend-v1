import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { ChatProvider, useChatContext } from "../ask/chat/ChatContext.tsx";
import { InspectorProvider } from "../shell/InspectorContext.tsx";
import { AskRoute } from "./AskRoute.tsx";
import type { UseChatResult } from "../ask/chat/useChat.ts";
import { TestAskProvider } from "../ask/testing.tsx";

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

/**
 * Routes the shared `fetch` mock by URL rather than one blanket
 * `mockResolvedValue` — AskRoute now mounts `AgentPicker` (`GET /agent/
 * agents`), `HistoryPanel` (`GET /agent/conversations`, and `GET .../{id}`
 * when an item is opened), and `POST /agent/run`, each returning a
 * differently-shaped body. A single shared `Response` object read by all
 * of them breaks: a `Response` body can only be consumed once, and a
 * `mockImplementation` per call sidesteps that by building a fresh one
 * every time instead of reusing one instance across calls.
 */
function routeFetch(
  options: {
    runFrames?: string[];
    historyItems?: unknown[];
    conversationDetail?: Record<number, unknown>;
  } = {},
) {
  const { runFrames = [], historyItems = [], conversationDetail = {} } = options;
  return vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.endsWith("/agent/agents")) {
      return Promise.resolve(jsonResponse([{ id: 1, name: "Sales Analyst", description: null, is_active: true }]));
    }
    if (url.includes("/agent/conversations/")) {
      const id = Number(url.split("/agent/conversations/")[1]);
      const detail = conversationDetail[id];
      if (detail === undefined) return Promise.reject(new Error(`no fixture for conversation ${id}`));
      return Promise.resolve(jsonResponse(detail));
    }
    if (url.includes("/agent/conversations")) {
      return Promise.resolve(jsonResponse({ items: historyItems, next_cursor: null }));
    }
    if (url.endsWith("/agent/run")) {
      return Promise.resolve(sseResponse(runFrames));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

/**
 * Rendered inside `<StrictMode>` — `main.tsx` always does, so a test tree
 * that doesn't is testing a console nobody actually runs. This is the
 * exact condition that caught the real "history doesn't open" bug
 * (`useChat.ts`'s `mountedRef` note): every test below passed against a
 * plain `render()` even while that bug was live, because React only runs
 * its dev-only mount -> cleanup -> remount simulation under StrictMode.
 */
function renderAskRoute(fetchMock: ReturnType<typeof vi.fn>, initialEntry = "/ask") {
  vi.stubGlobal("fetch", fetchMock);
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    return null;
  }
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[initialEntry]}>
        <InspectorProvider>
          <TestAskProvider><ChatProvider>
            <Capture />
            <AskRoute />
          </ChatProvider></TestAskProvider>
        </InspectorProvider>
      </MemoryRouter>
    </StrictMode>,
  );
  return chatRef;
}

describe("AskRoute", () => {
  beforeEach(() => {
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("invites a question when there is no history and nothing running", () => {
    renderAskRoute(routeFetch());
    expect(screen.getByText("Hi! Welcome to AI Assistant")).toBeInTheDocument();
  });

  it("sends a question with no agent named, so the server routes it itself", async () => {
    const fetchMock = routeFetch({
      runFrames: [`data: {"type":"start","messageId":"msg-1"}`, `data: {"type":"finish"}`, `data: [DONE]`],
    });
    renderAskRoute(fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Ask a question")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "top items last week" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => urlOf(call[0]).endsWith("/agent/run"))).toBe(true);
    });
    const request = fetchMock.mock.calls.find((call) => urlOf(call[0]).endsWith("/agent/run"))![0] as Request;
    const body = await request.json();
    expect(body).toMatchObject({ message: "top items last week" });
    expect(body.agent).toBeUndefined();
  });

  it("shows the thread once a run starts, and the empty state never comes back", async () => {
    const chatRef = renderAskRoute(
      routeFetch({
        runFrames: [`data: {"type":"start","messageId":"msg-1"}`, `data: {"type":"finish"}`, `data: [DONE]`],
      }),
    );

    act(() => chatRef.current!.sendMessage("top items last week", { agent: "Sales Analyst" }));

    await waitFor(() => {
      expect(screen.getByText("top items last week")).toBeInTheDocument();
    });
    expect(screen.queryByText("Hi! Welcome to AI Assistant")).not.toBeInTheDocument();
  });

  it("reopening a conversation from the history panel renders its sheets and never the expanded run rail", async () => {
    renderAskRoute(
      routeFetch({
        historyItems: [
          {
            id: 9,
            title: "Top items last week",
            created_at: "2026-08-20T10:41:00Z",
            updated_at: "2026-08-20T10:41:05Z",
            message_count: 2,
            last_assistant_snippet: "Chicken Biryani led the week.",
          },
        ],
        conversationDetail: {
          9: {
            id: 9,
            title: "Top items last week",
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
          },
        },
      }),
    );

    // History is a drawer now, so it has to be opened before there is a
    // row to click at all.
    fireEvent.click(screen.getByRole("button", { name: /^Conversation history$/ }));

    // Named "Open conversation: ..." specifically, not just /Top items
    // last week/ — the row also carries a Share and a Delete button
    // (this task) whose own aria-labels mention the same title text.
    const historyItem = await screen.findByRole("button", { name: /^Open conversation: Top items last week$/i });
    fireEvent.click(historyItem);

    // The persisted turn renders — user bubble, answer text, and the
    // table sheet its ui_parts carried.
    await waitFor(() => {
      expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument();
    });
    expect(screen.getByText("top items last week")).toBeInTheDocument();
    expect(screen.getByText("Chicken Biryani")).toBeInTheDocument();

    // The load-bearing assertion (task brief: "assert the rail is absent,
    // not merely that something rendered"): PhaseRail renders itself as
    // `role="list"` named "Run phases" and nothing else in this tree ever
    // claims that name — HistoryPanel's own list of past conversations is
    // a real, expected `listitem` producer here too, so this checks the
    // rail's specific accessible name rather than "no list anywhere",
    // which would be the wrong (and now false) thing to assert once a
    // history panel sits in the same tree. A reopened run has no
    // transient data-phase events to build a rail from at all — this
    // would fail if PhaseRail were ever wired to render from anything
    // other than the (untouched, still null) `activeRun`.
    expect(screen.queryByRole("list", { name: "Run phases" })).not.toBeInTheDocument();
  });

  it("keeps history out of the conversation until it is asked for, then puts it away again", async () => {
    // Saurabh: "chat history is akwardly placed". It used to be a third
    // column between the nav rail and the thread — permanently on screen,
    // competing with the answer it sat beside.
    renderAskRoute(
      routeFetch({
        historyItems: [
          {
            id: 9,
            title: "Top items last week",
            created_at: "2026-08-20T10:41:00Z",
            updated_at: "2026-08-20T10:41:05Z",
            message_count: 2,
            last_assistant_snippet: "Chicken Biryani led the week.",
          },
        ],
        conversationDetail: {
          9: {
            id: 9,
            title: "Top items last week",
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
                trace_id: null,
                meta: null,
                created_at: "2026-08-20T10:41:05Z",
              },
            ],
          },
        },
      }),
    );

    expect(screen.queryByRole("region", { name: "Conversation history" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Conversation history$/ }));
    expect(screen.getByRole("region", { name: "Conversation history" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /^Open conversation: Top items last week$/i }));

    await waitFor(() => {
      expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument();
    });
    expect(screen.queryByRole("region", { name: "Conversation history" })).not.toBeInTheDocument();
  });

  it("starts a fresh conversation from the thread it is showing", async () => {
    const chatRef = renderAskRoute(
      routeFetch({
        runFrames: [`data: {"type":"start","messageId":"msg-new"}`, `data: {"type":"finish"}`, `data: [DONE]`],
      }),
    );

    // Nothing to start over from yet, so nothing offers to.
    expect(screen.queryByRole("button", { name: /^Start a new conversation$/ })).not.toBeInTheDocument();

    act(() => chatRef.current!.sendMessage("top items last week", { agent: "Sales Analyst" }));
    await waitFor(() => expect(screen.getByText("top items last week")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^Start a new conversation$/ }));

    expect(screen.getByText("Hi! Welcome to AI Assistant")).toBeInTheDocument();
    expect(screen.queryByText("top items last week")).not.toBeInTheDocument();
  });

  it("opens the conversation named by ?conversation= on load, so a Share link actually works", async () => {
    renderAskRoute(
      routeFetch({
        conversationDetail: {
          9: {
            id: 9,
            title: "Top items last week",
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
                trace_id: null,
                meta: null,
                created_at: "2026-08-20T10:41:05Z",
              },
            ],
          },
        },
      }),
      "/ask?conversation=9",
    );

    await waitFor(() => {
      expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument();
    });
    expect(screen.getByText("top items last week")).toBeInTheDocument();
    expect(screen.queryByText("Hi! Welcome to AI Assistant")).not.toBeInTheDocument();
  });
});
