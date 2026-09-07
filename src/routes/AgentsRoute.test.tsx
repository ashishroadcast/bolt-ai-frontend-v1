import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayClient } from "../api/client.ts";
import { setSession } from "../auth/session.ts";
import { ChatProvider, useChatContext } from "../chat/ChatContext.tsx";
import type { UseChatResult } from "../chat/useChat.ts";
import { AgentsRoute } from "./AgentsRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const AGENTS = [
  { id: 1, name: "Analytics", description: "Answers sales questions", is_active: true },
  { id: 2, name: "Retired Bot", description: null, is_active: false },
];

function agentDetail(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `agent-${id}`,
    description: null,
    pipeline_config: {},
    datasource_id: null,
    llm_bindings: {},
    code_execution: "none",
    is_active: true,
    compiled_programs: {},
    mcp_server_ids: [],
    ...overrides,
  };
}

/** Every endpoint the screen reads, wired to one lookup so a test only
 * has to say what it cares about. */
function routeAgentFetch(byPath: Record<string, unknown>) {
  return async (path: string) => {
    if (path in byPath) {
      const value = byPath[path];
      if (value instanceof Error) throw value;
      return value as never;
    }
    throw new Error(`unexpected path ${path}`);
  };
}

function renderAgentsRoute() {
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    return null;
  }
  const result = render(
    <MemoryRouter initialEntries={["/agents"]}>
      <ChatProvider>
        <Capture />
        <Routes>
          <Route path="/agents" element={<AgentsRoute />} />
          <Route path="/ask" element={<div>Ask screen</div>} />
        </Routes>
      </ChatProvider>
    </MemoryRouter>,
  );
  return { ...result, chatRef };
}

/** The card for one agent, so an assertion can't be satisfied by another
 * card's identical text. */
function cardFor(name: string): HTMLElement {
  return screen.getByRole("heading", { name }).closest("article") as HTMLElement;
}

describe("AgentsRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ token: "tok", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSession(null);
  });

  it("renders agent names, descriptions and status from the real response, not placeholders", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      routeAgentFetch({
        "/agent/agents": AGENTS,
        "/agent/agents/1": agentDetail(1),
        "/agent/agents/2": agentDetail(2),
        "/agent/datasources": [],
        "/agent/llm-configs": [],
        "/agent/mcp-servers": [],
      }),
    );

    renderAgentsRoute();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
    });
    expect(screen.getByText("Answers sales questions")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Retired Bot" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("requests GET /agent/agents with a bearer token and no tenant/user id anywhere in the request", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    renderAgentsRoute();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.method).toBe("GET");
    expect(request.url).toMatch(/\/agent\/agents$/);
    expect(request.url).not.toMatch(/tenant/i);
    expect(request.url).not.toMatch(/user/i);
    expect(request.headers.get("Authorization")).toBe("Bearer tok");
  });

  it("shows an honest empty state with no fabricated create action", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    renderAgentsRoute();

    await waitFor(() => {
      expect(screen.getByText(/No agents exist for this tenant yet/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // There is no POST or DELETE /agent/agents. A card full of buttons is
  // exactly where a New agent / Delete would get drawn by reflex, so this
  // pins their absence even when cards *do* render.
  it("draws no create or delete action, because neither endpoint exists", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      routeAgentFetch({
        "/agent/agents": AGENTS,
        "/agent/agents/1": agentDetail(1),
        "/agent/agents/2": agentDetail(2),
        "/agent/datasources": [],
        "/agent/llm-configs": [],
        "/agent/mcp-servers": [],
      }),
    );

    renderAgentsRoute();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /new agent|create|add agent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete|remove/i })).not.toBeInTheDocument();
  });

  it("surfaces the server's own error text rather than a blank screen", async () => {
    // A plain 400/422 exercises AgentApiError's real `detail` surfacing —
    // 401/403 both route through GatewayClient's own UnauthorizedError
    // path instead (fixed "session ended" message, sign-out side effect).
    fetchMock.mockResolvedValue(jsonResponse({ detail: "agent service unavailable" }, 400));

    renderAgentsRoute();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("agent service unavailable");
    });
  });

  it("links each agent name to its own detail route", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      routeAgentFetch({
        "/agent/agents": [{ id: 9, name: "Analytics", description: "d", is_active: true }],
        "/agent/agents/9": agentDetail(9),
        "/agent/datasources": [],
        "/agent/llm-configs": [],
        "/agent/mcp-servers": [],
      }),
    );

    renderAgentsRoute();

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Analytics" })).toHaveAttribute("href", "/agents/9");
    });
    expect(screen.getByRole("link", { name: "Configure" })).toHaveAttribute("href", "/agents/9/config");
  });

  // The card's reason to exist over the table it replaced: what an agent
  // is wired to, with every id resolved. Ids on screen would mean the
  // fan-out ran but the resolution didn't.
  it("resolves each agent's datasource, model and tool-server ids to names on its own card", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      routeAgentFetch({
        "/agent/agents": AGENTS,
        "/agent/agents/1": agentDetail(1, {
          datasource_id: 6,
          llm_bindings: { plan: 9, execute: 9 },
          mcp_server_ids: [3],
          code_execution: "interpreter",
        }),
        "/agent/agents/2": agentDetail(2),
        "/agent/datasources": [{ id: 6, name: "Reporting warehouse" }],
        "/agent/llm-configs": [{ id: 9, name: "House GPT", model: "openai/gpt-5" }],
        "/agent/mcp-servers": [{ id: 3, name: "Order lookup", discovered_tools: [] }],
      }),
    );

    renderAgentsRoute();

    await waitFor(() => {
      expect(within(cardFor("Analytics")).getByText("Reporting warehouse")).toBeInTheDocument();
    });
    const analytics = cardFor("Analytics");
    expect(within(analytics).getByText(/House GPT/)).toBeInTheDocument();
    expect(within(analytics).getByText(/2\/5 phases pinned/)).toBeInTheDocument();
    expect(within(analytics).getByText("Order lookup")).toBeInTheDocument();
    expect(within(analytics).getByText("interpreter")).toBeInTheDocument();
    expect(analytics.textContent).not.toMatch(/id 6|id 9|id 3/);

    // The wiring is per agent, not the first agent's smeared across every
    // card — agent 2 is bound to nothing and has to say so.
    const retired = cardFor("Retired Bot");
    expect(within(retired).getByText("No datasource")).toBeInTheDocument();
    expect(within(retired).getByText("No tool servers")).toBeInTheDocument();
    expect(within(retired).getByText(/Tenant default, all 5 phases/)).toBeInTheDocument();
  });

  // The detail read is gated on `agent.agents` while the list is not, so
  // an operator who may run agents but not read their configuration is a
  // real caller. They must still get the list.
  it("still lists agents when the wiring reads fail, and says why once", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      routeAgentFetch({
        "/agent/agents": AGENTS,
        "/agent/agents/1": new Error("forbidden"),
        "/agent/agents/2": agentDetail(2),
        "/agent/datasources": [],
        "/agent/llm-configs": [],
        "/agent/mcp-servers": [],
      }),
    );

    renderAgentsRoute();

    await waitFor(() => {
      expect(screen.getByText(/Showing names and status only/)).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Retired Bot" })).toBeInTheDocument();
    // One explanation for the screen, not one per card.
    expect(screen.getAllByText(/Showing names and status only/)).toHaveLength(1);
  });

  // Both directions, because a control hard-wired to `is_active: true`
  // passes a one-way test and silently makes Deactivate a no-op.
  it("toggling an agent PATCHes the opposite of its current state, and adopts the server's answer", async () => {
    const agentFetch = vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      routeAgentFetch({
        "/agent/agents": AGENTS,
        "/agent/agents/1": agentDetail(1),
        "/agent/agents/2": agentDetail(2),
        "/agent/datasources": [],
        "/agent/llm-configs": [],
        "/agent/mcp-servers": [],
      }),
    );

    renderAgentsRoute();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Retired Bot" })).toBeInTheDocument());

    agentFetch.mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") {
        const id = Number(path.split("/").pop());
        return agentDetail(id, JSON.parse(String(init.body))) as never;
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    });

    // Inactive agent -> Activate.
    fireEvent.click(screen.getByRole("button", { name: "Activate Retired Bot" }));
    await waitFor(() => {
      expect(within(cardFor("Retired Bot")).getByText("Active")).toBeInTheDocument();
    });
    // The button is the verb and has to flip with the state.
    expect(
      within(cardFor("Retired Bot")).getByRole("button", { name: "Deactivate Retired Bot" }),
    ).toBeInTheDocument();

    // Active agent -> Deactivate. `false`, not `true` again.
    fireEvent.click(screen.getByRole("button", { name: "Deactivate Analytics" }));
    await waitFor(() => {
      expect(within(cardFor("Analytics")).getByText("Inactive")).toBeInTheDocument();
    });

    const writes = agentFetch.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
      // Only `is_active` — a patch carrying anything else would replace
      // fields the operator never touched (`llm_bindings` replaces
      // wholesale, so an accidental `{}` unbinds every phase).
      ["/agent/agents/2", { is_active: true }],
      ["/agent/agents/1", { is_active: false }],
    ]);
  });

  it("keeps the card's real state and shows the failure when the write is refused", async () => {
    const agentFetch = vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      routeAgentFetch({
        "/agent/agents": AGENTS,
        "/agent/agents/1": agentDetail(1),
        "/agent/agents/2": agentDetail(2),
        "/agent/datasources": [],
        "/agent/llm-configs": [],
        "/agent/mcp-servers": [],
      }),
    );

    renderAgentsRoute();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument());

    agentFetch.mockRejectedValue(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Deactivate Analytics" }));

    await waitFor(() => {
      expect(within(cardFor("Analytics")).getByRole("alert")).toBeInTheDocument();
    });
    // Still Active: the screen must never claim a state the server refused.
    expect(within(cardFor("Analytics")).getByText("Active")).toBeInTheDocument();
  });

  // Ask replaces the deleted Run tab. Asserting only the navigation would
  // pass for a bare link to /ask — `selectedAgent` is what Composer sends
  // as `RunIn.agent`, so leaving it unset runs against the wrong agent.
  it("Ask points the Ask screen at that card's agent before navigating", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      routeAgentFetch({
        "/agent/agents": AGENTS,
        "/agent/agents/1": agentDetail(1),
        "/agent/agents/2": agentDetail(2),
        "/agent/datasources": [],
        "/agent/llm-configs": [],
        "/agent/mcp-servers": [],
      }),
    );

    const { chatRef } = renderAgentsRoute();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Retired Bot" })).toBeInTheDocument());
    expect(chatRef.current!.selectedAgent).toBeNull();

    // The second card, not the first — a hard-coded agents[0] would pass
    // this test if it asserted only that *an* agent was selected.
    fireEvent.click(within(cardFor("Retired Bot")).getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(screen.getByText("Ask screen")).toBeInTheDocument());
    expect(chatRef.current!.selectedAgent).toBe("Retired Bot");
  });
});
