import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayClient } from "../../api/client.ts";
import { AgentApiError } from "../../ask/http/gatewayClient.ts";
import type { AgentDetail } from "../../agents/types.ts";
import { setSession } from "../../auth/session.ts";
import type { LLMConfig } from "../llmConfigsApi.ts";
import type { AgentTestCase, PromptSnapshot } from "../testing/types.ts";
import type { AgentDetailContext } from "../AgentDetailRoute.tsx";
import { __resetPersistentStateForTests } from "./usePersistentState.ts";
import { LearningTab } from "./LearningTab.tsx";

function agentDetail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: 42,
    name: "Analytics",
    description: "d",
    pipeline_config: {},
    datasource_id: null,
    secondary_datasource_id: null,
    llm_bindings: {},
    code_execution: "none",
    is_active: true,
    compiled_programs: {},
    mcp_server_ids: [],
    ...overrides,
  };
}

function llmConfig(overrides: Partial<LLMConfig>): LLMConfig {
  return {
    id: 1,
    name: "GPT-5 mini",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    base_url: null,
    params: {},
    kind: "chat",
    is_default: true,
    is_active: true,
    has_api_key: true,
    ...overrides,
  };
}

// Distinct plan/judge models — the common case every test that doesn't
// care about the distinctness check itself should start from, so Compile
// plan is enabled by default rather than every other test having to work
// around a refusal that isn't what it's testing.
function distinctConfigs(): LLMConfig[] {
  return [
    llmConfig({ id: 1, name: "GPT-5 mini", model: "openai/gpt-5-mini", is_default: true }),
    llmConfig({ id: 2, name: "GPT-5", model: "openai/gpt-5", is_default: false }),
  ];
}

function testCase(overrides: Partial<AgentTestCase>): AgentTestCase {
  return {
    id: 1,
    agent_id: 42,
    phase: "plan",
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

function promptSnapshot(overrides: Partial<PromptSnapshot> = {}): PromptSnapshot {
  return {
    phase: "plan",
    instructions: "Plan the work.",
    version: null,
    alias: null,
    is_fallback: true,
    ...overrides,
  };
}

interface Fixtures {
  detail?: AgentDetail;
  llmConfigs?: LLMConfig[];
  cases?: AgentTestCase[];
  prompts?: PromptSnapshot[];
}

/**
 * Routes every `gatewayClient.agentFetch` call this tab can make to a
 * fixture, the same per-test-router style `PromptsTab.test.tsx` already
 * uses rather than a single blanket `fetch` mock — this tab now makes five
 * distinct calls (agent detail, llm-configs, tests, prompts, plus whichever
 * of optimize/tune/promote a test exercises), and a blanket mock would hand
 * the wrong shape to whichever of those a test isn't thinking about.
 *
 * `override` runs first and may throw (simulating a 4xx) or return a
 * value for a path this fixture set doesn't cover on its own (optimize/
 * tune/promote); returning `undefined` falls through to the GET fixtures
 * below.
 */
function router(fixtures: Fixtures, override?: (path: string, init?: RequestInit) => unknown) {
  // `judge: 2` explicitly, so the default fixture set resolves plan (the
  // tenant default, id 1) and judge (id 2) to two different models — the
  // sensible default for every test that isn't specifically exercising the
  // distinctness gate itself (see the dedicated "disables Compile plan..."
  // test below for the case where it isn't set).
  const detail = fixtures.detail ?? agentDetail({ llm_bindings: { judge: 2 } });
  const llmConfigs = fixtures.llmConfigs ?? distinctConfigs();
  const cases = fixtures.cases ?? [];
  const prompts = fixtures.prompts ?? [];

  return async (path: string, init?: RequestInit): Promise<unknown> => {
    if (override !== undefined) {
      const result = await override(path, init);
      if (result !== undefined) return result;
    }
    if (path === "/agent/agents/42") return detail;
    if (path === "/agent/llm-configs") return llmConfigs;
    if (path === "/agent/tests") return cases;
    if (path === "/agent/admin/prompts/42") return prompts;
    throw new Error(`unexpected call: ${init?.method ?? "GET"} ${path}`);
  };
}

function DetailContextStub() {
  const agent: AgentDetailContext["agent"] = { id: 42, name: "Analytics", description: "d", is_active: true };
  return <Outlet context={{ agent } satisfies AgentDetailContext} />;
}

function renderLearningTab() {
  return render(
    <MemoryRouter initialEntries={["/x"]}>
      <Routes>
        <Route path="/x" element={<DetailContextStub />}>
          <Route index element={<LearningTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("LearningTab", () => {
  beforeEach(() => {
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetPersistentStateForTests();
  });

  // ── Compile card: state before action ─────────────────────────────────

  it("leads the compile card with the resolved plan/judge models and whether a program is already compiled", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({
        detail: agentDetail({ llm_bindings: { plan: 1, judge: 2 }, compiled_programs: { plan: "runs:/9/best.json" } }),
      }),
    );

    renderLearningTab();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Compile a plan program" })).toBeInTheDocument());
    const compileCard = screen.getByRole("heading", { name: "Compile a plan program" }).closest("section") as HTMLElement;
    expect(within(compileCard).getByText("GPT-5 mini")).toBeInTheDocument();
    expect(within(compileCard).getByText("GPT-5")).toBeInTheDocument();
    expect(within(compileCard).getByText(/compiled · best\.json/)).toBeInTheDocument();
  });

  it("disables Compile plan and states why when judge and plan resolve to the same model", async () => {
    const agentFetch = vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({
        detail: agentDetail({ llm_bindings: { judge: 1 } }), // plan falls back to the same default (id 1)
        llmConfigs: [llmConfig({ id: 1, model: "openai/gpt-5-mini", is_default: true })],
      }),
    );

    renderLearningTab();

    await waitFor(() => expect(screen.getByRole("button", { name: "Compile plan" })).toBeDisabled());
    expect(screen.getByText(/openai\/gpt-5-mini/)).toBeInTheDocument();

    agentFetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Compile plan" }));
    expect(agentFetch).not.toHaveBeenCalledWith("/agent/admin/optimize", expect.anything());
  });

  it("optimize sends only {agent_id} — no tenant or user id from the client", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({}, (path, init) => {
        if (path === "/agent/admin/optimize" && init?.method === "POST") {
          expect(init.body).toEqual(JSON.stringify({ agent_id: 42 }));
          return { run_id: "run-1", artifact_uri: "runs:/1/best.json", demo_count: 12 };
        }
        return undefined;
      }),
    );

    renderLearningTab();
    await waitFor(() => expect(screen.getByRole("button", { name: "Compile plan" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Compile plan" }));

    await waitFor(() => expect(screen.getByText("run-1")).toBeInTheDocument());
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("optimize surfaces the server's own configuration-defect reason on a 422", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({}, (path, init) => {
        if (path === "/agent/admin/optimize" && init?.method === "POST") {
          throw new AgentApiError(
            "no promoted exemplars to bootstrap from",
            422,
            { detail: "no promoted exemplars to bootstrap from" },
          );
        }
        return undefined;
      }),
    );

    renderLearningTab();
    await waitFor(() => expect(screen.getByRole("button", { name: "Compile plan" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Compile plan" }));

    await waitFor(() => {
      expect(screen.getByText("no promoted exemplars to bootstrap from")).toBeInTheDocument();
    });
  });

  it("a compile outcome survives switching to another tab and back", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({}, (path, init) => {
        if (path === "/agent/admin/optimize" && init?.method === "POST") {
          return { run_id: "run-7", artifact_uri: "runs:/7/best.json", demo_count: 4 };
        }
        return undefined;
      }),
    );

    const { unmount } = renderLearningTab();
    await waitFor(() => expect(screen.getByRole("button", { name: "Compile plan" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Compile plan" }));
    await waitFor(() => expect(screen.getByText("run-7")).toBeInTheDocument());

    // <Outlet/> unmounts this tab's tree on every tab switch — this is
    // what that looks like from the component's own point of view.
    unmount();
    renderLearningTab();

    expect(await screen.findByText("run-7")).toBeInTheDocument();
  });

  // ── Tune card: real serving state per phase ────────────────────────────

  it("shows the live serving version for the selected tune phase, and the fallback wording when nothing is registered", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({
        prompts: [
          promptSnapshot({ phase: "plan", version: 3, alias: "production", is_fallback: false }),
          promptSnapshot({ phase: "execute", is_fallback: true, version: null, alias: null }),
        ],
      }),
    );

    renderLearningTab();
    await screen.findByRole("heading", { name: "Register a tuned prompt" });
    const tuneCard = screen.getByRole("heading", { name: "Register a tuned prompt" }).closest("section") as HTMLElement;
    await waitFor(() => expect(within(tuneCard).getByText(/v3 · production/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Phase", { selector: "#tune-phase" }), { target: { value: "execute" } });
    await waitFor(() => {
      expect(screen.getByText(/not yet promoted — running the signature default/)).toBeInTheDocument();
    });
  });

  it("tune sends {agent_id, phase} for the selected phase", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({}, (path, init) => {
        if (path === "/agent/admin/tune" && init?.method === "POST") {
          expect(init.body).toEqual(JSON.stringify({ agent_id: 42, phase: "execute" }));
          return { prompt_uri: "prompts:/Analytics-execute/3", version: 3, instructions: "..." };
        }
        return undefined;
      }),
    );

    renderLearningTab();
    fireEvent.change(await screen.findByLabelText("Phase", { selector: "#tune-phase" }), {
      target: { value: "execute" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register tuned version" }));

    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
  });

  it("a tune outcome survives switching tabs and back, per phase", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({}, (path, init) => {
        if (path === "/agent/admin/tune" && init?.method === "POST") {
          return { prompt_uri: "prompts:/Analytics-plan/5", version: 5, instructions: "..." };
        }
        return undefined;
      }),
    );

    const { unmount } = renderLearningTab();
    fireEvent.click(await screen.findByRole("button", { name: "Register tuned version" }));
    await waitFor(() => expect(screen.getByText("prompts:/Analytics-plan/5")).toBeInTheDocument());

    unmount();
    renderLearningTab();

    expect(await screen.findByText("prompts:/Analytics-plan/5")).toBeInTheDocument();
  });

  // ── Promote card: confirmation gate, disabled state, and refusal ───────

  it("disables Promote to production and states why when the version field is empty", async () => {
    renderLearningTab();
    const versionField = await screen.findByLabelText("Version");
    fireEvent.change(versionField, { target: { value: "" } });

    expect(screen.getByRole("button", { name: "Promote to production" })).toBeDisabled();
    expect(screen.getByText(/Enter a version number/)).toBeInTheDocument();
  });

  it("shows the real active test-case count for the selected promote phase, not a placeholder", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({
        cases: [
          testCase({ id: 1, phase: "plan", is_active: true }),
          testCase({ id: 2, phase: "plan", is_active: true }),
          testCase({ id: 3, phase: "plan", is_active: false }), // inactive — must not inflate the count
          testCase({ id: 4, phase: "execute", is_active: true }),
        ],
      }),
    );

    renderLearningTab();
    const promoteCard = (await screen.findByRole("heading", { name: "Promote to production" })).closest(
      "section",
    ) as HTMLElement;

    await waitFor(() => expect(within(promoteCard).getByText(/2 active/)).toBeInTheDocument());
    expect(within(promoteCard).queryByText(/4 active/)).not.toBeInTheDocument();
  });

  it("sends nothing until the promotion is confirmed", async () => {
    const agentFetch = vi.spyOn(gatewayClient, "agentFetch").mockImplementation(router({}));
    renderLearningTab();
    await screen.findByRole("button", { name: "Promote to production" });

    agentFetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Promote to production" }));

    expect(agentFetch).not.toHaveBeenCalledWith("/agent/admin/promote", expect.anything());
    expect(screen.getByRole("button", { name: "Confirm promote" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(agentFetch).not.toHaveBeenCalledWith("/agent/admin/promote", expect.anything());
    expect(screen.getByRole("button", { name: "Promote to production" })).toBeDefined();
  });

  it("a successful promotion sends agent_id, phase, version and override — never a tenant/user id", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({}, (path, init) => {
        if (path === "/agent/admin/promote" && init?.method === "POST") {
          expect(init.body).toEqual(JSON.stringify({ agent_id: 42, phase: "plan", version: 3, override: false }));
          return {
            allowed: true,
            overridden: false,
            reason: "candidate passed every case",
            from_version: 2,
            to_version: 3,
            regressed_case_ids: [],
            improved_case_ids: [],
          };
        }
        return undefined;
      }),
    );

    renderLearningTab();
    fireEvent.change(await screen.findByLabelText("Version"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Promote to production" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm promote" }));

    await waitFor(() => expect(screen.getByText("Promoted")).toBeInTheDocument());
  });

  // classifyGateReason ("../testing/refusal.ts") needs the real
  // gate.py-shaped substring ("case(s) regressed") to land on "This
  // candidate is worse" rather than the generic fallback — a made-up
  // prose reason (what this test used before this tab adopted the shared
  // RefusalPanel) would misclassify.
  it("a refused promotion shows the gate's own diagnosis and which cases regressed, not a generic failure", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({}, (path, init) => {
        if (path === "/agent/admin/promote" && init?.method === "POST") {
          throw new AgentApiError("refused", 422, {
            detail: {
              reason: "1 case(s) regressed: 7",
              regressed_cases: [
                {
                  test_case_id: 7,
                  question: "top items last week",
                  baseline_verdict: "pass",
                  candidate_verdict: "fail",
                  candidate_error: null,
                },
              ],
            },
          });
        }
        return undefined;
      }),
    );

    renderLearningTab();
    fireEvent.click(await screen.findByRole("button", { name: "Promote to production" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm promote" }));

    expect(await screen.findByText("This candidate is worse")).toBeInTheDocument();
    expect(screen.getByText("1 case(s) regressed: 7")).toBeInTheDocument();
    expect(screen.getByText("top items last week")).toBeInTheDocument();
  });

  it("a promotion refusal survives switching tabs and back — the most useful thing this screen can show does not vanish", async () => {
    vi.spyOn(gatewayClient, "agentFetch").mockImplementation(
      router({}, (path, init) => {
        if (path === "/agent/admin/promote" && init?.method === "POST") {
          throw new AgentApiError("refused", 422, {
            detail: { reason: "1 case(s) regressed: 7", regressed_cases: [] },
          });
        }
        return undefined;
      }),
    );

    const { unmount } = renderLearningTab();
    fireEvent.click(await screen.findByRole("button", { name: "Promote to production" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm promote" }));
    await screen.findByText("This candidate is worse");

    unmount();
    renderLearningTab();

    expect(await screen.findByText("This candidate is worse")).toBeInTheDocument();
    expect(screen.getByText("1 case(s) regressed: 7")).toBeInTheDocument();
  });

  it("reads as a numbered sequence — compile, tune and promote are three steps of one workflow, not three peers", async () => {
    renderLearningTab();
    await screen.findByRole("heading", { name: "Compile a plan program" });

    const steps = screen.getAllByText(/^Step \d of 3$/);
    expect(steps.map((el) => el.textContent)).toEqual(["Step 1 of 3", "Step 2 of 3", "Step 3 of 3"]);
  });
});
