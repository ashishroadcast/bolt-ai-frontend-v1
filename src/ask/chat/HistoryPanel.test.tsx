import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider } from "./ChatContext.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { TestAskProvider } from "../testing.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

function methodOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.method : "GET";
}

function renderPanel(fetchMock: ReturnType<typeof vi.fn>, onClose: () => void = () => {}) {
  vi.stubGlobal("fetch", fetchMock);
  return render(<TestAskProvider>
      <ChatProvider>
      <HistoryPanel onClose={onClose} />
    </ChatProvider>
    </TestAskProvider>,
  );
}

const ONE_ITEM = [
  {
    id: 4,
    title: "Weekend discount spike",
    created_at: "2026-08-20T10:41:00Z",
    updated_at: "2026-08-20T10:41:00Z",
    message_count: 2,
    last_assistant_snippet: "Chicken Biryani led the week.",
  },
];

describe("HistoryPanel", () => {
  beforeEach(() => {
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error -- test-only teardown of a property redefined per test
    delete navigator.clipboard;
  });

  it("lists a past conversation's snippet, falling back to a formatted date for a null title", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          items: [
            {
              id: 4,
              title: null,
              created_at: "2026-08-20T10:41:00Z",
              updated_at: "2026-08-20T10:41:00Z",
              message_count: 2,
              last_assistant_snippet: "Chicken Biryani led the week.",
            },
          ],
          next_cursor: null,
        }),
      ),
    );
    renderPanel(fetchMock);

    await waitFor(() => {
      expect(screen.getByText("Chicken Biryani led the week.")).toBeInTheDocument();
    });
    // The heading text is locale/timezone-formatted from created_at (no
    // title to show), so this asserts it's real, non-empty text rather
    // than pinning an exact formatted string.
    const item = screen.getByRole("button", { name: /open conversation/i });
    expect(item.textContent?.trim()).not.toBe("");
    expect(item.textContent).not.toContain("null");
  });

  it("renders a pipe-delimited answer as something readable, not as a wall of pipes", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          items: [
            {
              id: 5,
              title: null,
              created_at: "2026-08-20T10:41:00Z",
              updated_at: "2026-08-20T10:41:00Z",
              message_count: 2,
              last_assistant_snippet: "store_id | store_name\n---|---\n280 | The Bombay Canteen",
            },
          ],
          next_cursor: null,
        }),
      ),
    );
    renderPanel(fetchMock);

    await waitFor(() => {
      expect(screen.getByText("store_id · store_name · 280 · The Bombay Canteen")).toBeInTheDocument();
    });
    expect(screen.queryByText(/\|/)).not.toBeInTheDocument();
  });

  it("says how many messages a conversation holds, so a thread is distinguishable from a one-shot", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ items: [{ ...ONE_ITEM[0], message_count: 6 }], next_cursor: null })),
    );
    renderPanel(fetchMock);

    await waitFor(() => expect(screen.getByText("6 messages")).toBeInTheDocument());
  });

  it("says one message, not 1 messages", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ items: [{ ...ONE_ITEM[0], message_count: 1 }], next_cursor: null })),
    );
    renderPanel(fetchMock);

    await waitFor(() => expect(screen.getByText("1 message")).toBeInTheDocument());
  });

  it("shows a real title verbatim when the conversation has one", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: ONE_ITEM, next_cursor: null })));
    renderPanel(fetchMock);

    await waitFor(() => {
      expect(screen.getByText("Weekend discount spike")).toBeInTheDocument();
    });
  });

  it("shows an honest empty state when there is no history yet", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: [], next_cursor: null })));
    renderPanel(fetchMock);

    await waitFor(() => {
      expect(screen.getByText("No past conversations yet.")).toBeInTheDocument();
    });
  });

  it("re-fetches with ?search= once the operator types", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(jsonResponse({ items: [], next_cursor: null })),
    );
    renderPanel(fetchMock);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const input = screen.getByRole("searchbox", { name: /search past conversations/i });
    fireEvent.change(input, { target: { value: "biryani" } });

    await waitFor(
      () => {
        const urls = fetchMock.mock.calls.map((call) => urlOf(call[0]));
        expect(urls.some((url) => url.includes("search=biryani"))).toBe(true);
      },
      { timeout: 1000 },
    );
  });

  it("surfaces a load error rather than an endless loading state", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ detail: "nope" }, 500)));
    renderPanel(fetchMock);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  // This task's actual bug (see useChat.ts): the panel itself rendering,
  // populated or not, was never the problem — clicking an item silently
  // failed to open it. Pinning that the panel is visible immediately, in
  // its default (pre-fetch) state, guards the other half: a regression
  // that hid the whole panel would look like "history doesn't open" too,
  // and nothing above this line would catch it.
  it("is visible in its default state, before any conversation has loaded", () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: [], next_cursor: null })));
    renderPanel(fetchMock);

    expect(screen.getByRole("region", { name: "Conversation history" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /search past conversations/i })).toBeInTheDocument();
  });

  it("puts the caret in the search box, because finding one is why it was opened", () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: [], next_cursor: null })));
    renderPanel(fetchMock);

    expect(screen.getByRole("searchbox", { name: /search past conversations/i })).toHaveFocus();
  });

  it("closes itself once a conversation has actually opened", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (urlOf(input).includes("/agent/conversations/4")) {
        return Promise.resolve(
          jsonResponse({
            id: 4,
            title: null,
            created_at: "2026-08-20T10:41:00Z",
            updated_at: "2026-08-20T10:41:00Z",
            messages: [],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ items: ONE_ITEM, next_cursor: null }));
    });
    renderPanel(fetchMock, onClose);
    await screen.findByText("Weekend discount spike");

    fireEvent.click(screen.getByRole("button", { name: /open conversation/i }));

    // A drawer that stays up over the thread it just navigated to is the
    // "in the way" complaint again, in miniature.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("stays open when the conversation failed to load, so the error can be read", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (urlOf(input).includes("/agent/conversations/4")) {
        return Promise.resolve(jsonResponse({ detail: "nope" }, 500));
      }
      return Promise.resolve(jsonResponse({ items: ONE_ITEM, next_cursor: null }));
    });
    renderPanel(fetchMock, onClose);
    await screen.findByText("Weekend discount spike");

    fireEvent.click(screen.getByRole("button", { name: /open conversation/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and on its own back arrow", () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: [], next_cursor: null })));
    renderPanel(fetchMock, onClose);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("copies a working link to the conversation when Share is clicked", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: ONE_ITEM, next_cursor: null })));
    renderPanel(fetchMock);
    await screen.findByText("Weekend discount spike");

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    fireEvent.click(screen.getByRole("button", { name: /copy link to weekend discount spike/i }));

    // A real permalink AskRoute.tsx actually understands (?conversation=)
    // — not a decorative string that happens to look like one.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/ask?conversation=4")));
  });

  it("deletes only after a second, explicit confirmation click", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      const method = methodOf(input);
      if (method === "DELETE" && url.endsWith("/agent/conversations/4")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse({ items: ONE_ITEM, next_cursor: null }));
    });
    renderPanel(fetchMock);
    await screen.findByText("Weekend discount spike");

    fireEvent.click(screen.getByRole("button", { name: /delete weekend discount spike/i }));

    // Arming the confirm must not itself delete anything.
    expect(fetchMock.mock.calls.some((call) => methodOf(call[0]) === "DELETE")).toBe(false);
    const confirmButton = await screen.findByRole("button", { name: /confirm delete/i });

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => methodOf(call[0]) === "DELETE")).toBe(true);
    });
    // Copy rule (CLAUDE.md): Delete asks, then reports Deleted.
    await waitFor(() => expect(screen.getByText("Deleted.")).toBeInTheDocument());
    expect(screen.queryByText("Weekend discount spike")).not.toBeInTheDocument();
  });

  it("leaves the row in place and reports the failure when a delete request fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      const method = methodOf(input);
      if (method === "DELETE" && url.endsWith("/agent/conversations/4")) {
        return Promise.resolve(jsonResponse({ detail: "nope" }, 500));
      }
      return Promise.resolve(jsonResponse({ items: ONE_ITEM, next_cursor: null }));
    });
    renderPanel(fetchMock);
    await screen.findByText("Weekend discount spike");

    fireEvent.click(screen.getByRole("button", { name: /delete weekend discount spike/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm delete/i }));

    await waitFor(() => {
      expect(screen.getByText(/couldn.t delete/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Weekend discount spike")).toBeInTheDocument();
  });

  // --- channel runs (`?source=`) ------------------------------------------
  //
  // A complaint or Chatwoot thread is recorded as a conversation the same
  // way a typed one is, but owned by the binding's `owner_user_id` — so it
  // is only reachable through `?source=channel`, which the server scopes to
  // the tenant rather than to the caller.

  const CHANNEL_ITEM = [
    {
      id: 30,
      title: null,
      created_at: "2026-09-01T02:45:20Z",
      updated_at: "2026-09-01T02:45:20Z",
      message_count: 2,
      last_assistant_snippet: "The claim is chronologically impossible.",
      external_ref: "complaint:d54adbaa-b800-46e1-8b06-46a7ee668cee",
    },
  ];

  it("sends no source param on the default tab, so an older agent-service still answers", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      seen.push(urlOf(input));
      return Promise.resolve(jsonResponse({ items: ONE_ITEM, next_cursor: null }));
    });
    renderPanel(fetchMock);
    await screen.findByText("Weekend discount spike");

    expect(seen).not.toHaveLength(0);
    expect(seen.every((u) => !u.includes("source="))).toBe(true);
  });

  it("asks for channel runs when the Channels tab is chosen", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      seenUrls.push(urlOf(input));
      return Promise.resolve(
        jsonResponse({
          items: urlOf(input).includes("source=channel") ? CHANNEL_ITEM : ONE_ITEM,
          next_cursor: null,
        }),
      );
    });
    renderPanel(fetchMock);
    await screen.findByText("Weekend discount spike");

    fireEvent.click(screen.getByRole("tab", { name: "Channels" }));

    await waitFor(() => {
      expect(screen.getByText("The claim is chronologically impossible.")).toBeInTheDocument();
    });
    expect(seenUrls.some((u) => u.includes("source=channel"))).toBe(true);
  });

  it("names the channel in a channel run's heading instead of a bare date", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: CHANNEL_ITEM, next_cursor: null })));
    renderPanel(fetchMock);
    fireEvent.click(screen.getByRole("tab", { name: "Channels" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /open conversation: complaint/i })).toBeInTheDocument();
    });
  });

  it("offers no Delete on a channel run, because the server refuses it", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: CHANNEL_ITEM, next_cursor: null })));
    renderPanel(fetchMock);
    fireEvent.click(screen.getByRole("tab", { name: "Channels" }));

    await screen.findByText("The claim is chronologically impossible.");
    expect(screen.queryByRole("button", { name: /^delete/i })).not.toBeInTheDocument();
  });
});
