import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { ChannelsRoute } from "./ChannelsRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ORCHESTRATORS = [
  { id: 10, name: "Front desk", description: null, mode: "single", llm_config_id: 1, member_agent_ids: [1], is_active: true },
];

const CHANNELS = [
  {
    id: 1,
    provider: "chatwoot",
    base_url: "https://chatwoot.example.com",
    account_id: 12,
    inbox_id: 34,
    owner_user_id: 42,
    target_kind: "orchestrator",
    target_id: 10,
    handoff_team_id: null,
    score_threshold: 0.5,
    handoff_keywords: [],
    is_active: true,
  },
];

function renderChannels() {
  return render(
    <MemoryRouter initialEntries={["/channels"]}>
      <ChannelsRoute />
    </MemoryRouter>,
  );
}

/** Same "read the method off the real Request object" shape
 * OrchestratorsRoute.test.tsx documents — GatewayClient.agentFetch always
 * calls fetch with a single already-built Request. */
function mockReads(fetchMock: ReturnType<typeof vi.fn>, channels: unknown[] = CHANNELS) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const request = input as Request;
    if (request.url.endsWith("/agent/orchestrators") && request.method === "GET") {
      return Promise.resolve(jsonResponse(ORCHESTRATORS));
    }
    if (request.url.endsWith("/agent/channels") && request.method === "GET") {
      return Promise.resolve(jsonResponse(channels));
    }
    return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
  });
}

describe("ChannelsRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("renders a real binding: account/inbox, resolved orchestrator name, and status", async () => {
    mockReads(fetchMock);

    renderChannels();

    await waitFor(() => expect(screen.getByText(/Account 12/)).toBeInTheDocument());
    expect(screen.getByText(/Inbox 34/)).toBeInTheDocument();
    // target_id 10 resolved to the real orchestrator name, not the raw id.
    expect(screen.getByText("Front desk")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("empty state explains what a channel is for and how to add one, not 'No data'", async () => {
    mockReads(fetchMock, []);

    renderChannels();

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();
    // The empty state's actual guidance — what a channel binding does and
    // how to create the first one — not a placeholder string. Phrasing
    // unique to the empty state's own body (the page header describes the
    // screen too, so a bare /chatwoot/i match would be ambiguous between
    // the two).
    expect(screen.getByText(/wires one chatwoot inbox to an orchestrator/i)).toBeInTheDocument();
    // Two real, wired "Connect a channel" actions on an empty screen — the
    // header's own primary action and the empty state's own invite, same
    // duplication DatabasesRoute.tsx's landed empty state already uses.
    expect(screen.getAllByRole("button", { name: /connect a channel/i }).length).toBeGreaterThan(0);
  });

  it("creating a channel shows the webhook URL exactly once, copyable, and never renders the bot token", async () => {
    mockReads(fetchMock);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/orchestrators") && request.method === "GET") {
        return Promise.resolve(jsonResponse(ORCHESTRATORS));
      }
      if (request.url.endsWith("/agent/channels") && request.method === "GET") {
        return Promise.resolve(jsonResponse(CHANNELS));
      }
      if (request.url.endsWith("/agent/channels") && request.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              id: 2,
              provider: "chatwoot",
              base_url: "https://chatwoot.example.com",
              account_id: 99,
              inbox_id: 88,
              owner_user_id: 42,
              target_kind: "orchestrator",
              target_id: 10,
              handoff_team_id: null,
              score_threshold: 0.5,
              handoff_keywords: [],
              is_active: true,
              webhook_token: "super-secret-webhook-token",
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderChannels();
    await waitFor(() => expect(screen.getByText(/Account 12/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /connect a channel/i }));
    fireEvent.change(screen.getByLabelText(/chatwoot base url/i), {
      target: { value: "https://chatwoot.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/account id/i), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText(/inbox id/i), { target: { value: "88" } });
    const secretToken = "sk-live-shh-do-not-log-me";
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: secretToken } });
    fireEvent.change(screen.getByLabelText(/answers via/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "POST");
      expect(postCall).toBeDefined();
    });

    // The webhook URL Chatwoot needs is shown, this once, built from the
    // fresh webhook_token — and is copyable.
    await waitFor(() => {
      expect(screen.getByText(/hooks\/chatwoot\/super-secret-webhook-token/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();

    // The bot token the operator just typed is never sent back by the
    // server and never appears anywhere in the rendered DOM after submit —
    // proof, not assumption: search the whole document body.
    expect(document.body.textContent).not.toContain(secretToken);
    expect(document.body.innerHTML).not.toContain(secretToken);

    // The field itself is gone (form closed), so there is nowhere left an
    // old value could be sitting in an unmounted-but-cached input either.
    expect(screen.queryByLabelText(/bot token/i)).not.toBeInTheDocument();
  });

  it("running Test reports the live result without ever touching the token", async () => {
    mockReads(fetchMock);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/orchestrators")) return Promise.resolve(jsonResponse(ORCHESTRATORS));
      if (request.url.endsWith("/agent/channels") && request.method === "GET") {
        return Promise.resolve(jsonResponse(CHANNELS));
      }
      if (request.url.endsWith("/agent/channels/1/test") && request.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderChannels();
    await waitFor(() => expect(screen.getByText(/Account 12/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(screen.getByText(/connected/i)).toBeInTheDocument());
  });

  it("delete requires a second, explicit confirmation before anything is sent", async () => {
    mockReads(fetchMock);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/orchestrators")) return Promise.resolve(jsonResponse(ORCHESTRATORS));
      if (request.url.endsWith("/agent/channels") && request.method === "GET") {
        return Promise.resolve(jsonResponse(CHANNELS));
      }
      if (/\/agent\/channels\/\d+$/.test(request.url) && request.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderChannels();
    await waitFor(() => expect(screen.getByText(/Account 12/)).toBeInTheDocument());

    const callsBeforeDelete = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(fetchMock.mock.calls.length).toBe(callsBeforeDelete);

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "DELETE");
      expect(deleteCall).toBeDefined();
    });
    await waitFor(() => expect(screen.queryByText(/Account 12/)).not.toBeInTheDocument());
  });

  it("a long webhook URL scrolls inside its own container rather than the page", async () => {
    mockReads(fetchMock);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/orchestrators")) return Promise.resolve(jsonResponse(ORCHESTRATORS));
      if (request.url.endsWith("/agent/channels") && request.method === "GET") {
        return Promise.resolve(jsonResponse(CHANNELS));
      }
      if (request.url.endsWith("/agent/channels") && request.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              ...CHANNELS[0],
              id: 3,
              webhook_token: "x".repeat(120),
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderChannels();
    await waitFor(() => expect(screen.getByText(/Account 12/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /connect a channel/i }));
    fireEvent.change(screen.getByLabelText(/chatwoot base url/i), {
      target: { value: "https://chatwoot.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/account id/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/inbox id/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "tok" } });
    fireEvent.change(screen.getByLabelText(/answers via/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(screen.getByTestId("webhook-url-box")).toBeInTheDocument());
    const box = screen.getByTestId("webhook-url-box");
    expect(within(box).getByText(/x{20,}/)).toBeInTheDocument();
  });

  // --- providers other than Chatwoot -------------------------------------

  const COMPLAINT_CHANNEL = {
    id: 2,
    provider: "complaint",
    // Where the verdict is POSTed back — not a Chatwoot install.
    base_url: "https://api.restrologic.com",
    // Unused by this provider; written as 0.
    account_id: 0,
    inbox_id: 0,
    owner_user_id: 1,
    target_kind: "orchestrator",
    target_id: 10,
    handoff_team_id: null,
    score_threshold: 0.5,
    handoff_keywords: [],
    is_active: true,
  };

  it("does not dress a complaint binding up as a Chatwoot inbox", async () => {
    mockReads(fetchMock, [COMPLAINT_CHANNEL]);
    renderChannels();

    await screen.findByText("Partner complaints");
    // "Account 0 · Inbox 0" is what the Chatwoot template produced for a
    // provider that has neither.
    expect(screen.queryByText(/Account 0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Inbox 0/)).not.toBeInTheDocument();
  });

  it("says where a complaint binding posts its verdicts, rather than showing a bare URL", async () => {
    mockReads(fetchMock, [COMPLAINT_CHANNEL]);
    renderChannels();

    await screen.findByText(/Verdicts posted to: https:\/\/api\.restrologic\.com/);
  });

  it("offers no Test on a complaint binding, because the probe only speaks Chatwoot", async () => {
    mockReads(fetchMock, [COMPLAINT_CHANNEL]);
    renderChannels();

    await screen.findByText("Partner complaints");
    expect(screen.queryByRole("button", { name: "Test" })).not.toBeInTheDocument();
  });

  it("still offers Test on a Chatwoot binding", async () => {
    mockReads(fetchMock, CHANNELS);
    renderChannels();

    await screen.findByText(/Account 12/);
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
  });
});
