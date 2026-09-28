import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
    /** A status to answer `GET .../{id}` with instead of a detail — 404
     * for a deleted conversation or a colleague's. */
    conversationStatus?: Record<number, number>;
    /** Answers `GET .../{id}` whenever the test says so, for asserting what
     * is on screen while it is still loading. */
    conversationGate?: Promise<void>;
  } = {},
) {
  const { runFrames = [], historyItems = [], conversationDetail = {}, conversationStatus = {}, conversationGate } =
    options;
  return vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.endsWith("/agent/agents")) {
      return Promise.resolve(jsonResponse([{ id: 1, name: "Sales Analyst", description: null, is_active: true }]));
    }
    if (url.includes("/agent/conversations/")) {
      const id = Number(url.split("/agent/conversations/")[1]);
      const status = conversationStatus[id];
      if (status !== undefined) return Promise.resolve(jsonResponse({ detail: "conversation not found" }, status));
      const detail = conversationDetail[id];
      if (detail === undefined) return Promise.reject(new Error(`no fixture for conversation ${id}`));
      return (conversationGate ?? Promise.resolve()).then(() => jsonResponse(detail));
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
/** The router's current query string, as the last render saw it. */
let currentSearch = "";

function renderAskRoute(fetchMock: ReturnType<typeof vi.fn>, initialEntry = "/ask") {
  vi.stubGlobal("fetch", fetchMock);
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    currentSearch = useLocation().search;
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

  it("keeps the History button's aria-expanded and aria-controls in step with the panel, and returns focus to it", () => {
    renderAskRoute(routeFetch());
    const button = screen.getByRole("button", { name: /^Conversation history$/ });
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);

    // The same element, still in the document. It used to be unmounted
    // with the rest of the conversation view, so a reference to it kept
    // reading "false" while the panel was open.
    const region = screen.getByRole("region", { name: "Conversation history" });
    expect(button.isConnected).toBe(true);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(region.id).not.toBe("");
    expect(button).toHaveAttribute("aria-controls", region.id);

    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
  });

  it("keeps a half-typed question through a trip into History and back", async () => {
    renderAskRoute(routeFetch());
    await waitFor(() => expect(screen.getByLabelText("Ask a question")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "fuel spend by dep" } });

    fireEvent.click(screen.getByRole("button", { name: /^Conversation history$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));

    expect(screen.getByLabelText("Ask a question")).toHaveValue("fuel spend by dep");
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

  // --- opening a linked conversation (`?conversation=`) --------------------

  const LINKED = {
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
  };

  const NOT_OPENED = /That conversation couldn't be opened\. It may have been deleted, or it belongs to someone else\./;

  it("says so when a linked conversation can't be opened, and offers a new one instead", async () => {
    // A deleted conversation and a colleague's both answer 404 — the server
    // will not say which, on purpose.
    renderAskRoute(routeFetch({ conversationStatus: { 9: 404 } }), "/ask?conversation=9");

    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_OPENED);
    // Asking again would get the same 404.
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.queryByText("Hi! Welcome to AI Assistant")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));

    expect(screen.getByText("Hi! Welcome to AI Assistant")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers to try again when the link failed for a reason that may pass", async () => {
    let fail = true;
    const base = routeFetch({ conversationDetail: { 9: LINKED } });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (fail && urlOf(input).includes("/agent/conversations/9")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return base(input);
    });
    renderAskRoute(fetchMock, "/ask?conversation=9");

    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_OPENED);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows it is opening a linked conversation, with nothing to click that the conversation would overwrite", async () => {
    let arrive = () => {};
    const gate = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const fetchMock = routeFetch({ conversationDetail: { 9: LINKED }, conversationGate: gate });
    renderAskRoute(fetchMock, "/ask?conversation=9");

    expect(screen.getByRole("status")).toHaveTextContent("Opening conversation…");
    // The quick actions are not on screen to be clicked, and the composer
    // is shut: a question sent now would be wiped when the thread arrives.
    expect(screen.queryByRole("button", { name: /create dashboard/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => urlOf(call[0]).endsWith("/agent/agents"))).toBe(true);
    });
    expect(screen.getByLabelText("Ask a question").closest("fieldset")).toBeDisabled();

    await act(async () => arrive());

    await waitFor(() => expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument());
    expect(screen.queryByText("Opening conversation…")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Ask a question").closest("fieldset")).not.toBeDisabled();
  });

  it("gives History's Share the console's own /ask link, the one this route opens", async () => {
    const { messages: _messages, ...summary } = LINKED;
    renderAskRoute(routeFetch({ historyItems: [{ ...summary, message_count: 2, last_assistant_snippet: null }] }));
    fireEvent.click(screen.getByRole("button", { name: /^Conversation history$/ }));

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      fireEvent.click(await screen.findByRole("button", { name: /copy link to top items last week/i }));

      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/ask?conversation=9`),
      );
    } finally {
      // @ts-expect-error -- test-only teardown of a property defined above
      delete navigator.clipboard;
    }
  });

  it("opens a linked conversation once, and takes the link out of the URL so a return does not reopen it", async () => {
    const fetchMock = routeFetch({ conversationDetail: { 9: LINKED } });
    renderAskRoute(fetchMock, "/ask?conversation=9&tab=x");

    await waitFor(() => expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument());
    // Once, even under StrictMode's double effects.
    expect(fetchMock.mock.calls.filter((call) => urlOf(call[0]).endsWith("/agent/conversations/9"))).toHaveLength(1);
    // Only its own parameter goes.
    expect(currentSearch).toBe("?tab=x");
  });
});
