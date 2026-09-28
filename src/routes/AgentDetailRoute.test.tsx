import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayClient } from "../api/client.ts";
import { setSession } from "../auth/session.ts";
import { ChatProvider, useChatContext } from "../ask/chat/ChatContext.tsx";
import type { UseChatResult } from "../ask/chat/useChat.ts";
import type { AgentTestCase } from "./testing/types.ts";
import { AgentDetailRoute } from "./AgentDetailRoute.tsx";
import { ConfigTab } from "./agentDetail/ConfigTab.tsx";
import { LearningTab } from "./agentDetail/LearningTab.tsx";
import { PromptsTab } from "./agentDetail/PromptsTab.tsx";
import { TestsTab } from "./agentDetail/TestsTab.tsx";
import { TestAskProvider } from "../ask/testing.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function testCase(overrides: Partial<AgentTestCase>): AgentTestCase {
  return {
    id: 1,
    agent_id: 5,
    phase: "execute",
    question: "q",
    expected: "e",
    is_active: true,
    last_score: null,
    last_verdict: null,
    last_actual: null,
    last_reasoning: null,
    last_ran_at: null,
    last_prompt_version: null,
    last_tools_used: null,
    last_duration_ms: null,
    last_usage: null,
    trace_id: null,
    created_at: "2026-08-27T00:00:00Z",
    updated_at: "2026-08-27T00:00:00Z",
    ...overrides,
  };
}

function renderAgentDetail(initialPath: string) {
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    return null;
  }

  const result = render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TestAskProvider><ChatProvider>
        <Capture />
        <Routes>
          <Route path="/agents/:agentId" element={<AgentDetailRoute />}>
            <Route index element={<Navigate to="config" replace />} />
            <Route path="run" element={<Navigate to="../config" replace />} />
            <Route path="config" element={<ConfigTab />} />
            <Route path="prompts" element={<PromptsTab />} />
            <Route path="tests" element={<TestsTab />} />
            <Route path="learning" element={<LearningTab />} />
          </Route>
          <Route path="/ask" element={<div>Ask screen</div>} />
        </Routes>
      </ChatProvider></TestAskProvider>
    </MemoryRouter>,
  );
  return { ...result, chatRef };
}

const AGENTS = [
  { id: 5, name: "Analytics", description: "Answers sales questions", is_active: true },
  { id: 6, name: "Inactive Agent", description: null, is_active: false },
];

describe("AgentDetailRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSession(null);
  });

  it("renders the agent's real name, description and status pill from GET /agent/agents", async () => {
    fetchMock.mockResolvedValue(jsonResponse(AGENTS));

    renderAgentDetail("/agents/5/learning");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Analytics/ })).toBeInTheDocument();
    });
    expect(screen.getByText("Answers sales questions")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  // The gap this suite used to lock in ("names the wiring gap honestly")
  // is closed: GET /agent/agents/{id} has returned datasource_id,
  // llm_bindings, code_execution and mcp_server_ids all along — nothing
  // on this page ever read it. This proves the real thing renders in its
  // place: a datasource NAME (never the bare id agent.datasource_id=6
  // would be) and an MCP server's name plus its discovered tool COUNT
  // (never just an id), from a mocked GET /agent/agents/{id} plus the
  // three list endpoints that resolve its ids.
  it("Configuration tab resolves the agent's datasource and mcp server ids to real names", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path) => {
      if (path === "/agent/agents") return AGENTS as never;
      if (path === "/agent/agents/5") {
        return {
          id: 5,
          name: "Analytics",
          description: "Answers sales questions",
          pipeline_config: {},
          datasource_id: 6,
          llm_bindings: { execute: 9 },
          code_execution: "interpreter",
          is_active: true,
          compiled_programs: {},
          mcp_server_ids: [3],
        } as never;
      }
      if (path === "/agent/datasources") {
        return [{ id: 6, name: "Reporting warehouse" }] as never;
      }
      if (path === "/agent/llm-configs") {
        return [{ id: 9, name: "House GPT", model: "openai/gpt-5" }] as never;
      }
      if (path === "/agent/mcp-servers") {
        return [
          {
            id: 3,
            name: "Order lookup",
            base_url: "https://x",
            auth_type: "none",
            discovered_tools: [{ name: "get_order" }, { name: "list_orders" }],
            last_discovery_at: null,
            is_active: true,
          },
        ] as never;
      }
      throw new Error(`unexpected path ${path}`);
    });

    renderAgentDetail("/agents/5/config");

    // The datasource name, not "datasource_id: 6" — and it is the selected
    // option of a control that can change it, not read-only text.
    await waitFor(() => {
      expect(screen.getByText("Reporting warehouse")).toBeInTheDocument();
    });
    expect((screen.getByLabelText("Datasource") as HTMLSelectElement).value).toBe("6");
    expect(screen.queryByText(/datasource_id/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bid 6\b/)).not.toBeInTheDocument();

    // The mcp server's name and its discovered tool count (2), not a bare id.
    expect(screen.getByText("Order lookup")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText(/\bid 3\b/)).not.toBeInTheDocument();

    // The model binding, resolved off /agent/llm-configs. Asserted on the
    // execute phase's own control rather than by text: every phase now
    // offers the same option list, so the name appears five times.
    const execute = screen.getByLabelText("Model for the execute phase") as HTMLSelectElement;
    expect(execute.value).toBe("9");
    expect(execute.selectedOptions[0].textContent).toMatch(/House GPT/);
    // A phase with no binding sits on the tenant default, not on a model.
    expect((screen.getByLabelText("Model for the plan phase") as HTMLSelectElement).value).toBe("");
  });

  it("reports a clean not-found for an id absent from this tenant's agent list", async () => {
    fetchMock.mockResolvedValue(jsonResponse(AGENTS));

    renderAgentDetail("/agents/999/config");

    await waitFor(() => {
      expect(screen.getByText(/No agent with id 999/)).toBeInTheDocument();
    });
  });

  it("switches tab content via the URL, and only the active tab is shown", async () => {
    // A fresh Response per call, not one shared object: a Response body
    // can only be consumed once, and this test reads /agent/tests from
    // two tabs in turn.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(AGENTS)));

    renderAgentDetail("/agents/5/learning");

    await waitFor(() => {
      expect(screen.getByText("Compile a plan program")).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "New test case" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Test suites" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New test case" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Compile a plan program")).not.toBeInTheDocument();
  });

  // Correctness bar for the move (task brief): a test that would pass for
  // any agent proves nothing. Both fixture cases share a phase; only the
  // one whose agent_id matches the route's :agentId (5, Analytics) may
  // ever reach the DOM — agent 6's case proves the tab filters rather
  // than rendering the whole tenant's cases the way the standalone screen
  // Prompts & tuning replaced used to.
  it("Prompts & tuning tab renders real content scoped to this agent, with no picker", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path) => {
      if (path === "/agent/agents") return AGENTS as never;
      if (path === "/agent/tests") {
        return [
          testCase({ id: 1, agent_id: 5, question: "Analytics' own case" }),
          testCase({ id: 2, agent_id: 6, question: "Inactive Agent's own case" }),
        ] as never;
      }
      throw new Error(`unexpected path ${path}`);
    });

    renderAgentDetail("/agents/5/prompts");

    // 1 case for Analytics (5), not 2 — the count a broken filter (or no
    // filter at all) would show.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^execute/ })).toHaveTextContent("1 case");
    });
    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();
  });

  it("Test suites tab renders real content scoped to this agent, with no picker", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path) => {
      if (path === "/agent/agents") return AGENTS as never;
      if (path === "/agent/tests") {
        return [
          testCase({ id: 1, agent_id: 5, question: "Analytics' own case" }),
          testCase({ id: 2, agent_id: 6, question: "Inactive Agent's own case" }),
        ] as never;
      }
      throw new Error(`unexpected path ${path}`);
    });

    renderAgentDetail("/agents/5/tests");

    await waitFor(() => {
      expect(screen.getByText("Analytics' own case")).toBeInTheDocument();
    });
    expect(screen.queryByText("Inactive Agent's own case")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();
  });

  // The Run tab's replacement, and the whole reason removing it is not a
  // loss of function: Ask must arrive at /ask *pointed at this agent*.
  // Asserting only the navigation would pass for a plain link to /ask,
  // which is exactly the regression this guards — `selectedAgent` is what
  // Composer sends as `RunIn.agent`, so a navigation that leaves it unset
  // runs against whichever agent the picker defaulted to.
  it("the header's Ask action points /ask at this agent before navigating there", async () => {
    fetchMock.mockResolvedValue(jsonResponse(AGENTS));

    const { chatRef } = renderAgentDetail("/agents/5/config");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ask Analytics" })).toBeInTheDocument();
    });
    expect(chatRef.current!.selectedAgent).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ask Analytics" }));

    await waitFor(() => expect(screen.getByText("Ask screen")).toBeInTheDocument());
    expect(chatRef.current!.selectedAgent).toBe("Analytics");
  });

  // Two agents, so a header action hard-coded to the first would pass the
  // test above and fail here.
  it("names the agent in the route, not the first in the list", async () => {
    fetchMock.mockResolvedValue(jsonResponse(AGENTS));

    const { chatRef } = renderAgentDetail("/agents/6/config");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ask Inactive Agent" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Ask Inactive Agent" }));

    await waitFor(() => expect(chatRef.current!.selectedAgent).toBe("Inactive Agent"));
  });

  it("has no Run tab, and the bookmarked /run URL lands on Configuration", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path) => {
      if (path === "/agent/agents") return AGENTS as never;
      if (path === "/agent/agents/5") {
        return {
          id: 5,
          name: "Analytics",
          description: "Answers sales questions",
          pipeline_config: {},
          datasource_id: null,
          llm_bindings: {},
          code_execution: "none",
          is_active: true,
          compiled_programs: {},
          mcp_server_ids: [],
        } as never;
      }
      if (path === "/agent/datasources") return [] as never;
      if (path === "/agent/llm-configs") return [] as never;
      if (path === "/agent/mcp-servers") return [] as never;
      throw new Error(`unexpected path ${path}`);
    });

    renderAgentDetail("/agents/5/run");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Analytics/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "Run" })).not.toBeInTheDocument();
    // Configuration's own content, so this proves the redirect resolved
    // rather than merely that the Run tab's markup is gone.
    await waitFor(() => {
      expect(screen.getByLabelText("Datasource")).toBeInTheDocument();
    });
  });
});
