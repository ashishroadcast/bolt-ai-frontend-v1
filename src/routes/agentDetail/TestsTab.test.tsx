import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayClient } from "../../api/client.ts";
import { setSession } from "../../auth/session.ts";
import type { AgentDetailContext } from "../AgentDetailRoute.tsx";
import type { AgentTestCase } from "../testing/types.ts";
import { TestsTab } from "./TestsTab.tsx";

function testCase(overrides: Partial<AgentTestCase>): AgentTestCase {
  return {
    id: 1,
    agent_id: 42,
    phase: "execute",
    question: "top items last week",
    expected: "Chicken Biryani leads",
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

/** Stands in for `AgentDetailRoute` — see PromptsTab.test.tsx's own
 * comment for why: this supplies the same outlet context a real render
 * would, so `TestsTab` reads its agent from the route rather than a
 * picker. */
function DetailContextStub() {
  const agent: AgentDetailContext["agent"] = { id: 42, name: "Analytics", description: "d", is_active: true };
  return <Outlet context={{ agent } satisfies AgentDetailContext} />;
}

function renderTestsTab() {
  return render(
    <MemoryRouter initialEntries={["/x"]}>
      <Routes>
        <Route path="/x" element={<DetailContextStub />}>
          <Route index element={<TestsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("TestsTab", () => {
  beforeEach(() => {
    setSession({ token: "tok", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Correctness bar for the move: GET /agent/tests returns every case for
  // the tenant, agent filter and all (testing/api.ts's own comment). The
  // old /test-suites screen had no agent filter of its own — it mixed
  // every agent's cases into the same phase lists. Scoped to one agent's
  // own page, showing another agent's case here would be a bug, so this
  // proves the tab filters rather than just inheriting that old behaviour.
  it("lists every phase, scoped to this agent's own cases only", async () => {
    const cases = [
      testCase({ id: 1, agent_id: 42, phase: "execute", question: "top items last week" }),
      testCase({ id: 2, agent_id: 99, phase: "execute", question: "discount spike at Bandra" }),
    ];
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path) => {
      if (path === "/agent/tests") return cases as never;
      throw new Error(`unexpected path ${path}`);
    });

    renderTestsTab();

    await waitFor(() => {
      expect(screen.getByText("top items last week")).toBeInTheDocument();
    });
    // Agent 99's case must never render on agent 42's tab.
    expect(screen.queryByText("discount spike at Bandra")).not.toBeInTheDocument();

    const executeSection = screen.getAllByRole("heading", { name: "execute" })[0]!.closest("section")!;
    expect(within(executeSection).getByText(/1 active/)).toBeInTheDocument();
    expect(within(executeSection).getByText(/below 5/)).toBeInTheDocument();

    const guardrailSection = screen.getAllByRole("heading", { name: "guardrail" })[0]!.closest("section")!;
    expect(within(guardrailSection).getByText("No cases yet for this phase.")).toBeInTheDocument();
  });

  it("runs a case and replaces it with the graded snapshot", async () => {
    const before = testCase({ id: 1, agent_id: 42, last_verdict: null });
    const after = testCase({
      id: 1,
      agent_id: 42,
      last_verdict: "pass",
      last_score: 0.95,
      last_reasoning: "[judged by x] solid.",
    });

    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path, init) => {
      if (path === "/agent/tests") return [before] as never;
      if (path === "/agent/tests/1/run" && init?.method === "POST") return after as never;
      throw new Error(`unexpected call ${path}`);
    });

    renderTestsTab();
    await waitFor(() => expect(screen.getByText("top items last week")).toBeInTheDocument());

    await act(async () => {
      screen.getByRole("button", { name: "Run" }).click();
    });

    await waitFor(() => {
      expect(screen.getByText("PASS")).toBeInTheDocument();
      expect(screen.getByText(/solid\./)).toBeInTheDocument();
    });
  });

  it("deletes a case on confirmation and removes it from the list", async () => {
    const only = testCase({ id: 9, agent_id: 42 });
    const agentFetch = vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path, init) => {
      if (path === "/agent/tests" && (init === undefined || init.method === undefined)) return [only] as never;
      if (path === "/agent/tests/9" && init?.method === "DELETE") return undefined as never;
      throw new Error(`unexpected call ${path}`);
    });

    renderTestsTab();
    await waitFor(() => expect(screen.getByText("top items last week")).toBeInTheDocument());

    await act(async () => {
      screen.getByRole("button", { name: "Delete" }).click();
    });

    await waitFor(() => {
      expect(screen.queryByText("top items last week")).not.toBeInTheDocument();
    });
    expect(agentFetch).toHaveBeenCalledWith("/agent/tests/9", expect.objectContaining({ method: "DELETE" }));
  });

  it("creates a case scoped to the route's agent, with no agent field to pick one", async () => {
    const agentFetch = vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path, init) => {
      if (path === "/agent/tests" && (init === undefined || init.method === undefined)) return [] as never;
      if (path === "/agent/tests" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        return testCase({ id: 5, agent_id: body.agent_id as number, question: "q", expected: "e" }) as never;
      }
      throw new Error(`unexpected call ${path}`);
    });

    renderTestsTab();
    await waitFor(() => expect(screen.getByLabelText("Question")).toBeInTheDocument());
    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "q" } });
    fireEvent.change(screen.getByLabelText("Expected"), { target: { value: "e" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add case" }));
    });

    expect(agentFetch).toHaveBeenCalledWith(
      "/agent/tests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ agent_id: 42, phase: "execute", question: "q", expected: "e", is_active: true }),
      }),
    );
  });
});
