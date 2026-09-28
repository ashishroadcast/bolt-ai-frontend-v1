import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatProvider } from "./chat/ChatContext.tsx";
import { AskAgentsProvider, type AskAgent } from "./chat/useAskAgents.ts";
import { EmptyState } from "./EmptyState.tsx";
import { TestAskProvider } from "./testing.tsx";

/**
 * The quick-action cards were left permanently disabled by the
 * auto-agent-selection change: this component's own `canSend` still read
 * `selectedAgent !== null`, and nothing sets `selectedAgent` any more once
 * the manual picker stopped defaulting it to `agents[0]` — so every card
 * rendered, but none of them were ever clickable. `canSend` now matches
 * `Composer.tsx`'s own gate (`agents.length > 0`), the same fix.
 */

const AGENT: AskAgent = { id: 1, name: "Fleet", is_active: true, slash_command: null };

function openEndedResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"start","messageId":"pending"}\n\n`));
    },
  });
  return new Response(body, { status: 200 });
}

function routed(agents: AskAgent[]): ReturnType<typeof vi.fn> {
  return vi.fn((request: Request) => {
    if (new URL(request.url).pathname === "/agent/agents") {
      return Promise.resolve(
        new Response(JSON.stringify(agents), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(openEndedResponse());
  });
}

function runCalls(fetchMock: ReturnType<typeof vi.fn>): Request[] {
  return fetchMock.mock.calls
    .map((call) => call[0] as Request)
    .filter((request) => new URL(request.url).pathname === "/agent/run");
}

function renderEmptyState() {
  return render(
    <TestAskProvider>
      <ChatProvider>
        <AskAgentsProvider>
          <EmptyState title="Hi" body="body" />
        </AskAgentsProvider>
      </ChatProvider>
    </TestAskProvider>,
  );
}

describe("EmptyState quick actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is clickable once the agent list loads, with no agent armed", async () => {
    const fetchMock = routed([AGENT]);
    vi.stubGlobal("fetch", fetchMock);
    renderEmptyState();

    const card = await screen.findByRole("button", { name: /Create Dashboard/ });
    await waitFor(() => expect(card).toBeEnabled());

    fireEvent.click(card);

    await waitFor(() => expect(runCalls(fetchMock)).toHaveLength(1));
    const body = await runCalls(fetchMock)[0]!.json();
    expect(body).toMatchObject({ message: "Create a dashboard to show daily usage of vehicles." });
    // No agent selected yet — the whole point of auto-routing is that
    // this is sent unnamed, not blocked or defaulted to something guessed
    // client-side.
    expect(body.agent).toBeUndefined();
  });

  it("disables the cards while the browser is offline, and enables them when it reconnects", async () => {
    const fetchMock = routed([AGENT]);
    vi.stubGlobal("fetch", fetchMock);
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    try {
      renderEmptyState();
      const card = await screen.findByRole("button", { name: /Create Dashboard/ });
      await waitFor(() => expect(card).toBeEnabled());

      onLine.mockReturnValue(false);
      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
      expect(card).toBeDisabled();
      fireEvent.click(card);
      expect(runCalls(fetchMock)).toHaveLength(0);

      onLine.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      expect(card).toBeEnabled();
    } finally {
      onLine.mockRestore();
    }
  });

  it("stays disabled while the tenant has no agent at all", async () => {
    const fetchMock = routed([]);
    vi.stubGlobal("fetch", fetchMock);
    renderEmptyState();

    const card = await screen.findByRole("button", { name: /Create Dashboard/ });
    await waitFor(() => expect(card).toBeDisabled());

    fireEvent.click(card);
    expect(runCalls(fetchMock)).toHaveLength(0);
  });
});
